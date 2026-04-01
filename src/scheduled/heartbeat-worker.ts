import { Cron } from 'croner';
import type { Bot } from 'grammy';
import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { getAccessToken } from '../eve/sso.js';
import { getUserTelegramChatId } from '../auth/user-resolver.js';
import { runModelText } from '../agent/model.js';
import type { HeartbeatConfigRow, HeartbeatCheckType } from './heartbeat-config.js';
import type { UserContext } from '../auth/user-resolver.js';

const HEARTBEAT_CRON = '*/5 * * * *'; // every 5 minutes, checks per-user intervals internally

let cronJob: Cron | null = null;

export function startHeartbeat(bot: Bot, db: Db): void {
  console.log('[heartbeat] Starting heartbeat worker');
  cronJob = new Cron(HEARTBEAT_CRON, async () => {
    try {
      await runHeartbeatTick(bot, db);
    } catch (err) {
      console.error('[heartbeat] tick error:', err);
    }
  });
}

export function stopHeartbeat(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[heartbeat] Stopped');
  }
}

async function runHeartbeatTick(bot: Bot, db: Db): Promise<void> {
  const now = new Date();
  const nowUtc = now.toISOString().replace('T', ' ').slice(0, 19);

  const rows = db.prepare(`
    SELECT * FROM heartbeat_config
    WHERE enabled = 1
    AND (last_run_at IS NULL OR
         strftime('%s', 'now') - strftime('%s', last_run_at) >= interval_seconds)
  `).all() as HeartbeatConfigRow[];

  for (const row of rows) {
    try {
      await processUserHeartbeat(bot, db, row, nowUtc);
    } catch (err) {
      console.error('[heartbeat] user=%d char=%d error:', row.user_id, row.character_id, err);
    }
  }
}

async function processUserHeartbeat(
  bot: Bot,
  db: Db,
  row: HeartbeatConfigRow,
  nowUtc: string,
): Promise<void> {
  const ctx: UserContext = { userId: row.user_id };
  const chatId = getUserTelegramChatId(db, row.user_id);
  if (!chatId) {
    console.warn('[heartbeat] no chat_id for user=%d, skipping', row.user_id);
    return;
  }

  const tokenResult = await getAccessToken(db, ctx);
  if (!tokenResult) {
    console.warn('[heartbeat] no token for user=%d char=%d, skipping', row.user_id, row.character_id);
    return;
  }

  const checks = parseChecks(row.checks_json);
  const findings: string[] = [];

  for (const check of checks) {
    try {
      const result = await runCheck(db, ctx, row, check);
      if (result) findings.push(result);
    } catch (err) {
      console.error('[heartbeat] check=%s user=%d error:', check, row.user_id, err);
    }
  }

  // Update last_run_at regardless of findings
  db.prepare(
    "UPDATE heartbeat_config SET last_run_at = ? WHERE user_id = ? AND character_id = ?",
  ).run(nowUtc, row.user_id, row.character_id);

  if (findings.length === 0) {
    console.log('[heartbeat] user=%d char=%d: nothing new', row.user_id, row.character_id);
    return;
  }

  // Ask the model to summarize findings
  const characterName = getCharacterName(db, row.character_id);
  const summary = await summarizeFindings(characterName, findings);

  // Send to Telegram
  try {
    await bot.api.sendMessage(chatId, summary, { parse_mode: 'HTML' });
    console.log('[heartbeat] user=%d char=%d: sent summary (%d findings)', row.user_id, row.character_id, findings.length);
  } catch (err) {
    console.error('[heartbeat] telegram send failed user=%d:', row.user_id, err);
  }
}

function parseChecks(json: string): HeartbeatCheckType[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return ['mail'];
    return arr as HeartbeatCheckType[];
  } catch {
    return ['mail'];
  }
}

function getCharacterName(db: Db, characterId: number): string {
  const row = db.prepare('SELECT character_name FROM eve_accounts WHERE character_id = ?')
    .get(characterId) as { character_name: string } | undefined;
  return row?.character_name ?? `Character ${characterId}`;
}

async function runCheck(
  db: Db,
  ctx: UserContext,
  row: HeartbeatConfigRow,
  check: HeartbeatCheckType,
): Promise<string | null> {
  switch (check) {
    case 'mail':
      return await checkMail(db, ctx, row);
    case 'skills':
      return await checkSkills(db, ctx, row);
    case 'wallet':
      return await checkWallet(db, ctx, row);
    default:
      return null;
  }
}

