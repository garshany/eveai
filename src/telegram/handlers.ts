import { Bot, Context } from 'grammy';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { randomUUID } from 'node:crypto';
import { handleAgentMessage } from '../agent/executor.js';
import { finalizeMessage } from '../agent/finalizer.js';
import { ALL_REQUESTED_SCOPES } from '../eve/scopes.js';

export function registerHandlers(bot: Bot<Context>, db: Db): void {
  // /start
  bot.command('start', async (ctx) => {
    ensureSession(db, ctx);
    await ctx.reply(
      'EVE Agent ready. Send me any EVE-related question.\n\n' +
      'Commands:\n' +
      '/eve_login -- link your EVE character\n' +
      '/whoami -- show linked character\n' +
      '/reset -- clear conversation'
    );
  });

  // /eve_login
  bot.command('eve_login', async (ctx) => {
    ensureSession(db, ctx);
    const state = randomUUID();

    // Store state in session for CSRF validation on callback
    db.prepare(
      `UPDATE telegram_sessions SET oauth_state = ? WHERE chat_id = ?`
    ).run(state, ctx.chat.id);

    const scopes = ALL_REQUESTED_SCOPES.join(' ');
    const url = new URL('https://login.eveonline.com/v2/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.eve.callbackUrl);
    url.searchParams.set('client_id', config.eve.clientId);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);

    await ctx.reply(`Open this link to login with EVE:\n${url.toString()}`);
  });

  // /whoami
  bot.command('whoami', async (ctx) => {
    ensureSession(db, ctx);
    const account = db.prepare('SELECT character_name, scopes_json FROM eve_accounts LIMIT 1').get() as
      | { character_name: string; scopes_json: string }
      | undefined;

    if (!account) {
      await ctx.reply('No EVE character linked. Use /eve_login to connect.');
      return;
    }

    const scopes = JSON.parse(account.scopes_json) as string[];
    await ctx.reply(
      `Character: ${account.character_name}\nScopes: ${scopes.length} granted`
    );
  });

  // /reset
  bot.command('reset', async (ctx) => {
    const chatId = ctx.chat.id;
    db.prepare('DELETE FROM messages WHERE thread_id IN (SELECT thread_id FROM agent_threads WHERE chat_id = ?)').run(chatId);
    db.prepare('DELETE FROM agent_threads WHERE chat_id = ?').run(chatId);
    await ctx.reply('Conversation cleared.');
  });

  // Text messages -> agent runtime
  bot.on('message:text', async (ctx) => {
    ensureSession(db, ctx);

    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // Get or create thread
    let thread = db.prepare('SELECT thread_id FROM agent_threads WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1').get(chatId) as
      | { thread_id: string }
      | undefined;

    if (!thread) {
      const threadId = randomUUID();
      db.prepare('INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)').run(threadId, chatId);
      thread = { thread_id: threadId };
    }

    // Store user message
    db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(thread.thread_id, 'user', text);

    try {
      const response = await handleAgentMessage(db, thread.thread_id, text);
      await ctx.reply(finalizeMessage(response));
    } catch (err) {
      console.error('[handler] Agent error:', err);
      await ctx.reply('Internal error processing your request. Please try again.');
    }
  });
}

function ensureSession(db: Db, ctx: Context): void {
  if (!ctx.chat) return;
  db.prepare(
    `INSERT INTO telegram_sessions (chat_id, username, last_seen_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET last_seen_at = datetime('now')`
  ).run(ctx.chat.id, ctx.from?.username ?? '');
}
