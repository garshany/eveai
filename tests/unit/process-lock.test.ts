import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { acquireRuntimeLock, RuntimeLockError } from '../../src/runtime/process-lock.js';

let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('runtime process lock', () => {
  it('blocks a second live owner and releases for the next runtime', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    const first = acquireRuntimeLock(dbPath, 'first');
    expect(() => acquireRuntimeLock(dbPath, 'second')).toThrow(RuntimeLockError);
    first.release();
    const second = acquireRuntimeLock(dbPath, 'second');
    second.release();
  });

  it('atomically reclaims a stale owner directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    const lockPath = `${dbPath}.runtime.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      pid: 999_999_999,
      token: 'stale',
      runtime: 'crashed',
      createdAt: '2026-01-01T00:00:00.000Z',
      processStartedAt: 1,
    }));

    const lock = acquireRuntimeLock(dbPath, 'replacement');
    expect(lock.path).toBe(lockPath);
    lock.release();
  });

  it('reclaims a crashed owner when its pid has been reused', () => {
    dir = mkdtempSync(join(tmpdir(), 'eve-runtime-lock-'));
    const dbPath = join(dir, 'eve.db');
    const lockPath = `${dbPath}.runtime.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'crashed-owner',
      runtime: 'crashed',
      createdAt: '2026-01-01T00:00:00.000Z',
      processStartedAt: 1,
    }));

    const lock = acquireRuntimeLock(dbPath, 'replacement');
    expect(lock.path).toBe(lockPath);
    lock.release();
  });
});
