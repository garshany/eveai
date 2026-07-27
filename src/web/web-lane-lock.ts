const webLaneAuthorizationLocks = new Map<number, Promise<void>>();

/** Serialize browser ownership/link changes with logout and expiry purge. */
export async function withWebLaneAuthorizationLock<T>(
  chatId: number,
  action: () => Promise<T>,
): Promise<T> {
  const previous = webLaneAuthorizationLocks.get(chatId) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => gate);
  webLaneAuthorizationLocks.set(chatId, queued);

  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (webLaneAuthorizationLocks.get(chatId) === queued) {
      webLaneAuthorizationLocks.delete(chatId);
    }
  }
}

/**
 * Take several lane locks at once. Locks are acquired one by one in ascending
 * chat-id order so concurrent multi-lane critical sections cannot deadlock.
 */
export async function withWebLaneAuthorizationLocks<T>(
  chatIds: number[],
  action: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(chatIds)].sort((a, b) => a - b);
  const acquire = (index: number): Promise<T> => {
    if (index >= ordered.length) return action();
    return withWebLaneAuthorizationLock(ordered[index]!, () => acquire(index + 1));
  };
  return await acquire(0);
}
