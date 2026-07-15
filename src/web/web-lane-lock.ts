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
