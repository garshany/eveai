import { createHmac } from 'node:crypto';

/** Build a stable OpenAI safety identifier without exposing the internal user id. */
export function buildSafetyIdentifier(userId: number, secret: string): string | undefined {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !secret.trim()) return undefined;
  return createHmac('sha256', secret)
    .update(`eve-agent:user:${userId}`)
    .digest('hex');
}
