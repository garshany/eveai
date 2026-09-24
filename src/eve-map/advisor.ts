/**
 * Perimeter advisor — the part that speaks first.
 *
 * Rules are deterministic and produce a finished, localized sentence with no
 * model call. That is a cost decision as much as a latency one: a pilot flying
 * for an hour generates hundreds of position ticks, and a feature that spent a
 * model call on each of them would be unshippable. The model is asked for prose
 * only when a rule fired, the situation clears an escalation bar, and a
 * cooldown has elapsed.
 *
 * Every advisory carries an anchor (system, killmail, rule) so the chat message
 * stays clickable and the map can fly to what the sentence is about.
 */

import { config } from '../config.js';
import type { BubblePayload, BubbleSystem } from './bubble.js';
import type { IndexedKill } from './kill-index.js';
import type { DangerBand } from './danger.js';

export type AdvisorySeverity = 'info' | 'warn' | 'danger';

export type AdvisoryRule =
  | 'pursuit'
  | 'camp_next_hop'
  | 'threat_rise'
  | 'value_spike'
  | 'capability_gap'
  | 'route_degraded'
  | 'all_clear'
  | 'security_band';

export type Advisory = {
  rule: AdvisoryRule;
  severity: AdvisorySeverity;
  /** Localized message keys with parameters; the web layer renders both locales. */
  text: { ru: string; en: string };
  systemId: number | null;
  killmailId: number | null;
  /** Collapsed repeats of the same condition inside one cooldown window. */
  repeats: number;
  /**
   * Identity of the *situation*, not of the message. Two warnings with the same
   * key are the same ongoing fact and must not be said twice; a changed key
   * (a different camped system, a different hunter) is genuinely new news.
   */
  stateKey: string;
  at: string;
};

export type AdvisorState = {
  /** Systems the pilot has actually passed through, newest last. */
  trail: number[];
  lastBand: DangerBand | null;
  lastSecurityBand: 'high' | 'low' | 'null' | null;
  /** rule → last emission timestamp in ms. */
  cooldowns: Map<AdvisoryRule, number>;
  /** rule → suppressed repeats since the last emission. */
  suppressed: Map<AdvisoryRule, number>;
  lastModelCallMs: number;
  seenKillIds: Set<number>;
  quietSinceMs: number | null;
  /**
   * Level rules currently holding: rule -> the situation key and when it was
   * last observed. This is what stops "ОН ТЕБЯ ДОГОНИТ" from arriving every
   * minute for ten minutes while nothing about the situation changed.
   */
  held: Map<AdvisoryRule, { key: string; lastSeenMs: number }>;
};

export type AdvisorContext = {
  bubble: BubblePayload;
  currentSystemId: number;
  /** Systems of the active route ahead of the pilot, in order. */
  routeAhead: number[];
  /** Killmails that arrived since the previous evaluation. */
  newKills: IndexedKill[];
  now: number;
};

const VALUE_SPIKE_ISK = 1_000_000_000;
const PURSUIT_MIN_SYSTEMS = 2;
const ALL_CLEAR_QUIET_MS = 15 * 60_000;
const MAX_TRAIL = 20;

const SEVERITY_ORDER: Record<AdvisorySeverity, number> = { info: 0, warn: 1, danger: 2 };

/**
 * Level rules describe a condition that persists — you are outgunned here, this
 * gate is camped, your route is red. Announcing a persisting condition on a
 * timer is how a useful warning turns into noise the pilot learns to ignore: in
 * one real flight the same capability-gap line arrived eight times in ten
 * minutes. They are said once when they become true, and again only when the
 * situation itself changes or has been gone long enough to be news again.
 *
 * Everything else is an edge: a specific kill, a band crossing, a transition.
 * Those are already one-shot by construction.
 */
const LEVEL_RULES: ReadonlySet<AdvisoryRule> = new Set<AdvisoryRule>([
  'pursuit',
  'camp_next_hop',
  'capability_gap',
  'route_degraded',
]);

