import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spend guard: every place that can send a Responses API request must have
 * been reviewed for usage accounting (payer lane, applied model, failed and
 * incomplete responses billed). A new call site fails this test until it is
 * wired to usage_events and added here with its payer.
 *
 * Counts are per file: a second call in an already-reviewed file needs review
 * too. See docs/openai-integration.md "Usage accounting per call site".
 */
const REVIEWED_CALL_SITES: Record<string, { calls: number; payer: string }> = {
  // Transport itself: the one fetch to `${baseUrl}/responses` (log line ignored).
  'src/agent/native-responses.ts': { calls: 1, payer: 'n/a: transport, callers bill' },
  // runModelText -> createNativeResponse; reports usage via onUsage before throwing.
  'src/agent/model.ts': { calls: 1, payer: 'caller onUsage' },
  'src/agent/executor.ts': { calls: 1, payer: 'turn user/chat lane, applied model' },
  'src/agent/read-subagents.ts': { calls: 1, payer: 'turn lane via recordUsage (executor)' },
  'src/agent/compact.ts': { calls: 1, payer: 'thread owner, config model' },
  'src/agent/market-ai-search.ts': { calls: 1, payer: 'web session via route (market-ai-search-routes)' },
  'src/eve-map/advisor-prose.ts': { calls: 1, payer: 'perimeter thread owner via onUsage (map-routes)' },
  // One shared helper (callAdvisorModel) serves generateThreatAdvice and generateRouteIntelSummary.
  'src/eve-board/advisor.ts': { calls: 1, payer: 'route-monitor lane (UsagePayer), userId 0 if unowned' },
  'src/eve-osint/llm.ts': { calls: 1, payer: 'ambient turn payer (runWithUsagePayer in executor)' },
  'src/scheduled/heartbeat-worker.ts': { calls: 1, payer: 'heartbeat owner on delivery lane' },
  // Operator-run `npm run smoke` connectivity ping: runs outside the app with
  // no database or user; deliberately unbilled (one "pong" request).
  'src/smoke.ts': { calls: 1, payer: 'none: operator smoke check, no DB' },
};

const CALL_PATTERNS: RegExp[] = [
  // Direct calls (definitions are stripped below).
  /\b(?:createNativeResponse|runModelText)\s*\(/g,
  // Injected factories (tests pass mocks; production passes createNativeResponse).
  /\bresponseFactory\s*\(/g,
  // Any hand-rolled request to the Responses endpoint.
  /\/responses\b/g,
];

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTs(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function countCallSites(source: string): number {
  const stripped = source
    .replace(/export\s+async\s+function\s+(?:createNativeResponse|runModelText)\s*\(/g, '')
    // Log/format strings that merely mention the endpoint are not requests.
    .replace(/console\.\w+\([^\n]*\/responses[^\n]*/g, '');
  return CALL_PATTERNS.reduce((sum, pattern) => sum + (stripped.match(pattern)?.length ?? 0), 0);
}

describe('model call-site usage guard', () => {
  const root = join(import.meta.dirname, '..', '..');
  const found: Record<string, number> = {};
  for (const file of listTs(join(root, 'src'))) {
    const source = readFileSync(file, 'utf8');
    const count = countCallSites(source);
    const referencesTransport = /\b(?:createNativeResponse|runModelText)\b/.test(source);
    if (count > 0 || referencesTransport) found[relative(root, file).split('\\').join('/')] = count;
  }

  it('detects direct, injected, and hand-rolled requests', () => {
    expect(countCallSites('await createNativeResponse({})')).toBe(1);
    expect(countCallSites('await runModelText(a, b)')).toBe(1);
    expect(countCallSites('await responseFactory({})')).toBe(1);
    expect(countCallSites('await fetch(`${base}/responses`, {})')).toBe(1);
    expect(countCallSites('export async function runModelText(')).toBe(0);
  });

  it('finds no unreviewed model call site', () => {
    const unreviewed = Object.keys(found).filter((file) => !(file in REVIEWED_CALL_SITES));
    expect(unreviewed, 'new model call site: bill it to usage_events, then add it to REVIEWED_CALL_SITES').toEqual([]);
  });

  it('finds exactly the reviewed number of calls per file', () => {
    const counts = Object.fromEntries(Object.keys(REVIEWED_CALL_SITES).map((file) => [file, found[file] ?? 0]));
    const expected = Object.fromEntries(Object.entries(REVIEWED_CALL_SITES).map(([file, site]) => [file, site.calls]));
    expect(counts).toEqual(expected);
  });
});
