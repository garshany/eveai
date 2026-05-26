import { config } from './config.js';
import { initDb } from './db/sqlite.js';
import { runMigrations } from './db/migrations.js';
import {
  markTelegramBotHealthFailed,
  markTelegramBotHealthReady,
  markTelegramBotHealthStarting,
} from './web/health.js';
import { startHeartbeat, stopHeartbeat } from './scheduled/heartbeat-worker.js';
import { startZkbWs, stopZkbWs } from './eve-kill/zkb-ws.js';
import { setRouteMonitorSender } from './eve/route-planner.js';
import { restoreMonitors } from './eve-board/monitor.js';
import { pickTelegramParseMode } from './telegram/formatting.js';
import { createLogger } from './observability/logger.js';

const log = createLogger('app');

async function main() {
  log.info('Starting EVE Agent...');

  // 1. Initialize database
  const db = initDb(config.db.path);
  runMigrations(db);
  log.info('Database ready');

  const { createServer } = await import('./web/server.js');
  const { createBot } = await import('./telegram/bot.js');

  // 2. Resolve bot username for Telegram Login Widget
  const bot = createBot(db);
  if (!config.telegram.botUsername) {
    try {
      const me = await bot.api.getMe();
      (config.telegram as { botUsername: string }).botUsername = me.username;
      log.info('Bot username resolved: @%s', me.username);
    } catch (err) {
      log.warn('Failed to resolve bot username: %s', err instanceof Error ? err.message : String(err));
    }
  }

  // 2b. Set up route monitor sender (must be set before any route is planned)
  setRouteMonitorSender((chatId, text) => {
    bot.api.sendMessage(chatId, text, { parse_mode: pickTelegramParseMode(text) }).catch((err) => {
      log.error('[route-monitor] Telegram send failed: %s', err instanceof Error ? err.message : String(err));
    });
  });
  log.info('Route monitor sender configured');

  // 3. Start Fastify server (EVE SSO callback + health + web dashboard)
  markTelegramBotHealthStarting();
  const server = await createServer(db);
  await server.listen({ port: config.server.port, host: config.server.host });
  log.info('HTTP server listening on %s:%d', config.server.host, config.server.port);

  // 4. Start Telegram bot (long polling)
  log.info('Starting Telegram bot...');
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    log.warn('Telegram deleteWebhook failed: %s', err instanceof Error ? err.message : String(err));
  }
  // 5. Start heartbeat scheduler
  startHeartbeat(bot, db);
  log.info('Heartbeat scheduler started');

  // 6. Start EVE-KILL kill tracking
  const sendKillAlert = (chatId: number, text: string) => {
    bot.api.sendMessage(chatId, text, { parse_mode: pickTelegramParseMode(text) }).catch((err) => {
      log.error('[kill-watch] Telegram send failed: %s', err instanceof Error ? err.message : String(err));
    });
  };

  // Kill watch: zKB WebSocket (real-time)
  startZkbWs(db, sendKillAlert);

  // Restore route monitors from DB (survives process restart)
  restoreMonitors(db, sendKillAlert);

  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down...');
    stopZkbWs();
    stopHeartbeat();
    bot.stop();
    await server.close();
    db.close();
    process.exit(exitCode);
  };

  void bot.start({
    onStart: () => {
      markTelegramBotHealthReady();
      log.info('Telegram bot started (long polling)');
    },
  }).catch((err) => {
    markTelegramBotHealthFailed(err);
    log.error('Bot start failed: %s', err instanceof Error ? err.message : String(err));
    void shutdown(1);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    void shutdown(130);
  });
  process.on('SIGTERM', () => {
    void shutdown(143);
  });
}

main().catch((err) => {
  log.error('Fatal error: %s', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