/**
 * A level rule that stops holding is only re-armed after this long, so a
 * condition flickering across the threshold cannot re-announce itself.
 */
const REARM_AFTER_MS = 10 * 60_000;

/**
 * One advisor state per character, shared by every stream watching them.
 *
 * Per-stream state meant three open tabs each evaluated the same rules against
 * the same position and each persisted the same warning into the same thread —
 * the pilot got the camp warning three times and paid three bubble rebuilds
 * for it. Cooldowns only mean something when they are shared.
 */
const sharedStates = new Map<number, { state: AdvisorState; refs: number; idleSinceMs: number | null }>();

/**
 * How long a state survives with nobody attached.
 *
 * Dropping it the instant the last stream closed looked tidy and was wrong: an
 * SSE reconnect — a radius change, a dropped socket, a page navigation — built a
 * fresh state with empty cooldowns, and the same warning fired again seconds
 * later. Production showed the identical capability-gap advisory three times in
 * eighty seconds. Cooldowns only work if they outlive the connection.
 */
const STATE_GRACE_MS = 15 * 60_000;

export function getSharedAdvisorState(characterId: number, now = Date.now()): AdvisorState {
  const existing = sharedStates.get(characterId);
  if (existing && (existing.idleSinceMs === null || now - existing.idleSinceMs < STATE_GRACE_MS)) {
    existing.refs += 1;
    existing.idleSinceMs = null;
    return existing.state;
  }
  const state = createAdvisorState(now);
  sharedStates.set(characterId, { state, refs: 1, idleSinceMs: null });
  return state;
}

/** Marks the state idle rather than deleting it, so a reconnect keeps its cooldowns. */
export function releaseSharedAdvisorState(characterId: number, now = Date.now()): void {
  const existing = sharedStates.get(characterId);
  if (!existing) return;
  existing.refs -= 1;
  if (existing.refs <= 0) {
    existing.refs = 0;
    existing.idleSinceMs = now;
  }
  // Opportunistic sweep: this map is keyed by character and would otherwise
  // grow for the lifetime of the process.
  for (const [key, entry] of sharedStates) {
    if (entry.refs === 0 && entry.idleSinceMs !== null && now - entry.idleSinceMs > STATE_GRACE_MS) {
      sharedStates.delete(key);
    }
  }
}

/** Live references held on a character's shared state, or null when none exists. */
export function sharedAdvisorRefsForTests(characterId: number): number | null {
  return sharedStates.get(characterId)?.refs ?? null;
}

export function resetSharedAdvisorStatesForTests(): void {
  sharedStates.clear();
}

export function createAdvisorState(now = Date.now()): AdvisorState {
  return {
    trail: [],
    lastBand: null,
    lastSecurityBand: null,
    cooldowns: new Map(),
    suppressed: new Map(),
    lastModelCallMs: 0,
    seenKillIds: new Set(),
    quietSinceMs: now,
    held: new Map(),
  };
}

/**
 * Evaluate every rule and return only the advisories that survived their
 * cooldown. A rule that fires while still cooling down increments a counter
 * instead of producing a second message: the pilot gets "×4", not four lines.
 */
