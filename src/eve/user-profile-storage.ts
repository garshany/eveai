import { rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, parse } from 'node:path';
import { config } from '../config.js';
import type { UserContext } from '../auth/user-resolver.js';

const profileAuthorizationLocks = new Map<number, Promise<void>>();

/**
 * Serialize the final profile write with authorization replacement for one
 * character. ESI reads stay concurrent; only the filesystem commit and SSO
 * cutover share this lock.
 */
export async function withUserProfileAuthorizationLock<T>(
  characterId: number,
  action: () => Promise<T>,
): Promise<T> {
  const previous = profileAuthorizationLocks.get(characterId) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => gate);
  profileAuthorizationLocks.set(characterId, queued);

  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (profileAuthorizationLocks.get(characterId) === queued) {
      profileAuthorizationLocks.delete(characterId);
    }
  }
}

export function resolveUserProfilePath(ctx: UserContext, characterId: number): string {
  const base = config.userProfile.path;
  const chatId = ctx.chatId;
  if (base.includes('{chat_id}') || base.includes('{character_id}')) {
    return base
      .replace('{chat_id}', chatId !== undefined ? String(chatId) : String(ctx.userId))
      .replace('{character_id}', String(characterId));
  }

  const identifier = chatId !== undefined ? chatId : ctx.userId;
  const pathInfo = parse(base);
  const stem = pathInfo.ext ? pathInfo.name : pathInfo.base || 'USER';
  return join(pathInfo.dir || dirname(base), `${stem}_${identifier}_${characterId}.md`);
}

export async function deleteUserProfileArtifact(ctx: UserContext, characterId: number): Promise<void> {
  const path = resolveUserProfilePath(ctx, characterId);
  await rm(path, { force: true });
}

/**
 * Write USER.md atomically (temp file + rename) so a crash mid-write can never
 * leave a truncated profile that then gets fed back into the model prompt.
 */
export async function writeUserProfileAtomic(
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  // Unique per write (not just per pid) — two concurrent writes to the same
  // profile in this process (e.g. a background refresh + a /use update) would
  // otherwise share one temp path and clobber each other.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, content, { signal });
    if (signal?.aborted) throw new Error('Profile refresh cancelled.');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
