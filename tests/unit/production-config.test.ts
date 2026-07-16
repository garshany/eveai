import { describe, expect, it } from 'vitest';
import { validatePublicWebProductionConfig } from '../../src/web/production-config.js';

const valid = {
  nodeEnv: 'production',
  chatEnabled: true,
  baseUrl: 'https://eve.example',
  trustedProxyCidrs: ['173.245.48.0/20'],
  turnstileSecretKey: 'secret',
  turnstileHostname: 'eve.example',
};

describe('public web production startup validation', () => {
  it('accepts an explicit HTTPS, proxy and Turnstile configuration', () => {
    expect(validatePublicWebProductionConfig(valid)).toEqual([]);
  });

  it('rejects a public deployment without an expected Turnstile hostname', () => {
    expect(validatePublicWebProductionConfig({ ...valid, turnstileHostname: '' }))
      .toContain('Для публичного web origin задай TURNSTILE_EXPECTED_HOSTNAME.');
  });

  it('does not require public-edge controls for localhost development', () => {
    expect(validatePublicWebProductionConfig({
      ...valid,
      baseUrl: 'http://localhost:3000',
      trustedProxyCidrs: [],
      turnstileSecretKey: '',
      turnstileHostname: '',
    })).toEqual([]);
  });
});
