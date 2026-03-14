/**
 * Finalizer utilities.
 * Post-processes agent output before sending to Telegram.
 */

const MAX_TELEGRAM_LENGTH = 4096;

/**
 * Truncate text to Telegram's message limit and add a notice if truncated.
 */
export function truncateForTelegram(text: string): string {
  if (text.length <= MAX_TELEGRAM_LENGTH) return text;
  const cutoff = MAX_TELEGRAM_LENGTH - 30;
  return text.slice(0, cutoff) + '\n\n[...ответ обрезан]';
}

/**
 * Strip any accidentally leaked tokens or secrets from the response.
 */
export function sanitizeOutput(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[TOKEN_REDACTED]');
}

/**
 * Prepare final message for Telegram.
 */
export function finalizeMessage(text: string): string {
  return truncateForTelegram(sanitizeOutput(text));
}
