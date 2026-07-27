import { readFile } from 'node:fs/promises';
import { importPKCS8, SignJWT } from 'jose';
import { config } from '../config.js';

/**
 * Actual GCP spend reader.
 *
 * The Cloud Billing API only serves the SKU price list — not our spend — so
 * this reads the Cloud Billing export in BigQuery instead. The export lags
 * several hours behind reality; every snapshot therefore carries `asOf` and
 * consumers must label it. Refreshes run in the background on a TTL; the HTTP
 * handler only ever reads the cached snapshot synchronously.
 *
 * Not configured (all four GCP_BILLING_* empty) is an explicit state, not an
 * error: the page then shows the configured estimate, labeled as estimate.
 */

export type GcpBillingStatus = 'not_configured' | 'misconfigured' | 'ok' | 'error';

export type GcpBillingServiceCost = { service: string; costUsd: number };

export type GcpBillingSnapshot = {
  status: GcpBillingStatus;
  /** Month-to-date actual cost in USD, summed from the export. */
  monthToDateUsd: number | null;
  byService: GcpBillingServiceCost[];
  /** When this snapshot was fetched (ISO 8601). The data lags hours behind. */
  asOf: string | null;
  error: string | null;
};

export type GcpBillingConfig = {
  projectId: string;
  dataset: string;
  table: string;
  serviceAccountKeyPath: string;
  refreshTtlMs: number;
  queryTimeoutMs: number;
};

export type GcpBillingDeps = {
  fetchFn?: typeof fetch;
  readFileFn?: (path: string) => Promise<string>;
  nowFn?: () => number;
};

const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const BIGQUERY_QUERY_URL = 'https://bigquery.googleapis.com/bigquery/v2/projects';
// Project/dataset/table land inside a backtick-quoted SQL identifier, so keep
// them to GCP's own charset instead of escaping.
const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;

const EMPTY_SNAPSHOT: GcpBillingSnapshot = {
  status: 'not_configured',
  monthToDateUsd: null,
  byService: [],
  asOf: null,
  error: null,
};

let snapshot: GcpBillingSnapshot = { ...EMPTY_SNAPSHOT };
let lastGood: GcpBillingSnapshot | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

export function getGcpBillingSnapshot(): GcpBillingSnapshot {
  return snapshot;
}

export function validateGcpBillingConfig(cfg: GcpBillingConfig): string | null {
  const values = [cfg.projectId, cfg.dataset, cfg.table, cfg.serviceAccountKeyPath];
  if (values.every((value) => value === '')) return null; // legitimately off
  if (values.some((value) => value === '')) {
    return 'GCP_BILLING_PROJECT_ID, GCP_BILLING_DATASET, GCP_BILLING_TABLE and GCP_BILLING_SERVICE_ACCOUNT_KEY_PATH must be either all set or all empty';
  }
  for (const [name, value] of [['GCP_BILLING_PROJECT_ID', cfg.projectId], ['GCP_BILLING_DATASET', cfg.dataset], ['GCP_BILLING_TABLE', cfg.table]] as const) {
    if (!IDENTIFIER_RE.test(value)) return `${name} contains characters outside [A-Za-z0-9_-]`;
  }
  return null;
}

export function isGcpBillingConfigured(cfg: GcpBillingConfig): boolean {
  return cfg.projectId !== '' && validateGcpBillingConfig(cfg) === null;
}

/**
 * One refresh cycle. Never throws: every failure lands in the snapshot as
 * status 'error' (keeping the last good numbers when they exist) so a BigQuery
 * outage degrades the page to stale data or the estimate instead of breaking
 * the transparency endpoint.
 */
