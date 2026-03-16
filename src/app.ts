import { config } from './config.js';
import { initDb } from './db/sqlite.js';
import { runMigrations } from './db/migrations.js';

async function main() {
  console.log('[app] Starting EVE Agent...');

  // 1. Initialize database
  const db = initDb(config.db.path);
  runMigrations(db);
  console.log('[app] Database ready');

  const { createServer } = await import('./web/server.js');
  const { createBot } = await import('./telegram/bot.js');

  // 2. Start Fastify server (EVE SSO callback + health)
  const server = await createServer(db);
  await server.listen({ port: config.server.port, host: config.server.host });
  console.log(`[app] HTTP server listening on ${config.server.host}:${config.server.port}`);

  // 3. Start Telegram bot (long polling)
  const bot = createBot(db);
  console.log('[app] Starting Telegram bot...');
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    console.warn('[app] Telegram deleteWebhook failed:', err);
  }
  bot.start({
    onStart: () => console.log('[app] Telegram bot started (long polling)'),
  }).catch((err) => {
    console.error('[app] Bot start failed:', err);
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
