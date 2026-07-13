import { describe, expect, it } from 'vitest';
import { stripTerminalControls } from '../../src/cli/term-sanitize.js';

describe('stripTerminalControls', () => {
  it('removes OSC window-title and clipboard sequences', () => {
    expect(stripTerminalControls('до\x1b]0;evil title\x07после')).toBe('допосле');
    // OSC 52 clipboard write, ST-terminated.
    expect(stripTerminalControls('a\x1b]52;c;ZXZpbA==\x1b\\b')).toBe('ab');
    // Unterminated OSC must not swallow the rest silently AND must not leak.
    expect(stripTerminalControls('x\x1b]0;evil')).toBe('x');
  });

  it('removes CSI sequences (screen wipe, cursor moves, colors)', () => {
    expect(stripTerminalControls('a\x1b[2Jb')).toBe('ab');
    expect(stripTerminalControls('a\x1b[31mred\x1b[0mb')).toBe('aredb');
    expect(stripTerminalControls('a\x1b[10;20Hb')).toBe('ab');
  });

  it('removes DCS/APC strings and bare escapes', () => {
    expect(stripTerminalControls('a\x1bPq payload\x1b\\b')).toBe('ab');
    expect(stripTerminalControls('a\x1b_hidden\x1b\\b')).toBe('ab');
    expect(stripTerminalControls('a\x1bZb')).toBe('ab');
    expect(stripTerminalControls('trailing esc\x1b')).toBe('trailing esc');
  });

  it('removes C0/C1 controls including carriage return and BEL', () => {
    expect(stripTerminalControls('a\rb')).toBe('ab'); // \r line-overwrite trick
    expect(stripTerminalControls('a\x07b')).toBe('ab');
    expect(stripTerminalControls('a\x00\x08\x0b\x7fb')).toBe('ab');
    // Raw 8-bit C1 CSI (U+009B) — the one-byte form of ESC [.
    expect(stripTerminalControls('a\u009bmalicious-c1-csi')).toBe('amalicious-c1-csi');
  });

  it('keeps newlines, tabs, cyrillic, emoji and plain punctuation', () => {
    const text = 'Цена PLEX:\n\t4 621 543,38 ISK 🚀 — ok (100%)';
    expect(stripTerminalControls(text)).toBe(text);
  });
});
