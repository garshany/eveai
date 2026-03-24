import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const HASH_PREFIX = 'h1';
const ENCRYPTION_PREFIX = 'enc';
const ENCRYPTION_VERSION = 'v1';
const MASTER_SALT = Buffer.from('eve-agent-auth-storage', 'utf8');
const DEV_AUTH_SECRET = 'eve-agent-dev-auth-storage';
const TEST_AUTH_SECRET = 'eve-agent-test-auth-storage';

type ConfigWithOptionalAuth = typeof config & {
  auth?: {
    secretKey?: string;
  };
};

function getMasterSecret(): Buffer {
  const configured = (config as ConfigWithOptionalAuth).auth?.secretKey?.trim();
  if (configured) {
    return createHash('sha256').update(configured, 'utf8').digest();
  }

  if (isTestEnvironment()) {
    return createHash('sha256').update(TEST_AUTH_SECRET, 'utf8').digest();
  }

  if (process.env.NODE_ENV !== 'production') {
    return createHash('sha256').update(DEV_AUTH_SECRET, 'utf8').digest();
  }

  throw new Error('Missing required env var: AUTH_SECRET_KEY');
}

function deriveKey(info: string): Buffer {
  const key = hkdfSync('sha256', getMasterSecret(), MASTER_SALT, Buffer.from(info, 'utf8'), 32);
  return Buffer.from(key);
}

function encodeBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function protectOpaqueToken(token: string, purpose: string): string {
  const digest = createHmac('sha256', deriveKey(`opaque:${purpose}`))
    .update(token, 'utf8')
    .digest('base64url');
  return `${HASH_PREFIX}:${digest}`;
}

export function opaqueTokenCandidates(token: string, purpose: string): [string, string] {
  return [protectOpaqueToken(token, purpose), token];
}

export function matchesOpaqueToken(storedValue: string, rawToken: string, purpose: string): boolean {
  if (storedValue.startsWith(`${HASH_PREFIX}:`)) {
    return safeEqualText(storedValue, protectOpaqueToken(rawToken, purpose));
  }
  return storedValue === rawToken;
}

export function encryptStoredSecret(secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(`secret:${purpose}`), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTION_PREFIX,
    ENCRYPTION_VERSION,
    encodeBase64Url(iv),
    encodeBase64Url(ciphertext),
    encodeBase64Url(authTag),
  ].join(':');
}

export function decryptStoredSecret(storedValue: string, purpose: string): string {
  if (!storedValue.startsWith(`${ENCRYPTION_PREFIX}:${ENCRYPTION_VERSION}:`)) {
    return storedValue;
  }

  const parts = storedValue.split(':');
  if (parts.length !== 5) {
    throw new Error('Malformed encrypted secret payload');
  }

  const [, , ivPart, ciphertextPart, authTagPart] = parts;
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(`secret:${purpose}`), decodeBase64Url(ivPart));
  decipher.setAuthTag(decodeBase64Url(authTagPart));

  const plaintext = Buffer.concat([
    decipher.update(decodeBase64Url(ciphertextPart)),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