async function checkMail(
  db: Db,
  ctx: UserContext,
  row: HeartbeatConfigRow,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{ mail_id: number; from: number; subject: string; timestamp: string }>>(
    db,
    'get_characters_character_id_mail',
    { character_id: row.character_id },
    ctx,
  );

  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;

  const lastMailId = row.last_mail_id ?? 0;
  const newMail = result.data.filter((m) => m.mail_id > lastMailId);

  if (newMail.length === 0) return null;

  // Update last_mail_id
  const maxMailId = Math.max(...newMail.map((m) => m.mail_id));
  db.prepare(
    'UPDATE heartbeat_config SET last_mail_id = ? WHERE user_id = ? AND character_id = ?',
  ).run(maxMailId, row.user_id, row.character_id);

  // Fetch bodies for up to 5 newest mail
  const mailDetails: string[] = [];
  const toFetch = newMail.slice(0, 5);
  for (const mail of toFetch) {
    const body = await callEsiOperation<{ body: string; subject: string }>(
      db,
      'get_characters_character_id_mail_mail_id',
      { character_id: row.character_id, mail_id: mail.mail_id },
      ctx,
    );
    const bodyText = body.ok ? body.data.body?.slice(0, 300) ?? '' : '';
    // Resolve sender name
    const senderName = await resolveName(db, ctx, mail.from);
    mailDetails.push(`От: ${senderName}\nТема: ${mail.subject}\nТекст: ${bodyText}`);
  }

  const extra = newMail.length > 5 ? `\n...и ещё ${newMail.length - 5} писем` : '';
  return `[ПОЧТА] ${newMail.length} новых писем:\n\n${mailDetails.join('\n\n')}${extra}`;
}

async function checkSkills(
  db: Db,
  ctx: UserContext,
  row: HeartbeatConfigRow,
): Promise<string | null> {
  const result = await callEsiOperation<Array<{
    skill_id: number;
    finished_level: number;
    finish_date?: string;
    queue_position: number;
  }>>(
    db,
    'get_characters_character_id_skillqueue',
    { character_id: row.character_id },
    ctx,
  );

  if (!result.ok || !Array.isArray(result.data)) return null;

  // Check if queue is empty (all skills finished)
  const now = new Date();
  const completed = result.data.filter((s) => s.finish_date && new Date(s.finish_date) <= now);
  const inProgress = result.data.filter((s) => s.finish_date && new Date(s.finish_date) > now);

  if (result.data.length === 0) {
    return '[СКИЛЛЫ] Очередь скиллов пуста!';
  }

  if (completed.length > 0 && inProgress.length === 0) {
    return `[СКИЛЛЫ] Все скиллы в очереди завершены (${completed.length} шт). Очередь пуста!`;
  }

  if (completed.length > 0) {
    const names = await resolveSkillNames(db, completed.map((s) => s.skill_id));
    return `[СКИЛЛЫ] Завершены: ${names.join(', ')}. В очереди ещё ${inProgress.length}.`;
  }

  return null;
}

async function checkWallet(
  db: Db,
  ctx: UserContext,
  row: HeartbeatConfigRow,
): Promise<string | null> {
  const result = await callEsiOperation<number>(
    db,
    'get_characters_character_id_wallet',
    { character_id: row.character_id },
    ctx,
  );

  if (!result.ok || typeof result.data !== 'number') return null;

  // For now, just report balance. TODO: track delta
  const balance = result.data;
  const formatted = balance.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `[КОШЕЛЁК] Баланс: ${formatted} ISK`;
}

async function resolveName(db: Db, ctx: UserContext, entityId: number): Promise<string> {
  const result = await callEsiOperation<Array<{ id: number; name: string }>>(
    db,
    'post_universe_names',
    { ids: [entityId] },
    ctx,
  );
  if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
    return result.data[0].name;
  }
  return `ID:${entityId}`;
}

async function resolveSkillNames(db: Db, skillIds: number[]): Promise<string[]> {
  const names: string[] = [];
  for (const id of skillIds) {
    const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(id) as { name: string } | undefined;
    names.push(row?.name ?? `skill:${id}`);
  }
  return names;
}

async function summarizeFindings(characterName: string, findings: string[]): Promise<string> {
  const systemPrompt = `You are an EVE Online assistant. Summarize the following heartbeat check results for character "${characterName}".
Be concise, use Russian language. Format for Telegram (plain text, no markdown).
If there are mail messages, briefly describe each and suggest if any action is needed.
Start with a short header line. Keep it under 1000 characters.`;

  const userPrompt = findings.join('\n\n---\n\n');

  try {
    const summary = await runModelText(systemPrompt, userPrompt);
    return summary;
  } catch (err) {
    console.error('[heartbeat] model summarize failed:', err);
    // Fallback: raw findings
    return `📋 ${characterName}:\n\n${findings.join('\n\n')}`;
  }
}
