/**
 * The latest radar picture per character, kept in memory by the live stream.
 *
 * The Perimeter chat must answer "стоит ли лететь?" knowing where the pilot is
 * and what the radar shows *right now*, without a clarifying question and
 * without the model having to guess that it should call map_bubble_intel
 * first. The live stream already builds that picture every few seconds; this
 * store lets the agent turn read it for free (no ESI call, no bubble rebuild).
 *
 * Only the pilot's own situation and public killmail intel go in. A snapshot
 * older than MAX_AGE_MS is treated as absent: a closed map must not keep
 * feeding a stale position into answers.
 */

import type { Advisory } from './advisor.js';
import type { BubblePayload } from './bubble.js';
import type { LiveLocation } from './live-session.js';

export type RadarSnapshot = {
  characterId: number;
  location: LiveLocation | null;
  bubble: {
    originId: number;
    originName: string | null;
    radius: number;
    verdict: BubblePayload['verdict'];
    worstSystemName: string | null;
    hot: Array<{ name: string; jumps: number; security: number; band: string; kills15m: number; kills1h: number; gateCamps: number }>;
    pilotShip: string | null;
    builtAt: string;
  } | null;
  advisories: Array<{ rule: string; severity: string; text: string; at: string }>;
  updatedAtMs: number;
};

const MAX_AGE_MS = 5 * 60_000;
const MAX_ADVISORIES = 5;
const MAX_HOT_SYSTEMS = 5;

const snapshots = new Map<number, RadarSnapshot>();

function ensure(characterId: number, now: number): RadarSnapshot {
  let snapshot = snapshots.get(characterId);
  if (!snapshot) {
    snapshot = { characterId, location: null, bubble: null, advisories: [], updatedAtMs: now };
    snapshots.set(characterId, snapshot);
  }
  snapshot.updatedAtMs = now;
  return snapshot;
}

export function recordRadarLocation(location: LiveLocation, now = Date.now()): void {
  ensure(location.characterId, now).location = location;
}

export function recordRadarBubble(characterId: number, bubble: BubblePayload, now = Date.now()): void {
  const byId = new Map(bubble.systems.map((system) => [system.systemId, system]));
  const hot = bubble.systems
    .filter((system) => system.danger.score > 0)
    .sort((left, right) => right.danger.score - left.danger.score)
    .slice(0, MAX_HOT_SYSTEMS)
    .map((system) => ({
      name: system.name,
      jumps: system.jumps,
      security: system.security,
      band: system.danger.band,
      kills15m: system.activity.kills15m,
      kills1h: system.activity.kills1h,
      gateCamps: system.gateCamps.length,
    }));
  ensure(characterId, now).bubble = {
    originId: bubble.originId,
    originName: byId.get(bubble.originId)?.name ?? null,
    radius: bubble.radius,
    verdict: bubble.verdict,
    worstSystemName: bubble.verdict.worstSystemId === null
      ? null
      : byId.get(bubble.verdict.worstSystemId)?.name ?? null,
    hot,
    pilotShip: bubble.pilotShip?.shipName ?? null,
    builtAt: bubble.builtAt,
  };
}

export function recordRadarAdvisory(
  characterId: number,
  advisory: Advisory,
  text: string,
  now = Date.now(),
): void {
  const snapshot = ensure(characterId, now);
  snapshot.advisories.push({ rule: advisory.rule, severity: advisory.severity, text, at: advisory.at });
  if (snapshot.advisories.length > MAX_ADVISORIES) snapshot.advisories.splice(0, snapshot.advisories.length - MAX_ADVISORIES);
}

export function getRadarSnapshot(characterId: number, now = Date.now()): RadarSnapshot | null {
  const snapshot = snapshots.get(characterId);
  if (!snapshot) return null;
  if (now - snapshot.updatedAtMs > MAX_AGE_MS) {
    snapshots.delete(characterId);
    return null;
  }
  return snapshot;
}

export function resetRadarSnapshotsForTests(): void {
  snapshots.clear();
}

/**
 * Plain-text block for the agent's runtime context. Null when there is nothing
 * fresh to say, so a closed map adds nothing to the prompt.
 */
export function formatRadarSnapshot(characterId: number, now = Date.now()): string | null {
  const snapshot = getRadarSnapshot(characterId, now);
  if (!snapshot || (!snapshot.location && !snapshot.bubble)) return null;
  const lines: string[] = [`Perimeter radar (live map open, updated ${Math.round((now - snapshot.updatedAtMs) / 1000)}s ago):`];
  const bubble = snapshot.bubble;
  if (snapshot.location) {
    const place = snapshot.location.stationId !== null || snapshot.location.structureId !== null ? 'docked' : 'in space';
    const system = bubble && bubble.originId === snapshot.location.solarSystemId && bubble.originName
      ? `${bubble.originName} (system_id=${snapshot.location.solarSystemId})`
      : `system_id=${snapshot.location.solarSystemId}`;
    lines.push(`- Pilot: ${system}, ${place}, ${snapshot.location.online ? 'online' : 'offline'}${snapshot.location.shipName || bubble?.pilotShip ? `, hull ${bubble?.pilotShip ?? snapshot.location.shipName}` : ''}.`);
  }
  if (bubble) {
    lines.push(`- Bubble ${bubble.radius} jumps around ${bubble.originName ?? bubble.originId}: verdict ${bubble.verdict.band} (${Math.round(bubble.verdict.score * 100)}%)${bubble.worstSystemName ? `, worst ${bubble.worstSystemName}` : ''}.`);
    for (const system of bubble.hot) {
      lines.push(`  - ${system.name}: ${system.jumps} jumps, sec ${system.security.toFixed(1)}, ${system.band}, kills 15m/1h ${system.kills15m}/${system.kills1h}${system.gateCamps > 0 ? `, gate camp kills ${system.gateCamps}` : ''}`);
    }
  }
  if (snapshot.advisories.length > 0) {
    lines.push('- Latest radar alarms (newest last):');
    for (const advisory of snapshot.advisories) {
      lines.push(`  - [${advisory.severity}] ${advisory.text}`);
    }
  }
  lines.push('Use map_bubble_intel for per-system detail; this snapshot is a summary.');
  return lines.join('\n');
}
