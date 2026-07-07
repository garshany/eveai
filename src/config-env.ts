/**
 * Strict environment-variable parsing helpers.
 *
 * Fail fast on malformed integers/booleans instead of silently coercing them
 * (e.g. "3000.5" -> 3000, "1e3" -> 1000, an unsafe integer, or a typo'd
 * boolean). Adapted from the config-hardening work in PR #9.
 */
export type EnvSource = Record<string, string | undefined>;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

export function readRequiredEnv(env: EnvSource, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return raw.trim();
}

export function readOptionalEnv(env: EnvSource, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

export function parseRequiredIntEnv(env: EnvSource, name: string): number {
  return parseInteger(name, readRequiredEnv(env, name));
}

export function parseOptionalIntEnv(env: EnvSource, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return parseInteger(name, raw.trim());
}

export function parseOptionalBooleanEnv(env: EnvSource, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  throw new Error(
    `Env var ${name} must be a boolean value: true/false, 1/0, yes/no, or on/off; got: "${raw}"`,
  );
}

function parseInteger(name: string, value: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new Error(`Env var ${name} must be an integer, got: "${value}"`);
  }

  const num = Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Env var ${name} must be a safe integer, got: "${value}"`);
  }

  return num;
}
