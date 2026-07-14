import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

type LockOwner = {
  pid: number;
  token: string;
  runtime: string;
  createdAt: string;
  processStartedAt: number;
};

export type RuntimeLock = {
  path: string;
  release: () => void;
};

export class RuntimeLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLockError';
  }
}

/**
 * Atomically owns the one process allowed to use a DB-backed runtime.
 *
 * A directory rename is used for stale-lock takeover so two reclaimers cannot
 * delete a newly acquired lock. The owner token also prevents an old process
 * from releasing a successor's lock during shutdown.
 */
export function acquireRuntimeLock(dbPath: string, runtime: string): RuntimeLock {
  const absoluteDbPath = resolve(dbPath);
  const lockPath = `${absoluteDbPath}.runtime.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    runtime,
    createdAt: new Date().toISOString(),
    processStartedAt: SELF_PROCESS_STARTED_AT,
  };
  const candidate = `${lockPath}.candidate-${owner.token}`;
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(ownerPath(candidate), JSON.stringify(owner), { mode: 0o600 });

  try {
    for (;;) {
      try {
        renameSync(candidate, lockPath);
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const current = readOwner(lockPath);
        if (current && isProcessAlive(current.pid)) {
          const observedStart = getProcessStartedAt(current.pid);
          if (observedStart === null) {
            throw new RuntimeLockError(
              `Database runtime lock names live pid ${current.pid}, but its process identity cannot be verified. Stop the owner or remove ${lockPath} only after confirming it is stale.`,
            );
          }
          if (Math.abs(observedStart - current.processStartedAt) <= 2) {
            throw new RuntimeLockError(
              `Database runtime is already owned by ${current.runtime} (pid ${current.pid}). Stop it before starting ${runtime}.`,
            );
          }
          // The PID is alive but its start time does not match the lock. The OS
          // reused a crashed owner's PID, so the directory is stale.
        }

        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          renameSync(lockPath, stalePath);
        } catch (takeoverError) {
          if (isMissing(takeoverError) || isAlreadyExists(takeoverError)) continue;
          throw takeoverError;
        }
        rmSync(stalePath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    const current = readOwner(lockPath);
    if (current?.token !== owner.token) return;
    const releasedPath = `${lockPath}.released-${owner.token}`;
    try {
      renameSync(lockPath, releasedPath);
      rmSync(releasedPath, { recursive: true, force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  process.once('exit', release);
  return { path: lockPath, release };
}

function ownerPath(lockPath: string): string {
  return `${lockPath}/owner.json`;
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath(lockPath), 'utf8')) as Partial<LockOwner>;
    if (
      !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.token !== 'string'
      || typeof parsed.runtime !== 'string'
      || typeof parsed.createdAt !== 'string'
      || !Number.isSafeInteger(parsed.processStartedAt)
      || Number(parsed.processStartedAt) <= 0
    ) return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

// A PID is not a process identity because operating systems reuse it after a
// crash. `ps` receives only a fixed executable and a validated numeric PID;
// failure is handled fail-closed for a live foreign process.
const SELF_PROCESS_STARTED_AT = Math.floor((Date.now() - process.uptime() * 1_000) / 1_000);

function getProcessStartedAt(pid: number): number | null {
  if (pid === process.pid) return SELF_PROCESS_STARTED_AT;
  try {
    const value = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).trim();
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? Math.floor(millis / 1_000) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAlreadyExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
