import { writeFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.ESI_CATALOG_CACHE_PATH = 'data/cache/esi-swagger.json';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'test_bot';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.EVE_CLIENT_ID = process.env.EVE_CLIENT_ID || 'test-client';
process.env.EVE_CLIENT_SECRET = process.env.EVE_CLIENT_SECRET || 'test-secret';
process.env.DEFAULT_MARKET_REGION_ID = process.env.DEFAULT_MARKET_REGION_ID || '10000002';
process.env.DEFAULT_MARKET_REGION_NAME = process.env.DEFAULT_MARKET_REGION_NAME || 'The Forge';
process.env.DB_PATH = '/tmp/eveai-refactor-runtime.sqlite';
process.env.USER_PROFILE_PATH = '/tmp/eveai-refactor-user-{chat_id}-{character_id}.md';
process.env.EVE_KILL_BASE_URL = 'https://mock.eve-kill.local/api/';
process.env.ZKILL_BASE_URL = 'https://mock.zkill.local/api/';
process.env.EVE_SCOUT_BASE_URL = 'https://mock.eve-scout.local/api/';
process.env.ESI_BASE_URL = 'https://mock.esi.local/latest/';
process.env.TAVILY_API_KEY = '';

type ToolCase = {
  request: string;
  tool: string;
  args: Record<string, unknown>;
};

const calls: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  calls.push(url);

  if (url.includes('/route/')) {
    return jsonResponse([30000142, 30000144]);
  }
  if (url.includes('mock.zkill.local')) {
    return jsonResponse([]);
  }
  if (url.includes('mock.eve-kill.local')) {
    return jsonResponse({ ok: true, data: [] });
  }
  if (url.includes('wiki.eveuniversity.org')) {
    return jsonResponse({ query: { search: [{ title: 'Stargate', snippet: 'Travel between systems.' }] } });
  }
  if (url.includes('mock.esi.local')) {
    return jsonResponse({});
  }

  return jsonResponse({});
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

try { unlinkSync('/tmp/eveai-refactor-runtime.sqlite'); } catch {}

const { initDb } = await import('../../../../src/db/sqlite.js');
const { runMigrations } = await import('../../../../src/db/migrations.js');
const { __test__, createWebSearchState } = await import('../../../../src/agent/executor.js');

const db = initDb('/tmp/eveai-refactor-runtime.sqlite');
runMigrations(db);
seed(db);
writeFileSync('/tmp/eveai-refactor-user-1001-95465499.md', '# Test Pilot\n\n## Wallet\n');

const ctx = { userId: 1, chatId: 1001, telegramUserId: 1001 };
const state = createWebSearchState();
const requestId = 'runtime-parity-request';

const cases: ToolCase[] = [
  {
    request: 'Составь план ответа',
    tool: 'update_plan',
    args: { steps: [{ id: 'a', title: 'Check', status: 'done', depends_on: [], notes: 'runtime parity' }] },
  },
  {
    request: 'Сколько систем в регионе The Forge?',
    tool: 'count_universe_objects',
    args: { target_kind: 'region', target_name: 'The Forge', object_kind: 'systems' },
  },
  {
    request: 'Найди type_id для Rifter',
    tool: 'sde_sql',
    args: { sql: "SELECT type_id, name FROM sde_types WHERE name = 'Rifter'" },
  },
  {
    request: 'Статус мониторинга маршрута',
    tool: 'route_monitor',
    args: { action: 'status' },
  },
  {
    request: 'Запомни заметку по Jita',
    tool: 'intel_note',
    args: { action: 'save', text: 'Runtime parity note', system: 'Jita', region: null, entity_name: null, tag: 'general', query: null, note_id: null },
  },
  {
    request: 'Разбери d-scan',
    tool: 'analyze_scan',
    args: { paste: 'Rifter\tRifter\t120 km\nStargate\tStargate (Caldari)\t12 AU', scan_type: 'dscan', days: null },
  },
  {
    request: 'Сохрани активный фит',
    tool: 'set_active_fit',
    args: { fitting: '[Rifter, Runtime]\nDamage Control II' },
  },
  {
    request: 'Покажи heartbeat config',
    tool: 'heartbeat_config',
    args: { action: 'list', interval_seconds: null, check: null },
  },
  {
    request: 'Какие приватные ESI доступны?',
    tool: 'get_eve_capabilities',
    args: { intent: 'runtime parity capability check' },
  },
  {
    request: 'Что такое stargate?',
    tool: 'web_search',
    args: { query: 'EVE Online stargate mechanics' },
  },
  {
    request: 'Построй маршрут Jita -> Perimeter',
    tool: 'plan_route',
    args: { origin: 'Jita', destination: 'Perimeter', set_autopilot: false, prefer: 'shortest' },
  },
  {
    request: 'OSINT по корпорации',
    tool: 'osint_infer_home',
    args: { scope: 'corporation', id: 123, window_days: 7, include_member_analysis: false, include_graph: true, include_llm_pattern_analysis: false },
  },
];

const results = [];
for (const [index, item] of cases.entries()) {
  const beforeFetch = calls.length;
  const started = Date.now();
  try {
    const result = await __test__.executeToolCall(db, requestId, item.request, ctx, item.tool, item.args, state);
    const text = JSON.stringify(result);
    results.push({
      index: index + 1,
      request: item.request,
      tool: item.tool,
      ok: resultOk(result),
      resultPreview: text.slice(0, 500),
      resultChars: text.length,
      fetchCalls: calls.slice(beforeFetch),
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    results.push({
      index: index + 1,
      request: item.request,
      tool: item.tool,
      ok: false,
      resultPreview: error instanceof Error ? error.stack ?? error.message : String(error),
      resultChars: 0,
      fetchCalls: calls.slice(beforeFetch),
      elapsedMs: Date.now() - started,
    });
  }
}

const artifact = {
  status: results.every((entry) => entry.ok) ? 'PASS' : 'FAIL',
  totalRequests: results.length,
  tools: results.map((entry) => entry.tool),
  results,
};
writeFileSync('.agent/tasks/refactor-modernization-20260525/raw/runtime-tool-parity-result.json', JSON.stringify(artifact, null, 2));
console.log(`runtime parity ${artifact.status}: ${artifact.totalRequests} requests`);

db.close();
globalThis.fetch = originalFetch;

function resultOk(result: unknown): boolean {
  if (!result || typeof result !== 'object') return true;
  const value = (result as { ok?: unknown }).ok;
  return value !== false;
}

function seed(db: import('../../../../src/db/sqlite.js').Db): void {
  db.prepare("INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)").run(1, 'Runtime User', 95465499);
  db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(1001, 'runtime', 95465499);
  db.prepare("INSERT INTO telegram_accounts (telegram_user_id, user_id, username) VALUES (?, ?, ?)").run(1001, 1, 'runtime');
  db.prepare("INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id) VALUES (?, ?, ?, ?, datetime('now', '+1 day'), ?, ?)")
    .run(95465499, 'Runtime Pilot', 'token', 'refresh', JSON.stringify(['esi-location.read_location.v1', 'esi-ui.write_waypoint.v1']), 1);
  db.prepare("INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)").run(1001, 95465499, 1);

  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)").run(10000002, 'The Forge', '{}');
  db.prepare("INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)").run(20000020, 'Kimotoro', 10000002, '{}');
  db.prepare("INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)").run(30000142, 'Jita', 20000020, JSON.stringify({ security: 0.9 }));
  db.prepare("INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)").run(30000144, 'Perimeter', 20000020, JSON.stringify({ security: 1.0 }));
  db.prepare("INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)").run(60003760, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', 30000142, '{}');
  db.prepare("INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)").run(587, 'Rifter', 25, JSON.stringify({ published: true }));
}
