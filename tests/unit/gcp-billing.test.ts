import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  getGcpBillingSnapshot,
  refreshGcpBillingSnapshot,
  resetGcpBillingForTests,
  startGcpBillingRefresher,
  validateGcpBillingConfig,
  type GcpBillingConfig,
} from '../../src/usage/gcp-billing.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SA_KEY_JSON = JSON.stringify({
  client_email: 'billing-reader@my-project.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
});

function billingConfig(overrides: Partial<GcpBillingConfig> = {}): GcpBillingConfig {
  return {
    projectId: 'my-project',
    dataset: 'billing_export',
    table: 'gcp_billing_export_v1',
    serviceAccountKeyPath: '/secrets/billing-reader.json',
    refreshTtlMs: 1_000,
    queryTimeoutMs: 5_000,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchCall = { url: string; init?: RequestInit };

/** Happy-path fake: token exchange + BigQuery query with two service rows. */
function makeFakeFetch(calls: FetchCall[], queryPayload: unknown = {
  rows: [
    { f: [{ v: 'Compute Engine' }, { v: 12.34 }] },
    { f: [{ v: 'Cloud Storage' }, { v: 8 }] },
  ],
}) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'test-access-token' });
    }
    if (typeof queryPayload === 'function') return (queryPayload as () => Response)();
    return jsonResponse(queryPayload);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetGcpBillingForTests();
});

afterEach(() => {
  resetGcpBillingForTests();
  vi.useRealTimers();
});

describe('validateGcpBillingConfig', () => {
  it('accepts all-empty (off) and fully-set configurations', () => {
    expect(validateGcpBillingConfig(billingConfig({
      projectId: '', dataset: '', table: '', serviceAccountKeyPath: '',
    }))).toBeNull();
    expect(validateGcpBillingConfig(billingConfig())).toBeNull();
  });

  it('rejects partial configuration and SQL-unsafe identifiers', () => {
    expect(validateGcpBillingConfig(billingConfig({ table: '' }))).toContain('all set or all empty');
    expect(validateGcpBillingConfig(billingConfig({ dataset: 'a`b' }))).toContain('GCP_BILLING_DATASET');
  });
});