export function evaluateAdvisories(state: AdvisorState, input: AdvisorContext): Advisory[] {
  recordTrail(state, input.currentSystemId);
  // The state is shared by every tab watching this pilot, and each tab hands
  // the same pushed kill to its own evaluation. Judging it twice used to feed
  // the second pass into the cooldown as a "suppressed repeat", so the next
  // genuine warning arrived as "×2" for something that happened once.
  const freshKills = input.newKills.filter((kill) => !state.seenKillIds.has(kill.killmailId));
  for (const kill of freshKills) state.seenKillIds.add(kill.killmailId);
  trimSeen(state);
  const ctx: AdvisorContext = { ...input, newKills: freshKills };

  const systemsById = new Map(ctx.bubble.systems.map((system) => [system.systemId, system]));
  const candidates: Advisory[] = [];

  const pursuit = detectIdentityPursuit(state, ctx);
  if (pursuit) candidates.push(pursuit);

  const camp = detectCampAhead(ctx, systemsById);
  if (camp) candidates.push(camp);

  const rise = detectThreatRise(state, ctx);
  if (rise) candidates.push(rise);

  const spike = detectValueSpike(ctx, systemsById);
  if (spike) candidates.push(spike);

  const gap = detectCapabilityGap(ctx, systemsById);
  if (gap) candidates.push(gap);

  const route = detectRouteDegraded(ctx, systemsById);
  if (route) candidates.push(route);

  const security = detectSecurityBand(state, ctx, systemsById);
  if (security) candidates.push(security);

  const clear = detectAllClear(state, ctx);
  if (clear) candidates.push(clear);

  // A level rule that produced nothing this pass has stopped holding. It is not
  // forgotten immediately: re-arming instantly would let a condition sitting on
  // the threshold announce itself every other tick.
  const firedRules = new Set(candidates.map((advisory) => advisory.rule));
  for (const [rule, entry] of state.held) {
    if (firedRules.has(rule)) continue;
    if (ctx.now - entry.lastSeenMs >= REARM_AFTER_MS) state.held.delete(rule);
  }

  const emitted: Advisory[] = [];
  for (const advisory of candidates) {
    if (LEVEL_RULES.has(advisory.rule)) {
      const held = state.held.get(advisory.rule);
      state.held.set(advisory.rule, { key: advisory.stateKey, lastSeenMs: ctx.now });
      if (held && held.key === advisory.stateKey) {
        // Same fact, still true. Already said.
        state.suppressed.set(advisory.rule, (state.suppressed.get(advisory.rule) ?? 0) + 1);
        continue;
      }
    } else if (!passesCooldown(state, advisory, ctx.now)) {
      state.suppressed.set(advisory.rule, (state.suppressed.get(advisory.rule) ?? 0) + 1);
      continue;
    }
    advisory.repeats = state.suppressed.get(advisory.rule) ?? 0;
    state.suppressed.delete(advisory.rule);
    state.cooldowns.set(advisory.rule, ctx.now);
    emitted.push(advisory);
  }

  // Loudest first: a pilot glancing at the panel mid-jump should read the
  // thing that can kill them, not the thing that happened to sort first.
  emitted.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
  return emitted;
}

/**
 * Whether these advisories justify spending a model call on prose. Bar: at
 * least one `danger`, or a pursuit at any severity, plus the LLM cooldown.
 * Everything below that ships as the deterministic sentence, which is already
 * complete and correct — the model adds tone, not facts.
 */
export function shouldEscalateToModel(
  state: AdvisorState,
  advisories: Advisory[],
  now: number,
): boolean {
  if (advisories.length === 0) return false;
  const cooldownMs = config.map.advisorLlmCooldownSeconds * 1000;
  if (now - state.lastModelCallMs < cooldownMs) return false;
  return advisories.some((advisory) => advisory.severity === 'danger' || advisory.rule === 'pursuit');
}

