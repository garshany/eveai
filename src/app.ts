import { createLogger, printStartupBanner, type BannerRow } from './observability/logger.js';
import { validatePublicWebProductionConfig } from './web/production-config.js';

const log = createLogger('app');

async function main() {
  log.info('Starting EVE AI Agent...');

  // 1. Load config with a friendly error for missing env vars instead of a stack trace.
  let config: typeof import('./config.js').config;
  try {
    ({ config } = await import('./config.js'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('%s', message);
    log.error('Скопируй .env.example в .env и заполни обязательные значения (см. README «Quick Start»).');
    process.exit(1);
  }

  if (!config.telegram.botToken && !config.discord.botToken && !config.web.chatEnabled) {
    log.error('Не задан канал общения: Telegram/Discord выключены и WEB_CHAT_ENABLED=false.');
    log.error('Включи хотя бы один bot token или WEB_CHAT_ENABLED=true и перезапусти.');
    process.exit(1);
  }

  if (!config.auth.secretKey.trim()) {
    if (process.env.NODE_ENV === 'production') {
      log.error('AUTH_SECRET_KEY не задан — в продакшене EVE-токены нельзя шифровать встроенным ключом.');
      log.error('Сгенерируй ключ: openssl rand -base64 32 — и добавь в .env.');
      process.exit(1);
    }
    log.warn('AUTH_SECRET_KEY не задан — EVE-токены шифруются встроенным dev-ключом. Для продакшена: openssl rand -base64 32');
  }

  if (Boolean(config.web.turnstileSiteKey) !== Boolean(config.web.turnstileSecretKey)) {
    log.error('TURNSTILE_SITE_KEY и TURNSTILE_SECRET_KEY должны быть заданы вместе.');
    process.exit(1);
  }

  const publicWebErrors = validatePublicWebProductionConfig({
    nodeEnv: process.env.NODE_ENV,
    chatEnabled: config.web.chatEnabled,
    baseUrl: config.web.baseUrl,
    trustedProxyCidrs: config.web.trustedProxyCidrs,
    turnstileSecretKey: config.web.turnstileSecretKey,
    turnstileHostname: config.web.turnstileHostname,
  });
  if (publicWebErrors.length > 0) {
    for (const error of publicWebErrors) log.error('%s', error);
    process.exit(1);
  }

  if (config.esi.userAgent.includes('example')) {
    log.warn('ESI_USER_AGENT содержит placeholder-контакт — укажи реальный контакт оператора (требование CCP для ESI).');
  }

  if (config.telegram.botToken && config.telegram.allowedUserId <= 0) {
    log.warn('Telegram-доступ открыт всем (ALLOWED_TELEGRAM_USER_ID=0) — любой пользователь тратит твой OPENAI_API_KEY.');
  }
  if (config.discord.botToken && !config.discord.allowedUserId.trim()) {
    log.warn('Discord-доступ открыт всем (ALLOWED_DISCORD_USER_ID пуст) — любой пользователь тратит твой OPENAI_API_KEY.');
  }

  const { initDb } = await import('./db/sqlite.js');
  const { runMigrations } = await import('./db/migrations.js');
  const { acquireRuntimeLock } = await import('./runtime/process-lock.js');
  const { getAppVersion } = await import('./update/version.js');
  const {
    markBotDisabled,
    markBotStarting,
    markBotReady,
    markBotFailed,
  } = await import('./web/health.js');
  const { startHeartbeat, stopHeartbeat } = await import('./scheduled/heartbeat-worker.js');
  const { startMarketSnapshotWorker, stopMarketSnapshotWorker } = await import('./eve/market-snapshot.js');
  const { startMarketHistoryWorker, stopMarketHistoryWorker } = await import('./eve/market-history-worker.js');
  const { startMarketAlertsWorker, stopMarketAlertsWorker } = await import('./eve/market-alerts-worker.js');
  const { startEveKillFeedPoller, stopEveKillFeedPoller } = await import('./eve-kill/feed-poll.js');
  const { setRouteMonitorSender } = await import('./eve/route-planner.js');
  const { restoreMonitors, shutdownRouteMonitors } = await import('./eve-board/monitor.js');
  const { cleanExpiredWebSessions } = await import('./web/web-session.js');
  const { isActiveWebSessionLane } = await import('./web/web-session-state.js');
  const { formatForTelegram } = await import('./telegram/formatting.js');
  const {
    registerTelegramOutbound,
    registerDiscordOutbound,
    deliverOutbound,
    isOutboundAvailable,
  } = await import('./messaging/outbound.js');
  const { activeRequestCount } = await import('./chat/shared.js');
  const { drainConversationsThenStopSweep, withDeadline } = await import('./app-shutdown.js');
  const {
    activeWebAgentRequestCount,
    stopWebAgentIngress,
    setWebAgentCloseGraceMs,
  } = await import('./web/agent-requests.js');
  const { stopDiscordIngress } = await import('./discord/bot.js');

  // 2. Enforce the single-process feed/SQLite invariant, then initialize DB.
  const runtimeLock = acquireRuntimeLock(config.db.path, 'bot service');
  const db = initDb(config.db.path);
  runMigrations(db);
  const { startUsageRollupScheduler } = await import('./usage/scheduler.js');
  const { startGcpBillingRefresher } = await import('./usage/gcp-billing.js');
  const stopUsageRollupScheduler = startUsageRollupScheduler(db);
  const stopGcpBilling = startGcpBillingRefresher();
  const { recoverInterruptedPlans } = await import('./agent/planner.js');
  const recoveredPlans = recoverInterruptedPlans(db);
  if (recoveredPlans > 0) {
    log.warn('Recovered %d interrupted agent plan(s) from the previous process.', recoveredPlans);
  }
  if (config.web.chatEnabled) await cleanExpiredWebSessions(db, { force: true });
  log.info('Database ready at %s', config.db.path);

  const sdeSystems = countSdeSystems(db);
  if (sdeSystems === 0) {
    log.warn('SDE data is empty — статические данные EVE недоступны. Запусти: npm run setup');
  }

  // 3. Start Fastify server (EVE SSO callback + health).
  // Mark bot states first so /health never reports a bot healthy before it
  // has actually started.
  if (config.telegram.botToken) {
    markBotStarting('telegram');
  } else {
    markBotDisabled('telegram');
  }
  if (config.discord.botToken) {
    markBotStarting('discord');
  } else {
    markBotDisabled('discord');
  }

  const { createServer } = await import('./web/server.js');
  const server = await createServer(db);
  await server.listen({ port: config.server.port, host: config.server.host });
  log.info('HTTP server listening on %s:%d', config.server.host, config.server.port);

  // 4. Start platform bots
  let telegramBot: import('grammy').Bot | null = null;
  let discordClient: import('discord.js').Client | null = null;

  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down...');
    // The budget starts here, before the first await: every step below shares
    // one deadline, so the whole stop stays inside SHUTDOWN_DRAIN_MS and the
    // supervisor never has to SIGKILL us mid-drain.
    const drainMs = config.shutdown.drainMs;
    const deadline = Date.now() + drainMs;

    // Close every ingress first, and synchronously: a message accepted after the
    // deadline starts gets a turn with no time to finish and is aborted anyway.
    // This must precede any await — stopping the feed poller can itself block on
    // a network call for the whole window. Discord keeps its gateway connected
    // (running replies still need to send) but stops dispatching new messages.
    stopDiscordIngress();
    stopWebAgentIngress();

    // Telegram closes next and comes before every other await, because it is the
    // one ingress that cannot be closed with a flag: dropping an update in
    // middleware still lets grammY confirm its offset, and Telegram would never
    // redeliver it. stop() ends polling without confirming what it did not
    // process — but it waits for the current long poll, so it is bounded.
    await withDeadline(telegramBot?.stop(), deadline);

    // Producers next, so nothing new is queued while turns drain. Stopping the
    // feed poller only cancels its sleep, so bound it like every other step.
    await withDeadline(stopEveKillFeedPoller(), deadline);
    shutdownRouteMonitors();
    stopHeartbeat();
    // Synchronous and instant: both only clear timers.
    stopUsageRollupScheduler();
    stopGcpBilling();
    // History pairs commit independently, so a mid-tick exit only leaves the
    // rest of the due list for the next process.
    await withDeadline(stopMarketHistoryWorker(), deadline);
    // Alerts are one-shot rows committed per firing; stopping mid-tick only
    // delays pushes (delivered_at stays NULL), never loses an event.
    await withDeadline(stopMarketAlertsWorker(), deadline);
    // The snapshot sweep is NOT stopped here: it drains after the turn drain
    // below, on its own small budget — see drainConversationsThenStopSweep.

    // Conversations drain FIRST, the in-flight market sweep stops AFTER, under
    // its own small budget: waiting for the sweep out of the shared budget
    // would cut live turns off without their drain, and an aborted sweep is
    // safe (the swap is atomic, staging is dropped by the next sweep). See
    // src/app-shutdown.ts.
    const drainResult = await drainConversationsThenStopSweep({
      drainMs,
      drainPollMs: config.shutdown.drainPollMs,
      drainDeadlineMs: deadline,
      countInFlightTurns: () => activeRequestCount() + activeWebAgentRequestCount(),
      stopMarketSweep: stopMarketSnapshotWorker,
    });
    if (drainResult.turnsLeftAfterDrain !== null) {
      if (drainResult.turnsLeftAfterDrain > 0) {
        log.warn('Shutdown drain: %d turn(s) still running after %dms — exiting anyway', drainResult.turnsLeftAfterDrain, drainMs);
      } else {
        log.info('Shutdown drain: all turns finished');
      }
    }

    if (discordClient) {
      // destroy() waits for the gateway's close event and can hang on a stalled
      // socket; process.exit below drops whatever the deadline leaves behind.
      await withDeadline(discordClient.destroy(), deadline);
    }
    // server.close() aborts whatever outlived the drain; hold it to what is left
    // of the same budget so the real stop never exceeds SHUTDOWN_DRAIN_MS.
    setWebAgentCloseGraceMs(Math.max(0, deadline - Date.now()));
    // Bounded too: a client watching an SSE stream would otherwise hold close()
    // open past the deadline. process.exit below drops whatever is left.
    await withDeadline(server.close(), deadline);
    db.close();
    runtimeLock.release();
    process.exit(exitCode);
  };

  if (config.telegram.botToken) {
    const { createBot } = await import('./telegram/bot.js');
    telegramBot = createBot(db);

    try {
      // Default false: updates queued while the bot was down (deploy/restart)
      // are redelivered instead of silently lost. The staleness middleware in
      // bot.ts skips anything older than TELEGRAM_MAX_UPDATE_AGE_MINUTES.
      await telegramBot.api.deleteWebhook({ drop_pending_updates: config.telegram.dropPendingUpdates });
    } catch (err) {
      log.warn('Telegram deleteWebhook failed: %s', err instanceof Error ? err.message : String(err));
    }

    const bot = telegramBot;
    const { splitForTelegram } = await import('./agent/finalizer.js');
    registerTelegramOutbound(async (chatId, text) => {
      for (const chunk of splitForTelegram(text)) {
        try {
          const formatted = formatForTelegram(chunk);
          await bot.api.sendMessage(chatId, formatted.text, { parse_mode: formatted.parseMode });
        } catch {
          // EVE mail bodies may contain HTML Telegram rejects — retry as plain text.
          await bot.api.sendMessage(chatId, chunk);
        }
      }
    });

    void bot.start({
      onStart: () => {
        markBotReady('telegram');
        log.info('Telegram bot started (long polling)');
      },
    }).catch((err) => {
      markBotFailed('telegram', err);
      log.error('Telegram bot start failed: %s', err instanceof Error ? err.message : String(err));
      void shutdown(1);
    });
  }

  if (config.discord.botToken) {
    const { createDiscordBot, sendDiscordMessage } = await import('./discord/bot.js');
    discordClient = createDiscordBot(db);

    const client = discordClient;
    registerDiscordOutbound(async (chatId, text) => {
      await sendDiscordMessage(db, client, chatId, text);
    });

    client.login(config.discord.botToken)
      .then(() => {
        markBotReady('discord');
        log.info('Discord bot started (gateway)');
      })
      .catch((err) => {
        markBotFailed('discord', err);
        log.error('Discord bot start failed: %s', err instanceof Error ? err.message : String(err));
        void shutdown(1);
      });
  }

  // 5. Route monitoring is durable for browser lanes as well as push lanes.
  // Browser status is read from the persisted monitor; human-readable push
  // messages remain exclusive to Telegram/Discord.
  const hasOutboundPlatform = Boolean(config.telegram.botToken || config.discord.botToken);
  const feedEnabled = hasOutboundPlatform || config.web.chatEnabled;
  const isWebLane = (chatId: number) => isActiveWebSessionLane(db, chatId);
  const routeMonitorSender = async (chatId: number, text: string) => {
    if (isWebLane(chatId)) return;
    await deliverOutbound(chatId, text);
  };
  const canRestoreRouteMonitor = (chatId: number) => isWebLane(chatId) || isOutboundAvailable(chatId);
  if (feedEnabled) {
    setRouteMonitorSender(routeMonitorSender);
    // The poller establishes a missing cursor first, then synchronously restores
    // route listeners before processing any later event. Existing cursors restore
    // listeners before the first resumed poll. This closes the baseline/head gap.
    startEveKillFeedPoller(db, deliverOutbound, {
      canDeliver: isOutboundAvailable,
      onReady: () => restoreMonitors(db, routeMonitorSender, canRestoreRouteMonitor),
    });
  }
  if (hasOutboundPlatform) startHeartbeat(db);
  // Local whole-market snapshot: useful in every lane (CLI included), so it is
  // not gated on outbound platforms like push notifications.
  startMarketSnapshotWorker(db);
  // Daily price history for watched and top-turnover pairs; same always-on
  // lane policy as the snapshot worker, gated on MARKET_HISTORY_ENABLED.
  startMarketHistoryWorker(db);
  // One-shot price alerts over the local order book; delivery defaults to the
  // user's outbound lane (same resolution as heartbeat), gated on
  // MARKET_ALERTS_ENABLED.
  startMarketAlertsWorker(db);

  const version = getAppVersion();
  const rows: BannerRow[] = [
    { label: 'Database', value: config.db.path, state: 'ok' },
    {
      label: 'SDE data',
      value: sdeSystems > 0 ? `${sdeSystems} systems loaded` : 'missing — run: npm run setup',
      state: sdeSystems > 0 ? 'ok' : 'warn',
    },
    { label: 'HTTP', value: `http://${config.server.host}:${config.server.port} (SSO + /health${config.web.chatEnabled ? ' + /app' : ''})`, state: 'ok' },
    {
      label: 'Web chat',
      value: config.web.chatEnabled ? 'same-origin /app' : 'disabled (WEB_CHAT_ENABLED=false)',
      state: config.web.chatEnabled ? 'ok' : 'off',
    },
    {
      label: 'Telegram',
      value: config.telegram.botToken ? 'long polling' : 'disabled (no TELEGRAM_BOT_TOKEN)',
      state: config.telegram.botToken ? 'ok' : 'off',
    },
    {
      label: 'Discord',
      value: config.discord.botToken ? 'gateway connection' : 'disabled (no DISCORD_BOT_TOKEN)',
      state: config.discord.botToken ? 'ok' : 'off',
    },
    {
      label: 'Model',
      value: `${config.openai.providerName} · ${config.openai.model} · reasoning ${config.openai.reasoningEffort}/${config.openai.reasoningMode} · verbosity ${config.openai.textVerbosity}`,
      state: 'ok',
    },
    { label: 'Heartbeat', value: hasOutboundPlatform ? 'every 5 min' : 'disabled (no push platform)', state: hasOutboundPlatform ? 'ok' : 'off' },
    { label: 'EVE-KILL feed', value: feedEnabled ? 'durable REST poll' : 'disabled', state: feedEnabled ? 'ok' : 'off' },
  ];
  printStartupBanner(`EVE AI Agent v${version}`, rows);

  // Graceful shutdown
  process.on('SIGINT', () => {
    void shutdown(130);
  });
  process.on('SIGTERM', () => {
    void shutdown(143);
  });

  // One bad request must not kill the process; log and keep serving.
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection: %s', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception: %s', err.stack ?? err.message);
    void shutdown(1);
  });
}

function countSdeSystems(db: import('./db/sqlite.js').Db): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM sde_systems').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  log.error('Fatal error: %s', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
