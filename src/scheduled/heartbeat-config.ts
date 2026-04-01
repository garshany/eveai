import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';
import { getLinkedCharacter } from '../eve/sso.js';

export type HeartbeatCheckType = 'mail' | 'skills' | 'wallet' | 'contracts' | 'killmails';

const VALID_CHECKS = new Set<HeartbeatCheckType>(['mail', 'skills', 'wallet', 'contracts', 'killmails']);
const MIN_INTERVAL = 300;      // 5 minutes
const MAX_INTERVAL = 86400 * 7; // 7 days
const DEFAULT_INTERVAL = 3600;  // 1 hour

export interface HeartbeatConfigRow {
  user_id: number;
  character_id: number;
  enabled: number;
  interval_seconds: number;
  checks_json: string;
  last_run_at: string | null;
  last_mail_id: number | null;
}

export type HeartbeatAction =
  | 'enable'
  | 'disable'
  | 'set_interval'
  | 'enable_check'
  | 'disable_check'
  | 'list';

export interface HeartbeatConfigArgs {
  action: HeartbeatAction;
  interval_seconds?: number;
  check?: string;
}

function getOrCreateConfig(db: Db, userId: number, characterId: number): HeartbeatConfigRow {
  const row = db.prepare(
    'SELECT * FROM heartbeat_config WHERE user_id = ? AND character_id = ?',
  ).get(userId, characterId) as HeartbeatConfigRow | undefined;

  if (row) return row;

  db.prepare(
    `INSERT INTO heartbeat_config (user_id, character_id, enabled, interval_seconds, checks_json)
     VALUES (?, ?, 0, ?, '["mail"]')`,
  ).run(userId, characterId, DEFAULT_INTERVAL);

  return db.prepare(
    'SELECT * FROM heartbeat_config WHERE user_id = ? AND character_id = ?',
  ).get(userId, characterId) as HeartbeatConfigRow;
}

function parseChecks(json: string): HeartbeatCheckType[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return ['mail'];
    return arr.filter((c): c is HeartbeatCheckType => VALID_CHECKS.has(c as HeartbeatCheckType));
  } catch {
    return ['mail'];
  }
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} сек`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч`;
  return `${Math.round(seconds / 86400)} дн`;
}

export function executeHeartbeatConfig(
  db: Db,
  ctx: UserContext,
  args: HeartbeatConfigArgs,
): Record<string, unknown> {
  const linked = getLinkedCharacter(db, ctx);
  if (!linked) {
    return { ok: false, error: 'No linked EVE character. Use /eve_login first.' };
  }

  const userId = ctx.userId;
  if (!userId) {
    return { ok: false, error: 'No user context available.' };
  }

  const config = getOrCreateConfig(db, userId, linked.characterId);
  const checks = parseChecks(config.checks_json);

  switch (args.action) {
    case 'enable': {
      db.prepare(
        "UPDATE heartbeat_config SET enabled = 1, updated_at = datetime('now') WHERE user_id = ? AND character_id = ?",
      ).run(userId, linked.characterId);
      return {
        ok: true,
        message: `Heartbeat включён. Интервал: ${formatInterval(config.interval_seconds)}. Проверки: ${checks.join(', ')}.`,
        enabled: true,
        interval_seconds: config.interval_seconds,
        checks,
      };
    }

    case 'disable': {
      db.prepare(
        "UPDATE heartbeat_config SET enabled = 0, updated_at = datetime('now') WHERE user_id = ? AND character_id = ?",
      ).run(userId, linked.characterId);
      return {
        ok: true,
        message: 'Heartbeat выключен.',
        enabled: false,
      };
    }

    case 'set_interval': {
      const interval = args.interval_seconds ?? DEFAULT_INTERVAL;
      if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
        return {
          ok: false,
          error: `Интервал должен быть от ${formatInterval(MIN_INTERVAL)} до ${formatInterval(MAX_INTERVAL)}.`,
        };
      }
      db.prepare(
        "UPDATE heartbeat_config SET interval_seconds = ?, updated_at = datetime('now') WHERE user_id = ? AND character_id = ?",
      ).run(interval, userId, linked.characterId);
      return {
        ok: true,
        message: `Интервал изменён на ${formatInterval(interval)}.`,
        interval_seconds: interval,
      };
    }

    case 'enable_check': {
      const check = args.check as HeartbeatCheckType;
      if (!check || !VALID_CHECKS.has(check)) {
        return { ok: false, error: `Неизвестная проверка. Доступные: ${[...VALID_CHECKS].join(', ')}.` };
      }
      if (!checks.includes(check)) {
        checks.push(check);
        db.prepare(
          "UPDATE heartbeat_config SET checks_json = ?, updated_at = datetime('now') WHERE user_id = ? AND character_id = ?",
        ).run(JSON.stringify(checks), userId, linked.characterId);
      }
      // Auto-enable heartbeat when adding a check
      if (!config.enabled) {
        db.prepare(
          "UPDATE heartbeat_config SET enabled = 1, updated_at = datetime('now') WHERE user_id = ? AND character_id = ?",
        ).run(userId, linked.characterId);
      }
      return {
        ok: true,
        message: `Проверка "${check}" включена. Активные: ${checks.join(', ')}.`,
        checks,
        enabled: true,
      };
    }

    case 'disable_check': {
      const check = args.check as HeartbeatCheckType;
      if (!check || !VALID_CHECKS.has(check)) {
        return { ok: false, error: `Неизвестная проверка. Доступные: ${[...VALID_CHECKS].join(', ')}.` };
      }
      const updated = checks.filter((c) => c !== check);
      db.prepare(
        "UPDATE heartbeat_config SET checks_json = ?, updated_at = datetime('now') WHERE user_id = ? AND character_id = ?",
      ).run(JSON.stringify(updated), userId, linked.characterId);
      return {
        ok: true,
        message: `Проверка "${check}" выключена. Активные: ${updated.length > 0 ? updated.join(', ') : 'нет'}.`,
        checks: updated,
      };
    }

    case 'list': {
      return {
        ok: true,
        enabled: Boolean(config.enabled),
        interval: formatInterval(config.interval_seconds),
        interval_seconds: config.interval_seconds,
        checks,
        available_checks: [...VALID_CHECKS],
        last_run_at: config.last_run_at,
        character: linked.characterName,
      };
    }

    default:
      return { ok: false, error: `Unknown action: ${args.action}` };
  }
}
