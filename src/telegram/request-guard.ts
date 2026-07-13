/**
 * Backward-compatible Telegram-named wrappers around the shared chat request
 * guard. The actual sliding-window logic lives in src/chat/shared.ts and is
 * shared with the Discord bot.
 */
export {
  evaluateChatRequestAllowance as evaluateTelegramRequestAllowance,
  resetChatRequestGuardForTests as resetTelegramRequestGuardForTests,
} from '../chat/shared.js';

export type {
  ChatRequestAllowanceInput as TelegramRequestAllowanceInput,
  ChatRequestAllowance as TelegramRequestAllowance,
} from '../chat/shared.js';