export async function refreshGcpBillingSnapshot(
  cfg: GcpBillingConfig = config.gcpBilling,
  deps: GcpBillingDeps = {},
): Promise<GcpBillingSnapshot> {
  const invalid = validateGcpBillingConfig(cfg);
  if (cfg.projectId === '' && invalid === null) {
    snapshot = { ...EMPTY_SNAPSHOT };
    return snapshot;
  }
  if (invalid !== null) {
    snapshot = { ...EMPTY_SNAPSHOT, status: 'misconfigured', error: invalid };
    return snapshot;
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const readFileFn = deps.readFileFn ?? ((path: string) => readFile(path, 'utf8'));
  const nowFn = deps.nowFn ?? Date.now;

  try {
    const keyRaw = await readFileFn(cfg.serviceAccountKeyPath);
    const key = JSON.parse(keyRaw) as {
      client_email?: string;
      private_key?: string;
      token_uri?: string;
    };
    if (!key.client_email || !key.private_key) {
      throw new Error('service account key JSON must contain client_email and private_key');
    }
    const tokenUri = key.token_uri || DEFAULT_TOKEN_URI;
    const timeoutSignal = () => AbortSignal.timeout(cfg.queryTimeoutMs);

    const jwt = await new SignJWT({ scope: BIGQUERY_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(key.client_email)
      .setAudience(tokenUri)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(await importPKCS8(key.private_key, 'RS256'));

    const tokenResponse = await fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
      signal: timeoutSignal(),
    });
    if (!tokenResponse.ok) {
      throw new Error(`OAuth token exchange failed with HTTP ${tokenResponse.status}`);
    }
    const tokenPayload = await tokenResponse.json() as { access_token?: string };
    if (!tokenPayload.access_token) throw new Error('OAuth token exchange returned no access_token');

    // Month-to-date actuals for this project only. TIMESTAMP_TRUNC on the
    // query side keeps the window aligned with the billing month.
    const query = [
      'SELECT service.description AS service, SUM(cost) AS cost_usd',
      `FROM \`${cfg.projectId}.${cfg.dataset}.${cfg.table}\``,
      "WHERE usage_start_time >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), MONTH)",
      `AND project.id = '${cfg.projectId}'`,
      'GROUP BY service',
      'ORDER BY cost_usd DESC',
    ].join(' ');
    const queryResponse = await fetchFn(`${BIGQUERY_QUERY_URL}/${cfg.projectId}/queries`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, useLegacySql: false, timeoutMs: cfg.queryTimeoutMs }),
      signal: timeoutSignal(),
    });
    if (!queryResponse.ok) {
      throw new Error(`BigQuery query failed with HTTP ${queryResponse.status}`);
    }
    const queryPayload = await queryResponse.json() as {
      rows?: Array<{ f: Array<{ v: unknown }> }>;
      errorResult?: { message?: string };
    };
    if (queryPayload.errorResult) {
      throw new Error(`BigQuery query error: ${queryPayload.errorResult.message ?? 'unknown'}`);
    }

    const byService: GcpBillingServiceCost[] = (queryPayload.rows ?? []).map((row) => ({
      service: String(row.f[0]?.v ?? 'unknown'),
      costUsd: roundUsd(Number(row.f[1]?.v ?? 0)),
    }));
    const monthToDateUsd = roundUsd(byService.reduce((sum, entry) => sum + entry.costUsd, 0));
    snapshot = {
      status: 'ok',
      monthToDateUsd,
      byService,
      asOf: new Date(nowFn()).toISOString(),
      error: null,
    };
    lastGood = snapshot;
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep serving the last good numbers, explicitly marked stale — hours-old
    // actuals beat a blank page or a silently swapped-in estimate.
    snapshot = lastGood !== null
      ? { ...lastGood, status: 'error', error: message }
      : { ...EMPTY_SNAPSHOT, status: 'error', error: message };
    return snapshot;
  }
}

function roundUsd(value: number): number {
  // Display precision only; the source of truth stays the export's own sum.
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Background TTL refresher. The first refresh starts immediately; the HTTP
 * layer never waits on it. When the export is not configured (or is invalid)
 * the matching explicit state is published and no network work is scheduled.
 */
export function startGcpBillingRefresher(
  cfg: GcpBillingConfig = config.gcpBilling,
  deps: GcpBillingDeps = {},
): () => void {
  stopGcpBillingRefresher();
  if (!isGcpBillingConfigured(cfg)) {
    void refreshGcpBillingSnapshot(cfg, deps); // publishes not_configured/misconfigured
    return () => {};
  }
  const run = () => {
    inflight ??= refreshGcpBillingSnapshot(cfg, deps)
      .then(() => undefined)
      .catch(() => undefined) // refresh already records errors into the snapshot
      .finally(() => { inflight = null; });
  };
  run();
  refreshTimer = setInterval(run, cfg.refreshTtlMs);
  refreshTimer.unref?.();
  return stopGcpBillingRefresher;
}

export function stopGcpBillingRefresher(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** Test hook: clears the cached snapshot and stops any refresher. */
export function resetGcpBillingForTests(): void {
  stopGcpBillingRefresher();
  snapshot = { ...EMPTY_SNAPSHOT };
  lastGood = null;
  inflight = null;
}
