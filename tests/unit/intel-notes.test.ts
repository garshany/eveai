import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { executeIntelNote } from '../../src/eve-intel/notes.js';

type NotesResult = { ok: boolean; count: number; notes: Array<{ id: number; text: string }> };

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

function insertNote(userId: number, text: string, createdAt = '2026-09-01 12:00:00'): number {
  const result = db.prepare(
    'INSERT INTO intel_notes (user_id, text, created_at) VALUES (?, ?, ?)',
  ).run(userId, text, createdAt);
  return Number(result.lastInsertRowid);
}

describe('intel_note search escaping', () => {
  it('treats % in the query as a literal character, not a wildcard', () => {
    insertNote(1, 'tax is 100% here');
    insertNote(1, 'tax is 100 isk here');
    const result = executeIntelNote(db as Db, 1, { action: 'search', query: '100%' }) as NotesResult;
    expect(result.notes.map((note) => note.text)).toEqual(['tax is 100% here']);
  });

  it('treats _ in the query as a literal character, not a single-char wildcard', () => {
    insertNote(1, 'fit a_b');
    insertNote(1, 'fit axb');
    const result = executeIntelNote(db as Db, 1, { action: 'search', query: 'a_b' }) as NotesResult;
    expect(result.notes.map((note) => note.text)).toEqual(['fit a_b']);
  });

  it('matches a literal backslash in the query', () => {
    insertNote(1, 'path C:\\eve');
    insertNote(1, 'path C:eve');
    const result = executeIntelNote(db as Db, 1, { action: 'search', query: 'C:\\e' }) as NotesResult;
    expect(result.notes.map((note) => note.text)).toEqual(['path C:\\eve']);
  });

  it('still does plain substring search', () => {
    insertNote(1, 'Camp on Rancer gate');
    insertNote(2, 'Camp on Rancer gate (other user)');
    const result = executeIntelNote(db as Db, 1, { action: 'search', query: 'rancer' }) as NotesResult;
    expect(result.count).toBe(1);
  });
});

describe('intel_note ordering within the same second', () => {
  it('list returns newest-first by note_id when created_at ties', () => {
    const ids = [insertNote(1, 'first'), insertNote(1, 'second'), insertNote(1, 'third')];
    const result = executeIntelNote(db as Db, 1, { action: 'list' }) as NotesResult;
    expect(result.notes.map((note) => note.id)).toEqual([...ids].reverse());
  });

  it('search returns newest-first by note_id when created_at ties', () => {
    const ids = [insertNote(1, 'gate camp a'), insertNote(1, 'gate camp b'), insertNote(1, 'gate camp c')];
    const result = executeIntelNote(db as Db, 1, { action: 'search', query: 'gate camp' }) as NotesResult;
    expect(result.notes.map((note) => note.id)).toEqual([...ids].reverse());
  });
});
