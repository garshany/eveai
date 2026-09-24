import { describe, expect, it } from 'vitest';
import { securityClassName, securityTier } from '../../web/src/security.js';

describe('security status colour tier', () => {
  it('follows the displayed one-decimal value', () => {
    expect(securityTier(1)).toBe('10');
    expect(securityTier(0.95)).toBe('09'); // binary 0.9499… displays as 0.9
    expect(securityTier(0.5)).toBe('05');
    expect(securityTier(0.45)).toBe('05');
    expect(securityTier(0.44)).toBe('04');
    expect(securityTier(0.1)).toBe('01');
  });

  it('keeps tiny positive lowsec at 0.1 and everything else at 0.0', () => {
    expect(securityTier(0.01)).toBe('01');
    expect(securityTier(0)).toBe('00');
    expect(securityTier(-0.73)).toBe('00');
    expect(securityTier(Number.NaN)).toBe('00');
    expect(securityTier(5)).toBe('10');
  });

  it('builds the className for inline text and badges', () => {
    expect(securityClassName(0.5)).toBe('sec sec--05');
    expect(securityClassName(-0.2, 'sec-badge')).toBe('sec-badge sec--00');
  });
});
