import type { EveKillKillmail } from '../eve-kill/types.js';
import type { RouteThreatDigest } from './types.js';

export type KillPosition = { x: number; y: number; z: number };

export function extractKillPosition(killmail: EveKillKillmail): KillPosition | null {
  const raw = killmail as Record<string, unknown>;
  const nested = asRec(raw.position);
  const x = numOrNull(raw.x) ?? numOrNull(nested.x);
  const y = numOrNull(raw.y) ?? numOrNull(nested.y);
  const z = numOrNull(raw.z) ?? numOrNull(nested.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

export function collectNewKillmailIds(
  seenKillmailIds: Set<number>,
  kills: Array<{ killmail_id: number }>,
): Set<number> {
  const fresh = new Set<number>();
  for (const kill of kills) {
    if (seenKillmailIds.has(kill.killmail_id)) continue;
    seenKillmailIds.add(kill.killmail_id);
    fresh.add(kill.killmail_id);
  }
  return fresh;
}

export function shouldSendDigestHeartbeat(
  lastDigestTime: number,
  digest: RouteThreatDigest,
  gankerCount: number,
  heartbeatMs: number,
): boolean {
  if (Date.now() - lastDigestTime < heartbeatMs) {
    return false;
  }

  if (digest.overallThreat !== 'LOW') {
    return true;
  }

  const systems = [...digest.systemsAhead, ...digest.systemsBehind];
  if (gankerCount > 0) return true;

  return systems.some((system) =>
    system.recentKills.length > 0
    || system.gateKills.length > 0
    || system.gankerCount > 0
    || system.jumpSpike !== null,
  );
}

function asRec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
