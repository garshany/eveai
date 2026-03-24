import { describe, expect, it } from 'vitest';
import {
  areSimilarWebSearchQueries,
  createWebSearchState,
  normalizeWebSearchQuery,
  registerWebSearch,
} from '../../src/agent/executor.js';

describe('web search guard', () => {
  it('normalizes site filters and punctuation', () => {
    expect(
      normalizeWebSearchQuery('best ways to make ISK in EVE Online 2025 site:eveuniversity.org OR site:reddit.com/r/Eve'),
    ).toBe('best ways to make isk in eve online 2025 or');
  });

  it('detects materially similar queries', () => {
    expect(
      areSimilarWebSearchQueries(
        'eve university making isk guide best ways to make isk exploration abyssal incursions wormhole trading',
        'making isk exploration abyssal incursions wormhole gas huffing trading eve university',
      ),
    ).toBe(true);
  });

  it('allows at most two web searches in one turn', () => {
    const state = createWebSearchState();

    expect(registerWebSearch(state, 'best ways to make ISK in EVE Online 2025')).toEqual({
      allowed: true,
      reason: null,
    });
    expect(registerWebSearch(state, 'EVE University making ISK guide exploration abyssal incursions')).toEqual({
      allowed: true,
      reason: null,
    });

    const blocked = registerWebSearch(state, 'site:wiki.eveuniversity.org exploration abyssal incursions wormhole trading');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('лимит web_search');
  });

  it('blocks exact duplicate queries immediately', () => {
    const state = createWebSearchState();
    expect(registerWebSearch(state, 'wormhole effects black hole')).toEqual({
      allowed: true,
      reason: null,
    });

    const duplicate = registerWebSearch(state, 'wormhole effects black hole');
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.reason).toContain('Повторный web_search');
  });
});
