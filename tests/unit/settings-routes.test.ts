import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';
import { registerSettingsRoutes } from '../../src/web/settings-routes.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';
const SETTINGS_URL = '/api/web/settings/model';
const VALID_BODY = {
  model: 'gpt-5.6-luna',
  reasoning_effort: 'low',
  verbosity: 'high',
};

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerSettingsRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

function browserSession() {
  const created = createWebSession(db);
  return {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
    chatId: created.chatId,
  };
}

function mutationHeaders(session: ReturnType<typeof browserSession>) {
  return {
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
}

/** Give the session user a linked EVE character so the PUT gate lets them through. */
function linkCharacter(userId: number, characterId = 95465510) {
  db.prepare(`
    INSERT INTO eve_accounts (
      character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
    ) VALUES (?, 'Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), '[]', ?)
  `).run(characterId, userId);
}

describe('settings routes: auth', () => {
  it('rejects GET without a browser session', async () => {
    const response = await app.inject({ method: 'GET', url: SETTINGS_URL });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects PUT without a browser session', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: { origin: ORIGIN },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects PUT without the CSRF token', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: { origin: ORIGIN, cookie: session.cookie },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects PUT from a foreign origin', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: { origin: 'https://evil.example', cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('settings routes: guest gate', () => {
  it('rejects PUT from a guest without a linked character', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('character_required');
    expect(db.prepare('SELECT * FROM user_model_settings').all()).toHaveLength(0);
  });

  it('lets a guest read the effective defaults with canCustomize=false', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'GET',
      url: SETTINGS_URL,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().canCustomize).toBe(false);
  });

  it('accepts PUT once a character is linked and reports canCustomize=true', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().canCustomize).toBe(true);
  });
});

describe('settings routes: validation', () => {
  it('rejects an unknown model', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: { ...VALID_BODY, model: 'gpt-4o' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('unknown_model');
    expect(db.prepare('SELECT * FROM user_model_settings').all()).toHaveLength(0);
  });

  it('rejects an off-whitelist reasoning effort', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: { ...VALID_BODY, reasoning_effort: 'extreme' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_reasoning_effort');
  });

  it('rejects an off-whitelist verbosity', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: { ...VALID_BODY, verbosity: 'auto' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_verbosity');
  });

  it('rejects a body with missing fields', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: { model: 'gpt-5.6-sol' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('settings routes: state', () => {
  it('answers the config defaults when the user has no saved row', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'GET',
      url: SETTINGS_URL,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.settings).toEqual({
      model: config.openai.model,
      reasoningEffort: config.openai.reasoningEffort,
      verbosity: config.openai.textVerbosity,
      isDefault: true,
    });
    expect(payload.defaults.model).toBe(config.openai.model);
    expect(payload.options.models.map((entry: { id: string }) => entry.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(payload.options.reasoningEfforts).toContain('auto');
    expect(payload.options.verbosities).toEqual(['low', 'medium', 'high']);
  });

  it('saves a valid choice and answers with the applied state', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.settings).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      verbosity: 'high',
      isDefault: false,
    });
    const row = db.prepare('SELECT * FROM user_model_settings WHERE user_id = ?').get(session.userId) as Record<string, unknown>;
    expect(row).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoning_effort: 'low',
      verbosity: 'high',
    });

    const reread = await app.inject({
      method: 'GET',
      url: SETTINGS_URL,
      headers: { cookie: session.cookie },
    });
    expect(reread.json().settings).toEqual(payload.settings);
  });

  it('keeps other users on their own row and never exposes a foreign one', async () => {
    const first = browserSession();
    const second = browserSession();
    linkCharacter(first.userId);
    linkCharacter(second.userId, 95465511);
    await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(first),
      payload: VALID_BODY,
    });

    const secondView = await app.inject({
      method: 'GET',
      url: SETTINGS_URL,
      headers: { cookie: second.cookie },
    });
    expect(secondView.json().settings.isDefault).toBe(true);
    expect(secondView.json().settings.model).toBe(config.openai.model);

    // The second user's save touches only their own row.
    await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(second),
      payload: { model: 'gpt-5.6-sol', reasoning_effort: 'max', verbosity: 'low' },
    });
    const firstRow = db.prepare('SELECT * FROM user_model_settings WHERE user_id = ?').get(first.userId) as Record<string, unknown>;
    expect(firstRow.model).toBe('gpt-5.6-luna');
    const rows = db.prepare('SELECT * FROM user_model_settings').all();
    expect(rows).toHaveLength(2);
  });
});

describe('settings routes: response chain reset', () => {
  function seedThread(session: ReturnType<typeof browserSession>) {
    db.prepare(`
      INSERT INTO agent_threads (thread_id, chat_id, user_id, last_response_id, last_response_message_id)
      VALUES ('thread-1', ?, ?, 'resp_old_model', 42)
    `).run(session.chatId, session.userId);
  }

  function responseChain() {
    return db.prepare('SELECT last_response_id, last_response_message_id FROM agent_threads WHERE thread_id = ?')
      .get('thread-1') as { last_response_id: string | null; last_response_message_id: number | null };
  }

  it('PUT drops the stored previous_response_id minted by the old model', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    seedThread(session);

    const response = await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(responseChain()).toEqual({ last_response_id: null, last_response_message_id: null });
  });

  it('DELETE drops the stored previous_response_id as well', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    seedThread(session);

    const response = await app.inject({
      method: 'DELETE',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    expect(responseChain()).toEqual({ last_response_id: null, last_response_message_id: null });
  });
});

describe('settings routes: reset to defaults', () => {
  it('rejects DELETE without the CSRF token', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'DELETE',
      url: SETTINGS_URL,
      headers: { origin: ORIGIN, cookie: session.cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('DELETE removes the saved row and answers with the applied defaults', async () => {
    const session = browserSession();
    linkCharacter(session.userId);
    await app.inject({
      method: 'PUT',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
      payload: VALID_BODY,
    });
    expect(db.prepare('SELECT * FROM user_model_settings WHERE user_id = ?').get(session.userId)).toBeDefined();

    const response = await app.inject({
      method: 'DELETE',
      url: SETTINGS_URL,
      headers: mutationHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.settings).toEqual({
      model: config.openai.model,
      reasoningEffort: config.openai.reasoningEffort,
      verbosity: config.openai.textVerbosity,
      isDefault: true,
    });
    expect(db.prepare('SELECT * FROM user_model_settings WHERE user_id = ?').get(session.userId)).toBeUndefined();
  });
});
