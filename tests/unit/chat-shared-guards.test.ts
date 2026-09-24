import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/eve/user-profile.js', () => ({
  isUserProfileStale: vi.fn(() => false),
  readUserProfile: vi.fn(async () => '- Corporation: Test Corp\n- System: Jita'),
  refreshUserProfile: vi.fn(async () => ({ ok: true })),
}));

const {
  evaluateChatRequestAllowance,
  refreshAndSummarize,
  resetChatRequestGuardForTests,
  trackedRequestActorCountForTests,
} = await import('../../src/chat/shared.js');

afterEach(() => {
  resetChatRequestGuardForTests();
  vi.useRealTimers();
});

describe('chat request rate-limit map', () => {
  it('evicts idle actors once their window has expired', () => {
    const start = 1_000_000_000;
    for (let userId = 1; userId <= 50; userId += 1) {
      const allowed = evaluateChatRequestAllowance({
        chatId: userId, userId, hasActiveRequest: false, activeRequestCount: 0, now: start,
      });
      expect(allowed.ok).toBe(true);
    }
    expect(trackedRequestActorCountForTests()).toBe(50);

    // A day later only the new actor remains tracked.
    evaluateChatRequestAllowance({
      chatId: 999, userId: 999, hasActiveRequest: false, activeRequestCount: 0, now: start + 86_400_000,
    });
    expect(trackedRequestActorCountForTests()).toBe(1);
  });
});

describe('refreshAndSummarize', () => {
  it('clears its refresh timeout once the profile refresh settles', async () => {
    vi.useFakeTimers();
    const summary = await refreshAndSummarize({} as never, {} as never, 'Pilot', 42);
    expect(summary).toContain('Test Corp');
    expect(vi.getTimerCount()).toBe(0);
  });
});
