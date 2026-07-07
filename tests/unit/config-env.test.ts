import { describe, expect, it } from 'vitest';
import {
  parseOptionalBooleanEnv,
  parseOptionalIntEnv,
  parseRequiredIntEnv,
  readOptionalEnv,
  readRequiredEnv,
} from '../../src/config-env.js';

describe('config env parsing', () => {
  it('trims configured string values and rejects blank required values', () => {
    expect(readRequiredEnv({ TOKEN: '  value  ' }, 'TOKEN')).toBe('value');
    expect(readOptionalEnv({ NAME: '  Jita  ' }, 'NAME', 'fallback')).toBe('Jita');
    expect(readOptionalEnv({ NAME: '   ' }, 'NAME', 'fallback')).toBe('fallback');
    expect(() => readRequiredEnv({ TOKEN: '   ' }, 'TOKEN')).toThrow(/Missing required env var: TOKEN/);
  });

  it('accepts only integer env values for integer settings', () => {
    expect(parseRequiredIntEnv({ PORT: '3000' }, 'PORT')).toBe(3000);
    expect(parseOptionalIntEnv({ MAX_PAGES: '-1' }, 'MAX_PAGES', 5)).toBe(-1);
    expect(parseOptionalIntEnv({}, 'MAX_PAGES', 5)).toBe(5);

    expect(() => parseRequiredIntEnv({ PORT: '3000.5' }, 'PORT')).toThrow(/must be an integer/);
    expect(() => parseRequiredIntEnv({ PORT: '1e3' }, 'PORT')).toThrow(/must be an integer/);
    expect(() => parseRequiredIntEnv({ PORT: '9007199254740993' }, 'PORT')).toThrow(/safe integer/);
  });

  it('parses common boolean aliases and rejects ambiguous values', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'Y', 'on']) {
      expect(parseOptionalBooleanEnv({ FLAG: value }, 'FLAG', false)).toBe(true);
    }

    for (const value of ['false', 'FALSE', '0', 'no', 'N', 'off']) {
      expect(parseOptionalBooleanEnv({ FLAG: value }, 'FLAG', true)).toBe(false);
    }

    expect(parseOptionalBooleanEnv({}, 'FLAG', true)).toBe(true);
    expect(() => parseOptionalBooleanEnv({ FLAG: 'maybe' }, 'FLAG', true)).toThrow(
      /must be a boolean value/,
    );
  });
});
