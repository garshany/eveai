import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { createServer } from '../../src/web/server.js';

/**
 * The web server must never serialize internal error details (SQLite codes,
 * stack frames, file paths) into HTTP responses: the shared error handler
 * logs them server-side and answers a generic 500.
 */
describe('web error handler', () => {
  let db: Database.Database;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    app = await createServer(db);
    app.get('/api/web/boom', () => {
      throw new Error('SQLITE_BUSY: database is locked at src/db/sqlite.ts:42');
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('answers a throwing route with a generic 500 without internals', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('SQLITE');
    expect(response.body).not.toContain('sqlite.ts');
    expect(response.json()).toEqual({ error: 'Внутренняя ошибка сервера.' });
  });
});
