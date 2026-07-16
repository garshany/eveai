process.env.WEB_MAX_CONCURRENT_AGENT_REQUESTS = '8';
process.env.WEB_MAX_QUEUED_AGENT_REQUESTS = '128';
process.env.WEB_MAX_REQUESTS_GLOBAL_WINDOW = '200';
process.env.WEB_MAX_REQUESTS_GLOBAL_DAY = '1000';

const [{ default: Database }, { SCHEMA_SQL }, { WebAgentRequestCoordinator }] = await Promise.all([
  import('better-sqlite3'),
  import('../src/db/schema.js'),
  import('../src/web/agent-requests.js'),
]);

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA_SQL);

let activeWorkers = 0;
let peakWorkers = 0;
const coordinator = new WebAgentRequestCoordinator(db, async (database, threadId, _ctx, text) => {
  activeWorkers += 1;
  peakWorkers = Math.max(peakWorkers, activeWorkers);
  try {
    await new Promise((resolve) => setTimeout(resolve, 8 + Number(text.slice(-2)) % 5));
    const result = `result:${text}`;
    database.prepare(`
      INSERT INTO messages (thread_id, role, content) VALUES (?, 'assistant', ?)
    `).run(threadId, result);
    return result;
  } finally {
    activeWorkers -= 1;
  }
});
coordinator.start();

const acceptedLatencies: number[] = [];
const requestIds: string[] = [];
for (let index = 1; index <= 100; index += 1) {
  const userId = index;
  const chatId = -2_000_000_000 - index;
  const threadId = `load-thread-${index}`;
  db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(userId, `load-${index}`);
  db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, 'web')").run(chatId);
  db.prepare(`
    INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)
  `).run(threadId, chatId, userId);
  const started = performance.now();
  const result = coordinator.enqueue({
    userId,
    chatId,
    threadId,
    characterId: null,
    characterVersion: 0,
    message: `marker-${String(index).padStart(2, '0')}`,
    idempotencyKey: `load_request_${String(index).padStart(4, '0')}`,
    ipKey: `ip1:load-${index}`,
  });
  acceptedLatencies.push(performance.now() - started);
  if (!result.ok) throw new Error(`Load enqueue rejected at user ${index}`);
  requestIds.push(result.request.requestId);
}

const drainStarted = performance.now();
while (true) {
  const active = db.prepare(`
    SELECT COUNT(*) AS count FROM web_agent_requests WHERE status IN ('queued', 'running')
  `).get() as { count: number };
  if (active.count === 0) break;
  if (performance.now() - drainStarted > 10_000) throw new Error('Load drain timed out');
  await new Promise((resolve) => setTimeout(resolve, 5));
}

let isolationChecks = 0;
for (let index = 0; index < requestIds.length; index += 10) {
  const foreignIndex = (index + 1) % requestIds.length;
  const foreign = coordinator.readOwned({
    userId: foreignIndex + 1,
    chatId: -2_000_000_000 - (foreignIndex + 1),
  }, requestIds[index]!);
  if (foreign !== null) throw new Error('Cross-owner request read succeeded');
  isolationChecks += 1;
}

const completed = db.prepare(`
  SELECT COUNT(*) AS count FROM web_agent_requests WHERE status = 'completed'
`).get() as { count: number };
const stuck = db.prepare(`
  SELECT COUNT(*) AS count FROM web_agent_requests WHERE status IN ('queued', 'running')
`).get() as { count: number };
const sorted = [...acceptedLatencies].sort((a, b) => a - b);
const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;

if (completed.count !== 100 || stuck.count !== 0 || peakWorkers > 8 || activeWorkers !== 0) {
  throw new Error('Load invariants failed');
}

console.log(JSON.stringify({
  users: 100,
  completed: completed.count,
  stuck: stuck.count,
  peakWorkers,
  isolationChecks,
  acceptanceMs: {
    p50: Number(percentile(0.50).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    p99: Number(percentile(0.99).toFixed(3)),
  },
  drainMs: Number((performance.now() - drainStarted).toFixed(3)),
}));

await coordinator.close();
db.close();
