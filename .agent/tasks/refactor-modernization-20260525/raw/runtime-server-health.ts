process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'test_bot';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.OPENAI_BASE_URL = '';
process.env.OPENAI_PROXY_HEALTH_URL = '';
process.env.EVE_CLIENT_ID = process.env.EVE_CLIENT_ID || 'test-client';
process.env.EVE_CLIENT_SECRET = process.env.EVE_CLIENT_SECRET || 'test-secret';
process.env.DEFAULT_MARKET_REGION_ID = process.env.DEFAULT_MARKET_REGION_ID || '10000002';
process.env.DEFAULT_MARKET_REGION_NAME = process.env.DEFAULT_MARKET_REGION_NAME || 'The Forge';
process.env.DB_PATH = '/tmp/eveai-refactor-server.sqlite';

const { unlinkSync } = await import('node:fs');
try { unlinkSync('/tmp/eveai-refactor-server.sqlite'); } catch {}

const { initDb } = await import('../../../../src/db/sqlite.js');
const { runMigrations } = await import('../../../../src/db/migrations.js');
const { createServer } = await import('../../../../src/web/server.js');

const db = initDb('/tmp/eveai-refactor-server.sqlite');
runMigrations(db);
const server = await createServer(db);
await server.listen({ host: '127.0.0.1', port: 0 });
const address = server.server.address();
if (!address || typeof address === 'string') throw new Error('No server address');
const url = `http://127.0.0.1:${address.port}/health`;
const response = await fetch(url);
const body = await response.json();
console.log(JSON.stringify({ status: response.ok ? 'PASS' : 'FAIL', url, httpStatus: response.status, body }, null, 2));
await server.close();
db.close();
