import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';
import {
  USER_SELECTABLE_MODELS,
  getUserModelSettings,
  isUserReasoningEffort,
  isUserSelectableModel,
  isUserVerbosity,
  resolveModelSettings,
  saveUserModelSettings,
} from '../../src/user-model-settings.js';

let db: Database.Database;

function addUser(): number {
  const result = db.prepare("INSERT INTO users (display_name) VALUES ('capsuleer')").run();
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('whitelists', () => {
  it('offers exactly the three provider-verified models', () => {
    expect(USER_SELECTABLE_MODELS).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    expect(isUserSelectableModel('gpt-5.6-sol')).toBe(true);
    expect(isUserSelectableModel('gpt-5.6-terra')).toBe(true);
    expect(isUserSelectableModel('gpt-5.6-luna')).toBe(true);
    expect(isUserSelectableModel('gpt-5.6')).toBe(false);
    expect(isUserSelectableModel('gpt-4o')).toBe(false);
    expect(isUserSelectableModel('')).toBe(false);
    expect(isUserSelectableModel(42)).toBe(false);
    expect(isUserSelectableModel(null)).toBe(false);
  });

  it('accepts only the reasoning efforts the Responses path supports', () => {
    for (const effort of ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(isUserReasoningEffort(effort)).toBe(true);
    }
    expect(isUserReasoningEffort('extreme')).toBe(false);
    expect(isUserReasoningEffort('LOW')).toBe(false);
    expect(isUserReasoningEffort(undefined)).toBe(false);
  });

  it('accepts only low/medium/high verbosity', () => {
    expect(isUserVerbosity('low')).toBe(true);
    expect(isUserVerbosity('medium')).toBe(true);
    expect(isUserVerbosity('high')).toBe(true);
    expect(isUserVerbosity('auto')).toBe(false);
    expect(isUserVerbosity('verbose')).toBe(false);
  });
});

describe('user_model_settings repository', () => {
  it('falls back to the config defaults when the user has no row', () => {
    const userId = addUser();
    expect(getUserModelSettings(db, userId)).toBeNull();
    expect(resolveModelSettings(db, userId)).toEqual({
      model: config.openai.model,
      reasoningEffort: config.openai.reasoningEffort,
      verbosity: config.openai.textVerbosity,
      isDefault: true,
    });
  });

  it('round-trips saved settings and marks them as non-default', () => {
    const userId = addUser();
    saveUserModelSettings(db, userId, {
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      verbosity: 'high',
    });
    expect(getUserModelSettings(db, userId)).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      verbosity: 'high',
    });
    expect(resolveModelSettings(db, userId)).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      verbosity: 'high',
      isDefault: false,
    });
  });

  it('upserts: a second save overwrites the same single row', () => {
    const userId = addUser();
    saveUserModelSettings(db, userId, { model: 'gpt-5.6-sol', reasoningEffort: 'high', verbosity: 'high' });
    saveUserModelSettings(db, userId, { model: 'gpt-5.6-terra', reasoningEffort: 'auto', verbosity: 'low' });
    const rows = db.prepare('SELECT * FROM user_model_settings WHERE user_id = ?').all(userId);
    expect(rows).toHaveLength(1);
    expect(getUserModelSettings(db, userId)).toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'auto',
      verbosity: 'low',
    });
  });

  it('keeps settings isolated per user', () => {
    const first = addUser();
    const second = addUser();
    saveUserModelSettings(db, first, { model: 'gpt-5.6-luna', reasoningEffort: 'none', verbosity: 'low' });
    expect(resolveModelSettings(db, second).isDefault).toBe(true);
    expect(resolveModelSettings(db, first).model).toBe('gpt-5.6-luna');
  });

  it('treats a row with stale off-whitelist values as absent', () => {
    const userId = addUser();
    db.prepare(
      "INSERT INTO user_model_settings (user_id, model, reasoning_effort, verbosity) VALUES (?, 'gpt-9-fake', 'low', 'low')",
    ).run(userId);
    expect(getUserModelSettings(db, userId)).toBeNull();
    expect(resolveModelSettings(db, userId).isDefault).toBe(true);
  });

  it('requires the referenced user to exist (FK)', () => {
    expect(() => saveUserModelSettings(db, 999_999, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
      verbosity: 'low',
    })).toThrow();
  });
});