export function markModelCall(state: AdvisorState, now: number): void {
  state.lastModelCallMs = now;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Pursuit by identity rather than by geometry: the same attacker characters
 * turning up in kills across systems the pilot has just left. This is stronger
 * than "kills are getting closer", because it survives a pilot who changes
 * direction, and it names the hunters.
 */
function detectIdentityPursuit(state: AdvisorState, ctx: AdvisorContext): Advisory | null {
  if (state.trail.length < PURSUIT_MIN_SYSTEMS) return null;
  const recentTrail = new Set(state.trail.slice(-5));

  const bySystem = new Map<number, Set<number>>();
  const names = new Map<number, string>();
  for (const kill of ctx.bubble.recentKills) {
    if (kill.isNpc || kill.finalBlowCharacterId === null) continue;
    if (!recentTrail.has(kill.systemId)) continue;
    const set = bySystem.get(kill.finalBlowCharacterId) ?? new Set<number>();
    set.add(kill.systemId);
    bySystem.set(kill.finalBlowCharacterId, set);
    if (kill.finalBlowCharacterName) names.set(kill.finalBlowCharacterId, kill.finalBlowCharacterName);
  }

  const hunters = [...bySystem.entries()]
    .filter(([, systems]) => systems.size >= PURSUIT_MIN_SYSTEMS)
    .map(([characterId]) => names.get(characterId) ?? `#${characterId}`);
  if (hunters.length === 0) return null;

  const label = hunters.slice(0, 3).join(', ');
  return {
    rule: 'pursuit',
    severity: 'danger',
    text: {
      ru: `Один и тот же стрелок засветился в нескольких системах у тебя за спиной: ${label}. Похоже на преследование.`,
      en: `The same attacker turned up in several systems behind you: ${label}. This looks like a pursuit.`,
    },
    systemId: ctx.currentSystemId,
    killmailId: null,
    repeats: 0,
    stateKey: `pursuit:${hunters.slice(0, 3).sort().join('|')}`,
    at: new Date(ctx.now).toISOString(),
  };
}

function detectCampAhead(
  ctx: AdvisorContext,
  systemsById: Map<number, BubbleSystem>,
): Advisory | null {
  // "Ahead" is the route when there is one, and everything one jump away when
  // there is not — a pilot without a destination still needs the warning.
  const ahead = ctx.routeAhead.length > 0
    ? ctx.routeAhead.slice(0, 2)
    : ctx.bubble.systems.filter((system) => system.jumps === 1).map((system) => system.systemId);

  let worst: { system: BubbleSystem; camp: number } | null = null;
  for (const systemId of ahead) {
    const system = systemsById.get(systemId);
    if (!system) continue;
    const camp = system.gateCamps.reduce((max, gate) => Math.max(max, gate.killCount), 0);
    if (camp < 2) continue;
    if (!worst || camp > worst.camp) worst = { system, camp };
  }
  if (!worst) return null;

  return {
    rule: 'camp_next_hop',
    severity: 'danger',
    text: {
      ru: `${worst.system.name}: ${worst.camp} труп(а) на одном гейте за последний час. Это кемп, а не случайность.`,
      en: `${worst.system.name}: ${worst.camp} kill(s) on a single gate in the last hour. That is a camp, not noise.`,
    },
    systemId: worst.system.systemId,
    killmailId: null,
    repeats: 0,
    stateKey: `camp:${worst.system.systemId}`,
    at: new Date(ctx.now).toISOString(),
  };
}

function detectThreatRise(state: AdvisorState, ctx: AdvisorContext): Advisory | null {
  const band = ctx.bubble.verdict.band as DangerBand;
  const previous = state.lastBand;
  state.lastBand = band;
  if (previous === null) return null;
  if (rank(band) <= rank(previous)) return null;

  const worst = ctx.bubble.systems.find((system) => system.systemId === ctx.bubble.verdict.worstSystemId);
  const where = worst ? ` Хуже всего в ${worst.name} (${worst.jumps} пр.).` : '';
  const whereEn = worst ? ` Worst is ${worst.name}, ${worst.jumps} jump(s) out.` : '';
  return {
    rule: 'threat_rise',
    severity: rank(band) >= rank('hostile') ? 'danger' : 'warn',
    text: {
      ru: `Периметр поднялся: ${translateBand(previous)} → ${translateBand(band)}.${where}`,
      en: `Perimeter threat rose: ${previous} → ${band}.${whereEn}`,
    },
    systemId: worst?.systemId ?? null,
    killmailId: null,
    repeats: 0,
    stateKey: `rise:${previous}->${band}`,
    at: new Date(ctx.now).toISOString(),
  };
}

function detectValueSpike(
  ctx: AdvisorContext,
  systemsById: Map<number, BubbleSystem>,
): Advisory | null {
  let biggest: IndexedKill | null = null;
  for (const kill of ctx.newKills) {
    if (kill.isNpc || kill.totalValue < VALUE_SPIKE_ISK) continue;
    if (!biggest || kill.totalValue > biggest.totalValue) biggest = kill;
  }
  if (!biggest) return null;
  const system = systemsById.get(biggest.systemId);
  const name = system?.name ?? `System ${biggest.systemId}`;
  const jumps = system ? `${system.jumps}` : '?';
  const billions = (biggest.totalValue / 1_000_000_000).toFixed(1);
  return {
    rule: 'value_spike',
    severity: 'warn',
    text: {
      ru: `В ${name} (${jumps} пр.) выбили ${biggest.victimShipName ?? 'корабль'} на ${billions} млрд. Туда сейчас слетится народ.`,
      en: `A ${biggest.victimShipName ?? 'ship'} worth ${billions}B just died in ${name} (${jumps} jumps). Expect a crowd.`,
    },
    systemId: biggest.systemId,
    killmailId: biggest.killmailId,
    repeats: 0,
    stateKey: `value:${biggest.killmailId}`,
    at: new Date(ctx.now).toISOString(),
  };
}

function detectCapabilityGap(
  ctx: AdvisorContext,
  systemsById: Map<number, BubbleSystem>,
): Advisory | null {
  const ship = ctx.bubble.pilotShip;
  if (!ship) return null;
  if (ship.survivalChance !== 'DEAD' && ship.survivalChance !== 'UNLIKELY') return null;

  // Only worth saying when something nearby is actually shooting.
  const near = ctx.bubble.systems.filter(
    (system) => system.jumps <= 2 && system.activity.pvpKills1h > 0,
  );
  if (near.length === 0) return null;
  const worst = near.reduce((a, b) => (b.danger.score > a.danger.score ? b : a));
  void systemsById;

  return {
    rule: 'capability_gap',
    severity: 'danger',
    text: {
      ru: `${ship.shipName} против того, что стреляет в ${worst.name}: шансы «${ship.survivalChance.toLowerCase()}». `
        + `EHP ${Math.round(ship.ehp)}, схождение ${ship.alignTime.toFixed(1)} с.`,
      en: `${ship.shipName} against what is shooting in ${worst.name}: survival ${ship.survivalChance.toLowerCase()}. `
        + `${Math.round(ship.ehp)} EHP, ${ship.alignTime.toFixed(1)}s align.`,
    },
    systemId: worst.systemId,
    killmailId: null,
    repeats: 0,
    stateKey: `gap:${ship.shipTypeId}:${worst.systemId}`,
    at: new Date(ctx.now).toISOString(),
  };
}

function detectRouteDegraded(
  ctx: AdvisorContext,
  systemsById: Map<number, BubbleSystem>,
): Advisory | null {
  if (ctx.routeAhead.length === 0) return null;
  let worst: BubbleSystem | null = null;
  let index = -1;
  for (let i = 0; i < ctx.routeAhead.length; i += 1) {
    const system = systemsById.get(ctx.routeAhead[i]!);
    if (!system) continue;
    if (system.danger.band !== 'hostile' && system.danger.band !== 'lethal') continue;
    if (!worst || system.danger.score > worst.danger.score) {
      worst = system;
      index = i + 1;
    }
  }
  if (!worst) return null;
  return {
    rule: 'route_degraded',
    severity: 'danger',
    text: {
      ru: `Маршрут покраснел на ${index}-м прыжке: ${worst.name}. Могу пересчитать в обход.`,
      en: `Your route went red at hop ${index}: ${worst.name}. I can reroute around it.`,
    },
    systemId: worst.systemId,
    killmailId: null,
    repeats: 0,
    stateKey: `route:${worst.systemId}`,
    at: new Date(ctx.now).toISOString(),
  };
}

function detectSecurityBand(
  state: AdvisorState,
  ctx: AdvisorContext,
  systemsById: Map<number, BubbleSystem>,
): Advisory | null {
  const current = systemsById.get(ctx.currentSystemId);
  if (!current) return null;
  const band = current.security >= 0.45 ? 'high' : current.security > 0 ? 'low' : 'null';
  const previous = state.lastSecurityBand;
  state.lastSecurityBand = band;
  if (previous === null || previous === band) return null;
  // Only the downgrade is worth interrupting for; re-entering highsec is a
  // relief, not a warning.
  if (previous === 'high' && band !== 'high') {
    return {
      rule: 'security_band',
      severity: 'warn',
      text: {
        ru: `${current.name}: ты вышел из хайсека. CONCORD сюда не придёт.`,
        en: `${current.name}: you have left highsec. CONCORD will not come here.`,
      },
      systemId: current.systemId,
      killmailId: null,
      repeats: 0,
      stateKey: `security:high->${band}`,
      at: new Date(ctx.now).toISOString(),
    };
  }
  if (previous === 'low' && band === 'null') {
    return {
      rule: 'security_band',
      severity: 'warn',
      text: {
        ru: `${current.name}: нули. Здесь можно всё и всем.`,
        en: `${current.name}: nullsec. No rules of engagement at all.`,
      },
      systemId: current.systemId,
      killmailId: null,
      repeats: 0,
      stateKey: 'security:low->null',
      at: new Date(ctx.now).toISOString(),
    };
  }
  return null;
}

function detectAllClear(state: AdvisorState, ctx: AdvisorContext): Advisory | null {
  const band = ctx.bubble.verdict.band as DangerBand;
  const quiet = band === 'calm' || band === 'watch';
  if (!quiet) {
    state.quietSinceMs = null;
    return null;
  }
  if (state.quietSinceMs === null) {
    state.quietSinceMs = ctx.now;
    return null;
  }
  if (ctx.now - state.quietSinceMs < ALL_CLEAR_QUIET_MS) return null;
  state.quietSinceMs = ctx.now;
  return {
    rule: 'all_clear',
    severity: 'info',
    text: {
      ru: 'Чисто. За последние 15 минут в периметре ничего не происходило.',
      en: 'All clear. Nothing has happened in the perimeter for fifteen minutes.',
    },
    systemId: ctx.currentSystemId,
    killmailId: null,
    repeats: 0,
    stateKey: 'clear',
    at: new Date(ctx.now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passesCooldown(state: AdvisorState, advisory: Advisory, now: number): boolean {
  const last = state.cooldowns.get(advisory.rule);
  if (last === undefined) return true;
  // Danger cools down faster than chatter: a camp warning that arrives a minute
  // late is worthless, an "all clear" can wait.
  const factor = advisory.severity === 'danger' ? 1 : advisory.severity === 'warn' ? 2 : 5;
  return now - last >= config.map.advisorCooldownSeconds * 1000 * factor;
}

function recordTrail(state: AdvisorState, systemId: number): void {
  if (state.trail[state.trail.length - 1] === systemId) return;
  state.trail.push(systemId);
  if (state.trail.length > MAX_TRAIL) state.trail.splice(0, state.trail.length - MAX_TRAIL);
}

function trimSeen(state: AdvisorState): void {
  if (state.seenKillIds.size <= 2000) return;
  // Unbounded growth over a long flight; the set only guards against
  // re-announcing, so dropping the oldest half is harmless.
  const ids = [...state.seenKillIds];
  state.seenKillIds = new Set(ids.slice(ids.length - 1000));
}

function rank(band: DangerBand): number {
  switch (band) {
    case 'lethal': return 4;
    case 'hostile': return 3;
    case 'elevated': return 2;
    case 'watch': return 1;
    default: return 0;
  }
}

function translateBand(band: DangerBand): string {
  switch (band) {
    case 'lethal': return 'смертельно';
    case 'hostile': return 'враждебно';
    case 'elevated': return 'повышенный';
    case 'watch': return 'внимание';
    default: return 'спокойно';
  }
}