describe('refreshGcpBillingSnapshot', () => {
  it('reports not_configured explicitly and never touches the network', async () => {
    const calls: FetchCall[] = [];
    const fetchFn = makeFakeFetch(calls);
    const snapshot = await refreshGcpBillingSnapshot(
      billingConfig({ projectId: '', dataset: '', table: '', serviceAccountKeyPath: '' }),
      { fetchFn, readFileFn: async () => SA_KEY_JSON },
    );
    expect(snapshot.status).toBe('not_configured');
    expect(snapshot.monthToDateUsd).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reports misconfigured for partial env and never touches the network', async () => {
    const calls: FetchCall[] = [];
    const snapshot = await refreshGcpBillingSnapshot(
      billingConfig({ dataset: '', table: '' }),
      { fetchFn: makeFakeFetch(calls), readFileFn: async () => SA_KEY_JSON },
    );
    expect(snapshot.status).toBe('misconfigured');
    expect(snapshot.error).toContain('all set or all empty');
    expect(calls).toHaveLength(0);
  });

  it('reads month-to-date actuals from the BigQuery export', async () => {
    const calls: FetchCall[] = [];
    const snapshot = await refreshGcpBillingSnapshot(billingConfig(), {
      fetchFn: makeFakeFetch(calls),
      readFileFn: async () => SA_KEY_JSON,
    });

    expect(snapshot.status).toBe('ok');
    expect(snapshot.monthToDateUsd).toBe(20.34);
    expect(snapshot.byService).toEqual([
      { service: 'Compute Engine', costUsd: 12.34 },
      { service: 'Cloud Storage', costUsd: 8 },
    ]);
    expect(snapshot.asOf).not.toBeNull();
    expect(getGcpBillingSnapshot().status).toBe('ok');

    expect(calls).toHaveLength(2);
    const [tokenCall, queryCall] = calls;
    expect(tokenCall.url).toBe('https://oauth2.googleapis.com/token');
    expect(String(tokenCall.init?.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(String(tokenCall.init?.body)).toContain('assertion=');

    expect(queryCall.url).toBe('https://bigquery.googleapis.com/bigquery/v2/projects/my-project/queries');
    expect(queryCall.init?.headers).toMatchObject({ authorization: 'Bearer test-access-token' });
    const queryBody = JSON.parse(String(queryCall.init?.body)) as { query: string; useLegacySql: boolean };
    expect(queryBody.useLegacySql).toBe(false);
    expect(queryBody.query).toContain('`my-project.billing_export.gcp_billing_export_v1`');
    expect(queryBody.query).toContain("project.id = 'my-project'");
    expect(queryBody.query).toContain('TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), MONTH)');
  });

  it('degrades to an error state instead of throwing when BigQuery is down', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 142.250.0.1:443');
    }) as unknown as typeof fetch;
    const snapshot = await refreshGcpBillingSnapshot(billingConfig(), {
      fetchFn,
      readFileFn: async () => SA_KEY_JSON,
    });
    expect(snapshot.status).toBe('error');
    expect(snapshot.error).toContain('ECONNREFUSED');
    expect(snapshot.monthToDateUsd).toBeNull(); // no last good data yet
    expect(getGcpBillingSnapshot().status).toBe('error');
  });

  it('keeps serving the last good numbers, marked stale, after a later failure', async () => {
    const calls: FetchCall[] = [];
    const okFetch = makeFakeFetch(calls);
    await refreshGcpBillingSnapshot(billingConfig(), {
      fetchFn: okFetch,
      readFileFn: async () => SA_KEY_JSON,
    });
    const goodAsOf = getGcpBillingSnapshot().asOf;

    const failingFetch = vi.fn(async () => jsonResponse({ error: 'broken' }, 500)) as unknown as typeof fetch;
    const snapshot = await refreshGcpBillingSnapshot(billingConfig(), {
      fetchFn: failingFetch,
      readFileFn: async () => SA_KEY_JSON,
    });
    expect(snapshot.status).toBe('error');
    expect(snapshot.monthToDateUsd).toBe(20.34); // last good, not a blank page
    expect(snapshot.asOf).toBe(goodAsOf);
  });

  it('surfaces a broken service-account key as an error without network calls', async () => {
    const calls: FetchCall[] = [];
    const snapshot = await refreshGcpBillingSnapshot(billingConfig(), {
      fetchFn: makeFakeFetch(calls),
      readFileFn: async () => '{"client_email": "no-key@example.com"}',
    });
    expect(snapshot.status).toBe('error');
    expect(snapshot.error).toContain('private_key');
    expect(calls).toHaveLength(0);
  });

  it('bounds the call by the configured timeout', async () => {
    const hangingFetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation timed out')));
    })) as unknown as typeof fetch;
    const snapshot = await refreshGcpBillingSnapshot(billingConfig({ queryTimeoutMs: 50 }), {
      fetchFn: hangingFetch,
      readFileFn: async () => SA_KEY_JSON,
    });
    expect(snapshot.status).toBe('error');
    expect(snapshot.error).toContain('timed out');
  });
});

describe('startGcpBillingRefresher', () => {
  it('refreshes on the configured TTL and stops cleanly', async () => {
    const calls: FetchCall[] = [];
    const stop = startGcpBillingRefresher(billingConfig({ refreshTtlMs: 50 }), {
      fetchFn: makeFakeFetch(calls),
      readFileFn: async () => SA_KEY_JSON,
    });

    const tokenCalls = () => calls.filter((call) => call.url.includes('oauth2')).length;
    await vi.waitFor(() => expect(tokenCalls()).toBeGreaterThanOrEqual(3), { timeout: 5_000 });

    stop();
    // A tick may already have been in flight when stop() landed; let it
    // settle, then assert nothing new starts afterwards.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = tokenCalls();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tokenCalls()).toBe(settled);
  });

  it('does not schedule network work when the export is not configured', async () => {
    const calls: FetchCall[] = [];
    startGcpBillingRefresher(
      billingConfig({ projectId: '', dataset: '', table: '', serviceAccountKeyPath: '' }),
      { fetchFn: makeFakeFetch(calls), readFileFn: async () => SA_KEY_JSON },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toHaveLength(0);
    expect(getGcpBillingSnapshot().status).toBe('not_configured');
  });
});
