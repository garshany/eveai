import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '0.0.0.0' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
  },
}));

import { safeExecOcli } from '../../src/eve/ocli.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('safe_exec_ocli', () => {
  it('rejects unknown profile', async () => {
    const result = await safeExecOcli(db, {
      profile: 'eve-unknown',
      mode: 'search',
      query: 'test',
      command: null,
      args: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown profile');
  });

  it('rejects help without command', async () => {
    const result = await safeExecOcli(db, {
      profile: 'eve-public',
      mode: 'help',
      query: null,
      command: null,
      args: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('requires a command');
  });

  it('rejects run without command', async () => {
    const result = await safeExecOcli(db, {
      profile: 'eve-public',
      mode: 'run',
      query: null,
      command: null,
      args: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('requires a command');
  });

  it('rejects auth-required profile without linked character', async () => {
    const result = await safeExecOcli(db, {
      profile: 'eve-wallet',
      mode: 'search',
      query: 'balance',
      command: null,
      args: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No EVE character linked');
  });

  it('rejects auth for eve-industry without character', async () => {
    const result = await safeExecOcli(db, {
      profile: 'eve-industry',
      mode: 'search',
      query: 'jobs',
      command: null,
      args: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No EVE character linked');
  });

  it('rejects auth for eve-mail without character', async () => {
    const result = await safeExecOcli(db, {
      profile: 'eve-mail',
      mode: 'search',
      query: 'inbox',
      command: null,
      args: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No EVE character linked');
  });

  it('rejects auth for eve-ui without character', async () => {
    const result = await safeExecOcli(db, {
      profile: 'eve-ui',
      mode: 'search',
      query: 'waypoint',
      command: null,
      args: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No EVE character linked');
  });
});
