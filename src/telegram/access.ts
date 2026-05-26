export function isTelegramUserAllowed(userId: number | undefined, allowedUserId: number): boolean {
  if (allowedUserId <= 0) return true;
  return userId === allowedUserId;
}
