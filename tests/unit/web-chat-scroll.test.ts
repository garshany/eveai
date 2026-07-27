import { describe, expect, it, vi } from 'vitest';
import {
  SCROLL_PIN_THRESHOLD_PX,
  decideScrollBehavior,
  isPinnedToBottom,
  scrollToBottom,
} from '../../web/src/chat-scroll.js';

describe('decideScrollBehavior', () => {
  it('returns instant for the initial history load', () => {
    expect(decideScrollBehavior(true)).toBe('instant');
  });

  it('returns smooth for follow-up autoscrolls', () => {
    expect(decideScrollBehavior(false)).toBe('smooth');
  });
});

describe('isPinnedToBottom', () => {
  const container = (distance: number) => ({
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 1000 - 400 - distance,
  });

  it('is pinned when the distance to the bottom is below the threshold', () => {
    expect(isPinnedToBottom(container(SCROLL_PIN_THRESHOLD_PX - 1))).toBe(true);
    expect(isPinnedToBottom(container(0))).toBe(true);
  });

  it('is not pinned at or above the threshold', () => {
    expect(isPinnedToBottom(container(SCROLL_PIN_THRESHOLD_PX))).toBe(false);
    expect(isPinnedToBottom(container(500))).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(isPinnedToBottom(container(15), 10)).toBe(false);
    expect(isPinnedToBottom(container(15), 20)).toBe(true);
  });
});

describe('scrollToBottom', () => {
  it('scrolls to scrollHeight via scrollTo so padding and the last message are included', () => {
    const scrollTo = vi.fn();
    const container = { scrollTop: 0, scrollHeight: 1234, clientHeight: 400, scrollTo };
    scrollToBottom(container, 'instant');
    expect(scrollTo).toHaveBeenCalledWith({ top: 1234, behavior: 'instant' });
    scrollToBottom(container, 'smooth');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1234, behavior: 'smooth' });
  });

  it('falls back to assigning scrollTop when scrollTo is unavailable', () => {
    const container = { scrollTop: 0, scrollHeight: 1234, clientHeight: 400 };
    scrollToBottom(container, 'instant');
    expect(container.scrollTop).toBe(1234);
  });
});
