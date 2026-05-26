import { describe, expect, it } from 'vitest';
import { pickTelegramParseMode } from '../../src/telegram/formatting.js';

describe('pickTelegramParseMode', () => {
  it('returns HTML for supported telegram html markup', () => {
    expect(pickTelegramParseMode('<b>Bold</b>')).toBe('HTML');
    expect(pickTelegramParseMode('<code>block</code>')).toBe('HTML');
    expect(pickTelegramParseMode('<a href="https://zkillboard.com/kill/1/">zkb</a>')).toBe('HTML');
    expect(pickTelegramParseMode('<i>italics</i>')).toBe('HTML');
  });

  it('returns undefined for plain text', () => {
    expect(pickTelegramParseMode('Просто текст без разметки')).toBeUndefined();
  });
});
