import { config } from './config.js';
import { initDb } from './db/sqlite.js';
import { runMigrations } from './db/migrations.js';
import { createBot } from './telegram/bot.js';
import { createServer } from './web/server.js';

async function main() {
  console.log('[app] Starting EVE Agent...');

  // 1. Initialize database
  const db = initDb(config.db.path);
  runMigrations(db);
  console.log('[app] Database ready');

  // 2. Start Fastify server (EVE SSO callback + health)
  const server = await createServer(db);
  await server.listen({ port: config.server.port, host: config.server.host });
  console.log(`[app] HTTP server listening on ${config.server.host}:${config.server.port}`);

  // 3. Start Telegram bot (long polling)
  const bot = createBot(db);
  bot.start({
    onStart: () => console.log('[app] Telegram bot started (long polling)'),
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[app] Shutting down...');
    bot.stop();
    await server.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[app] Fatal error:', err);
  process.exit(1);
});
