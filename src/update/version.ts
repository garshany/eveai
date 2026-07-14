import { readFileSync } from 'node:fs';

const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

export function getAppVersion(): string {
  const parsed = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string' || !parseStableVersion(parsed.version)) {
    throw new Error('package.json contains an invalid stable version');
  }
  return parsed.version;
}

export function parseStableVersion(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

export function compareStableVersions(left: string, right: string): -1 | 0 | 1 {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) throw new Error('Cannot compare invalid stable versions');
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return 0;
}
