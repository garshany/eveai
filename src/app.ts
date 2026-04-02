import { config } from './config.js';
import { initDb } from './db/sqlite.js';
import { runMigrations } from './db/migrations.js';
import {
  markTelegramBotHealthFailed,
  markTelegramBotHealthReady,
  markTelegramBotHealthStarting,
} from './web/health.js';
import { startHeartbeat, stopHeartbeat } from './scheduled/heartbeat-worker.js';
import { startKillPoller, stopKillPoller } from './eve-kill/poll.js';
import { startZkbWs, stopZkbWs } from './eve-kill/zkb-ws.js';
import { setRouteMonitorSender } from './eve/route-planner.js';
import { restoreMonitors } from './eve-board/monitor.js';

async function main() {
  console.log('[app] Starting EVE Agent...');

  // 1. Initialize database
  const db = initDb(config.db.path);
  runMigrations(db);
  console.log('[app] Database ready');

  const { createServer } = await import('./web/server.js');
  const { createBot } = await import('./telegram/bot.js');

  // 2. Resolve bot username for Telegram Login Widget
  const bot = createBot(db);
  if (!config.telegram.botUsername) {
    try {
      const me = await bot.api.getMe();
      (config.telegram as { botUsername: string }).botUsername = me.username;
      console.log(`[app] Bot username resolved: @${me.username}`);
    } catch (err) {
      console.warn('[app] Failed to resolve bot username:', err);
    }
  }

  // 2b. Set up route monitor sender (must be set before any route is planned)
  setRouteMonitorSender((chatId, text) => {
    bot.api.sendMessage(chatId, text, { parse_mode: undefined }).catch((err) => {
      console.error('[route-monitor] Telegram send failed:', err);
    });
  });
  console.log('[app] Route monitor sender configured');

  // 3. Start Fastify server (EVE SSO callback + health + web dashboard)
  markTelegramBotHealthStarting();
  const server = await createServer(db);
  await server.listen({ port: config.server.port, host: config.server.host });
  console.log(`[app] HTTP server listening on ${config.server.host}:${config.server.port}`);

  // 4. Start Telegram bot (long polling)
  console.log('[app] Starting Telegram bot...');
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    console.warn('[app] Telegram deleteWebhook failed:', err);
  }
  // 5. Start heartbeat scheduler
  startHeartbeat(bot, db);
  console.log('[app] Heartbeat scheduler started');

  // 6. Start EVE-KILL kill tracking
  const sendKillAlert = (chatId: number, text: string) => {
    bot.api.sendMessage(chatId, text, { parse_mode: undefined }).catch((err) => {
      console.error('[kill-watch] Telegram send failed:', err);
    });
  };

  // Kill watch: zKB WebSocket (real-time) + REST polling (fallback, 60s)
  startZkbWs(db, sendKillAlert);
  startKillPoller(db, sendKillAlert);

  // Restore route monitors from DB (survives pm2 restart)
  restoreMonitors(db, sendKillAlert);

  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[app] Shutting down...');
    stopZkbWs();
    stopKillPoller();
    stopHeartbeat();
    bot.stop();
    await server.close();
    db.close();
    process.exit(exitCode);
  };

  void bot.start({
    onStart: () => {
      markTelegramBotHealthReady();
      console.log('[app] Telegram bot started (long polling)');
    },
  }).catch((err) => {
    markTelegramBotHealthFailed(err);
    console.error('[app] Bot start failed:', err);
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
  console.error('[app] Fatal error:', err);
  process.exit(1);
});
