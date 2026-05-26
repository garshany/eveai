import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  truncateForTelegram,
  sanitizeOutput,
  finalizeMessage,
  finalizeThreadMessage,
} from '../../src/agent/finalizer.js';

describe('finalizer', () => {
  it('passes short text through unchanged', () => {
    expect(truncateForTelegram('hello')).toBe('hello');
  });

  it('truncates text over 4096 chars', () => {
    const long = 'x'.repeat(5000);
    const result = truncateForTelegram(long);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result).toContain('[...ответ обрезан]');
  });

  it('redacts Bearer tokens', () => {
    const text = 'Got: Bearer token-redaction-test-value-1234567890';
    const result = sanitizeOutput(text);
    expect(result).not.toContain('token-redaction-test-value');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts standalone JWT tokens', () => {
    const text = 'Token is ' + 'eyJ' + 'redaction_test_value_with_enough_length';
    const result = sanitizeOutput(text);
    expect(result).toContain('[TOKEN_REDACTED]');
  });

  it('finalizeMessage combines truncation and sanitization', () => {
    const text = 'Bearer token-redaction-test-value-abcdefghijklmnopqrstuvwxyz';
    const result = finalizeMessage(text);
    expect(result).not.toContain('token-redaction-test-value');
  });

  it('keeps HTML telegram replies valid when appending helpful commands', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO telegram_sessions (chat_id) VALUES (?)').run(1);
    db.prepare('INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)').run('thread-1', 1);
    db.prepare(
      "INSERT INTO messages (thread_id, role, content) VALUES (?, 'tool', ?)"
    ).run('thread-1', JSON.stringify({ suggested: '/market 34' }));

    const result = finalizeThreadMessage(db, 'thread-1', '<b>Dodixie → Jita</b>\nVictim ← Attacker');

    expect(result).toContain('<b>Полезные команды</b>');
    expect(result).toContain('<code>/market 34</code>');
    expect(result).not.toContain('**Полезные команды**');

    db.close();
  });
});
