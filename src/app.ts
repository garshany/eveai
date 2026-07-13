import { createLogger, printStartupBanner, type BannerRow } from './observability/logger.js';

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

  if (!config.telegram.botToken && !config.discord.botToken) {
    log.error('Не задан ни TELEGRAM_BOT_TOKEN, ни DISCORD_BOT_TOKEN — боту не с кем разговаривать.');
    log.error('Заполни хотя бы один токен в .env и перезапусти.');
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
  const {
    markBotDisabled,
    markBotStarting,
    markBotReady,
    markBotFailed,
  } = await import('./web/health.js');
  const { startHeartbeat, stopHeartbeat } = await import('./scheduled/heartbeat-worker.js');
  const { startZkbWs, stopZkbWs } = await import('./eve-kill/zkb-ws.js');
  const { setRouteMonitorSender } = await import('./eve/route-planner.js');
  const { restoreMonitors } = await import('./eve-board/monitor.js');
  const { pickTelegramParseMode } = await import('./telegram/formatting.js');
  const {
    registerTelegramOutbound,
    registerDiscordOutbound,
    sendOutbound,
  } = await import('./messaging/outbound.js');

  // 2. Initialize database
  const db = initDb(config.db.path);
  runMigrations(db);
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
    stopZkbWs();
    stopHeartbeat();
    telegramBot?.stop();
    if (discordClient) {
      await discordClient.destroy().catch(() => {});
    }
    await server.close();
    db.close();
    process.exit(exitCode);
  };

  if (config.telegram.botToken) {
    const { createBot } = await import('./telegram/bot.js');
    telegramBot = createBot(db);

    try {
      await telegramBot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      log.warn('Telegram deleteWebhook failed: %s', err instanceof Error ? err.message : String(err));
    }

    const bot = telegramBot;
    const { splitForTelegram } = await import('./agent/finalizer.js');
    registerTelegramOutbound(async (chatId, text) => {
      for (const chunk of splitForTelegram(text)) {
        try {
          await bot.api.sendMessage(chatId, chunk, { parse_mode: pickTelegramParseMode(chunk) });
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

  // 5. Notification producers route through the platform-aware dispatcher.
  setRouteMonitorSender((chatId, text) => {
    sendOutbound(chatId, text);
  });
  startHeartbeat(db);
  startZkbWs(db, (chatId, text) => {
    sendOutbound(chatId, text);
  });
  restoreMonitors(db, (chatId, text) => {
    sendOutbound(chatId, text);
  });

  const version = process.env.npm_package_version ?? '';
  const rows: BannerRow[] = [
    { label: 'Database', value: config.db.path, state: 'ok' },
    {
      label: 'SDE data',
      value: sdeSystems > 0 ? `${sdeSystems} systems loaded` : 'missing — run: npm run setup',
      state: sdeSystems > 0 ? 'ok' : 'warn',
    },
    { label: 'HTTP', value: `http://${config.server.host}:${config.server.port} (SSO callback + /health)`, state: 'ok' },
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
      label: 'OpenAI',
      value: `${config.openai.model} · reasoning ${config.openai.reasoningEffort}/${config.openai.reasoningMode} · verbosity ${config.openai.textVerbosity}`,
      state: 'ok',
    },
    { label: 'Heartbeat', value: 'every 5 min', state: 'ok' },
  ];
  printStartupBanner(version ? `EVE AI Agent v${version}` : 'EVE AI Agent', rows);

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
