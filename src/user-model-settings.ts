import { config } from './config.js';
import type { Db } from './db/sqlite.js';
import {
  REASONING_EFFORTS,
  TEXT_VERBOSITIES,
  type ReasoningEffort,
  type TextVerbosity,
} from './openai-options.js';

/**
 * Per-user model preferences (the web «Настройки» screen). One row per
 * user_id, shared by every channel lane — web, Telegram, Discord and CLI all
 * resolve to the same user. No row means the operator's config defaults
 * apply, so existing users see zero behavior change.
 *
 * The selectable model set is fixed to the three ids verified against the
 * provider's /v1/models; tariffs (MODEL_PRICING_JSON) are keyed by the same
 * ids. Reasoning efforts and verbosities are exactly the values the existing
 * Responses API path already supports (src/openai-options.ts).
 */
export const USER_SELECTABLE_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;
export type UserSelectableModel = typeof USER_SELECTABLE_MODELS[number];

export type UserModelSettings = {
  model: UserSelectableModel;
  reasoningEffort: ReasoningEffort;
  verbosity: TextVerbosity;
};

export type ResolvedModelSettings = {
  /** The user's saved model, or config.openai.model when there is no row. */
  model: string;
  reasoningEffort: ReasoningEffort;
  verbosity: TextVerbosity;
  /** True when no saved row exists and every value is the config default. */
  isDefault: boolean;
};

const SELECTABLE_MODEL_SET: ReadonlySet<string> = new Set(USER_SELECTABLE_MODELS);
const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);
const VERBOSITY_SET: ReadonlySet<string> = new Set(TEXT_VERBOSITIES);

export function isUserSelectableModel(value: unknown): value is UserSelectableModel {
  return typeof value === 'string' && SELECTABLE_MODEL_SET.has(value);
}

export function isUserReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_SET.has(value);
}

export function isUserVerbosity(value: unknown): value is TextVerbosity {
  return typeof value === 'string' && VERBOSITY_SET.has(value);
}

type UserModelSettingsRow = {
  model: string;
  reasoning_effort: string;
  verbosity: string;
};

/**
 * Saved settings or null. A row whose values no longer pass the whitelists
 * (e.g. a model removed from the selectable set) reads as absent — the user
 * falls back to config defaults instead of sending a stale id upstream.
 */
export function getUserModelSettings(db: Db, userId: number): UserModelSettings | null {
  const row = db.prepare(
    'SELECT model, reasoning_effort, verbosity FROM user_model_settings WHERE user_id = ?',
  ).get(userId) as UserModelSettingsRow | undefined;
  if (!row) return null;
  if (
    !isUserSelectableModel(row.model)
    || !isUserReasoningEffort(row.reasoning_effort)
    || !isUserVerbosity(row.verbosity)
  ) {
    return null;
  }
  return { model: row.model, reasoningEffort: row.reasoning_effort, verbosity: row.verbosity };
}

export function saveUserModelSettings(db: Db, userId: number, settings: UserModelSettings): void {
  db.prepare(`
    INSERT INTO user_model_settings (user_id, model, reasoning_effort, verbosity, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      verbosity = excluded.verbosity,
      updated_at = excluded.updated_at
  `).run(userId, settings.model, settings.reasoningEffort, settings.verbosity);
}

/** Effective settings for a turn: the saved row merged over config defaults. */
export function resolveModelSettings(db: Db, userId: number): ResolvedModelSettings {
  const saved = getUserModelSettings(db, userId);
  if (!saved) {
    return {
      model: config.openai.model,
      reasoningEffort: config.openai.reasoningEffort,
      verbosity: config.openai.textVerbosity,
      isDefault: true,
    };
  }
  return { ...saved, isDefault: false };
}
