export type TurnOutcomeKind = 'route' | 'autopilot' | 'route_monitor' | 'multi_public_read';

type TurnOutcomeState = 'pending' | 'completed' | 'failed';

export type TurnGoalLedger = {
  outcomes: Map<TurnOutcomeKind, TurnOutcomeState>;
  publicReadAttempts: number;
};

export function createTurnGoalLedger(goal: string): TurnGoalLedger {
  const normalized = goal.toLowerCase();
  const outcomes = new Map<TurnOutcomeKind, TurnOutcomeState>();
  if (hasRequestedOutcome(normalized, /\broute\b|маршрут/gu)) outcomes.set('route', 'pending');
  if (hasRequestedOutcome(normalized, /\bautopilot\b|автопилот/gu)) outcomes.set('autopilot', 'pending');
  if (hasRequestedOutcome(
    normalized,
    /online[- ]?scan|онлайн[- ]?скан|route monitor|мониторинг маршрут/gu,
  )) {
    outcomes.set('route_monitor', 'pending');
  }
  if (isExplicitMultiPublicRead(normalized)) outcomes.set('multi_public_read', 'pending');
  return { outcomes, publicReadAttempts: 0 };
}

export function recordTurnToolOutcome(
  ledger: TurnGoalLedger,
  name: string,
  args: Readonly<Record<string, unknown>>,
  rawResult: unknown,
): void {
  const result = isRecord(rawResult) ? rawResult : {};
  if (ledger.outcomes.has('multi_public_read')) {
    ledger.publicReadAttempts += attemptedPublicReads(name, result);
    if (ledger.publicReadAttempts >= 2) ledger.outcomes.set('multi_public_read', 'completed');
  }
  if (name === 'plan_route') {
    settle(ledger, 'route', result.ok === true);
    if (ledger.outcomes.has('autopilot') && args.set_autopilot === true) {
      settle(ledger, 'autopilot', result.autopilot_set === true);
    }
    if (ledger.outcomes.has('route_monitor') && args.set_autopilot === true) {
      settle(ledger, 'route_monitor', result.monitor_started === true);
    }
    return;
  }
  if (name === 'route_monitor' && ledger.outcomes.has('route_monitor')) {
    settle(ledger, 'route_monitor', result.active === true || result.stopped === true);
  }
}

export function pendingTurnOutcomes(ledger: TurnGoalLedger): TurnOutcomeKind[] {
  return [...ledger.outcomes.entries()]
    .filter(([, state]) => state === 'pending')
    .map(([kind]) => kind);
}

export function buildTurnCompletionNudge(pending: readonly TurnOutcomeKind[]): string {
  return `[system] The turn cannot finish yet. Still-unhandled requested outcomes: ${pending.join(', ')}. `
    + 'Call the required tools now, or attempt them once and report a bounded failure. Do not repeat completed work.';
}

function settle(ledger: TurnGoalLedger, kind: TurnOutcomeKind, completed: boolean): void {
  if (!ledger.outcomes.has(kind)) return;
  ledger.outcomes.set(kind, completed ? 'completed' : 'failed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExplicitMultiPublicRead(goal: string): boolean {
  const conjunction = /\s(?:и|and)\s/u.test(goal);
  if (!conjunction) return false;
  if (hasRequestedOutcome(
    goal,
    /маршрут|\broute\b|автопилот|\bautopilot\b|онлайн[- ]?скан|online[- ]?scan/gu,
  )) return false;
  return /(сколько|посчитай|количеств|count|сравн|compare|цен|price|истори|history|покажи|show|get|получи)/u.test(goal)
    || /(?:^|\s)1[).].*(?:^|\s)2[).]/su.test(goal);
}

function hasRequestedOutcome(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = currentContrastClause(text.slice(Math.max(0, start - 120), start));
    const after = text.slice(end, Math.min(text.length, end + 40));
    const negatedBefore = /(?:(?:^|[\s,:;([])(?:не|без)(?:\s|$)|\bdo not\b|\bdon't\b|\bnever\b|\bwithout\b|\bno\b)[^.!?\n]{0,64}$/u.test(before)
      && !/(?:^|[\s,:;([])не\s+только(?:\s|$)[^.!?\n]{0,64}$/u.test(before);
    const negatedAfter = /^[^.!?\n]{0,24}(?:не\s+(?:нужен|нужно|надо|включай|включать|используй|использовать)(?:\s|$)|\bis not needed\b|\bdo not\b)/u.test(after);
    if (!negatedBefore && !negatedAfter) return true;
  }
  return false;
}

function currentContrastClause(value: string): string {
  const boundaries = [
    ...value.matchAll(/(?:[.!?;\n]|,\s*(?:но|однако|зато)\s+|\b(?:but|however|instead)\b)/gu),
  ];
  const last = boundaries.at(-1);
  if (!last || last.index === undefined) return value;
  return value.slice(last.index + last[0].length);
}

function attemptedPublicReads(name: string, result: Record<string, unknown>): number {
  if (name === 'local_parallel_batch' && Array.isArray(result.results)) {
    return result.results.filter((entry) => {
      if (!isRecord(entry) || !isRecord(entry.output)) return false;
      return entry.output.ok === true;
    }).length;
  }
  if (name === 'delegate_read_subagents' && Array.isArray(result.results)) {
    return result.results.filter((entry) => isRecord(entry) && entry.status === 'completed').length;
  }
  if (name === 'sde_sql') {
    if (result.ok === false) return 0;
    const rows = Array.isArray(result.rows) ? result.rows : Array.isArray(result.data) ? result.data : [];
    return rows.length >= 2 ? 2 : 1;
  }
  if (name === 'batch_market_prices' && Array.isArray(result.prices)) {
    return result.prices.filter((entry) => isRecord(entry) && entry.error == null).length >= 2 ? 2 : 1;
  }
  for (const key of ['data', 'items', 'systems', 'types']) {
    if (Array.isArray(result[key]) && result[key].length >= 2) return 2;
  }
  return new Set([
    'count_universe_objects',
    'batch_market_prices',
    'market_history_summary',
    'system_metric_snapshot',
    'dynamic_item_summary',
    'compare_wormhole_types',
    'scout_systems',
    'kill_activity_summary',
    'doctrine_summary',
  ]).has(name) && result.ok === true ? 1 : 0;
}
