import type { Db } from '../db/sqlite.js';
import { executeUniverseObjectCount } from './tools.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('executor');

export type StaticAggregateLocationContext = {
  systemName: string;
  security: number | null;
  constellationName: string | null;
  regionName: string | null;
};

type LiveContextNeeds = {
  location: boolean;
  ship: boolean;
};

type StaticAggregateObjectKind = 'constellations' | 'systems' | 'planets' | 'moons' | 'asteroid_belts' | 'stations' | 'stargates';
type StaticAggregateTargetKind = 'system' | 'constellation' | 'region';

type StaticAggregateIntent = {
  objectKind: StaticAggregateObjectKind;
  targetKind: StaticAggregateTargetKind;
  targetName: string;
};

export function deriveLiveContextNeeds(goal: string): LiveContextNeeds {
  const normalized = goal.toLowerCase();
  const ship = /(мой корабль|мой шип|на чем я|на чём я|какой у меня корабль|какой у меня шип|my ship|what ship|летаю)/u.test(normalized)
    // Scan / intel / threat triggers — need ship for tactical context
    || /\b(d-?scan|дскан|скан|fleet comp|флит|угроз|threat|hostile|враг|intel|разведк|гейткемп|gatecamp|кемп|пвп|pvp|ганк|gank)\b/u.test(normalized)
    // Paste detection: tab-separated lines likely a scan paste
    || (normalized.includes('\t') && normalized.split('\n').length >= 3);
  const location = ship
    || /\b(где я|мой регион|моя система|мо[её] созвездие|my region|my system|my constellation|current region|current system|current constellation|отсюда|from here|here|здесь)\b/u.test(normalized)
    || /\b(маршрут|route|автопилот|autopilot)\b/u.test(normalized)
    || /в мо[её]м регионе/u.test(normalized)
    || /в мо[её]й системе/u.test(normalized)
    || /в мо[её]м созвездии/u.test(normalized)
    || /в текущ(?:ем|ей)\s+(?:регионе|системе|созвездии)/u.test(normalized);

  return { location, ship };
}

export function isSimpleStaticAggregateCountGoal(goal: string): boolean {
  return detectStaticAggregateObjectKind(goal) !== null;
}

function extractStaticAggregateObjectScope(normalized: string): string {
  return normalized
    .replace(/^(?:сколько|посчитай|подсчитай|количеств[оа]|how many|count|number of)\s+/u, '')
    .replace(/\s+(?:are\s+)?(?:в|in)\s+.+$/u, '')
    .trim();
}

export function detectStaticAggregateObjectKind(goal: string): StaticAggregateObjectKind | null {
  const normalized = goal.toLowerCase();
  if (!/(сколько|посчитай|подсчитай|количеств[оа]|how many|count|number of)/u.test(normalized)) {
    return null;
  }
  const objectScope = extractStaticAggregateObjectScope(normalized);
  if (!objectScope) return null;
  if (/\b(какие|какая|какой|где|почему|зачем|how|which|why|where|market|price|route|маршрут|цена|ордер|рынок)\b/u.test(objectScope)) {
    return null;
  }
  if (/\sи\s/u.test(objectScope)) {
    return null;
  }

  const matches: StaticAggregateObjectKind[] = [];
  if (/созвезд/u.test(objectScope) || /\bconstellation(s)?\b/u.test(objectScope)) matches.push('constellations');
  if (/систем/u.test(objectScope) || /\bsystem(s)?\b/u.test(objectScope)) matches.push('systems');
  if (/планет/u.test(objectScope) || /\bplanet(s)?\b/u.test(objectScope)) matches.push('planets');
  if (/лун/u.test(objectScope) || /\bmoon(s)?\b/u.test(objectScope)) matches.push('moons');
  if (/астероидн(?:ый|ых)?\s+пояс/u.test(objectScope) || /\basteroid belt(s)?\b/u.test(objectScope)) matches.push('asteroid_belts');
  if (/станци/u.test(objectScope) || /\bstation(s)?\b/u.test(objectScope)) matches.push('stations');
  if (/врат/u.test(objectScope) || /\bstargate(s)?\b/u.test(objectScope)) matches.push('stargates');

  return matches.length === 1 ? matches[0] : null;
}

function normalizeStaticAggregateTargetName(value: string): string {
  return value
    .trim()
    .replace(/^[«"'`]+/u, '')
    .replace(/[»"'`?!.,:;]+$/u, '')
    .trim();
}

function resolveBareStaticAggregateTarget(
  db: Db,
  objectKind: StaticAggregateObjectKind,
  targetName: string,
): { targetKind: StaticAggregateTargetKind; targetName: string } | null {
  const canonicalName = normalizeStaticAggregateTargetName(targetName);
  if (!canonicalName) return null;

  const candidateKinds: StaticAggregateTargetKind[] = objectKind === 'constellations'
    ? ['region']
    : objectKind === 'systems'
      ? ['constellation', 'region']
      : ['system', 'constellation', 'region'];

  for (const targetKind of candidateKinds) {
    if (targetKind === 'system') {
      const row = db.prepare('SELECT name FROM sde_systems WHERE name = ? COLLATE NOCASE LIMIT 1')
        .get(canonicalName) as { name: string } | undefined;
      if (row) return { targetKind, targetName: row.name };
      continue;
    }
    if (targetKind === 'constellation') {
      const row = db.prepare('SELECT name FROM sde_constellations WHERE name = ? COLLATE NOCASE LIMIT 1')
        .get(canonicalName) as { name: string } | undefined;
      if (row) return { targetKind, targetName: row.name };
      continue;
    }
    const row = db.prepare('SELECT name FROM sde_regions WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(canonicalName) as { name: string } | undefined;
    if (row) return { targetKind, targetName: row.name };
  }

  return null;
}

export function parseStaticAggregateIntent(
  db: Db,
  goal: string,
  locationContext: StaticAggregateLocationContext | null,
): StaticAggregateIntent | null {
  const objectKind = detectStaticAggregateObjectKind(goal);
  if (!objectKind) return null;

  const normalized = goal.toLowerCase();
  if (/в мо[её]м регионе/u.test(normalized) && locationContext?.regionName) {
    return { objectKind, targetKind: 'region', targetName: locationContext.regionName };
  }
  if (/в мо[её]й системе/u.test(normalized) && locationContext?.systemName) {
    return { objectKind, targetKind: 'system', targetName: locationContext.systemName };
  }
  if (/в мо[её]м созвездии/u.test(normalized) && locationContext?.constellationName) {
    return { objectKind, targetKind: 'constellation', targetName: locationContext.constellationName };
  }
  if (/\b(current region|текущ(?:ем|ий)\s+регион(?:е)?)\b/u.test(normalized) && locationContext?.regionName) {
    return { objectKind, targetKind: 'region', targetName: locationContext.regionName };
  }
  if (/\b(current system|текущ(?:ей|ая)\s+систем(?:е|а)|here|здесь)\b/u.test(normalized) && locationContext?.systemName) {
    return { objectKind, targetKind: 'system', targetName: locationContext.systemName };
  }
  if (/\b(current constellation|текущ(?:ем|ее)\s+созвездии)\b/u.test(normalized) && locationContext?.constellationName) {
    return { objectKind, targetKind: 'constellation', targetName: locationContext.constellationName };
  }

  const regionMatch = /(?:^|\s)в\s+регионе?\s+(.+)$/iu.exec(goal);
  if (regionMatch) {
    const targetName = normalizeStaticAggregateTargetName(regionMatch[1]);
    if (targetName) return { objectKind, targetKind: 'region', targetName };
  }
  const regionMatchEn = /(?:^|\s)in\s+region\s+(.+)$/iu.exec(goal);
  if (regionMatchEn) {
    const targetName = normalizeStaticAggregateTargetName(regionMatchEn[1]);
    if (targetName) return { objectKind, targetKind: 'region', targetName };
  }

  const systemMatch = /(?:^|\s)в\s+систем[еуы]?\s+(.+)$/iu.exec(goal);
  if (systemMatch) {
    const targetName = normalizeStaticAggregateTargetName(systemMatch[1]);
    if (targetName) return { objectKind, targetKind: 'system', targetName };
  }
  const systemMatchEn = /(?:^|\s)in\s+system\s+(.+)$/iu.exec(goal);
  if (systemMatchEn) {
    const targetName = normalizeStaticAggregateTargetName(systemMatchEn[1]);
    if (targetName) return { objectKind, targetKind: 'system', targetName };
  }

  const constellationMatch = /(?:^|\s)в\s+созвездии\s+(.+)$/iu.exec(goal);
  if (constellationMatch) {
    const targetName = normalizeStaticAggregateTargetName(constellationMatch[1]);
    if (targetName) return { objectKind, targetKind: 'constellation', targetName };
  }
  const constellationMatchEn = /(?:^|\s)in\s+constellation\s+(.+)$/iu.exec(goal);
  if (constellationMatchEn) {
    const targetName = normalizeStaticAggregateTargetName(constellationMatchEn[1]);
    if (targetName) return { objectKind, targetKind: 'constellation', targetName };
  }

  const bareTargetMatch = /(?:^|\s)в\s+(.+)$/iu.exec(goal);
  const targetFragment = bareTargetMatch?.[1] ?? /\bin\s+(.+)$/iu.exec(goal)?.[1];
  if (!targetFragment) return null;
  const resolvedTarget = resolveBareStaticAggregateTarget(db, objectKind, targetFragment);
  if (!resolvedTarget) return null;

  return {
    objectKind,
    targetKind: resolvedTarget.targetKind,
    targetName: resolvedTarget.targetName,
  };
}

type DeterministicCountToolCall = { name: string };

export function tryBuildDeterministicCountAnswer(
  goal: string,
  toolCalls: DeterministicCountToolCall[],
  results: unknown[],
): string | null {
  if (!isSimpleStaticAggregateCountGoal(goal)) return null;
  if (toolCalls.length !== results.length) return null;

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolName = toolCalls[index].name;
    const result = results[index];
    if (toolName === 'count_universe_objects') {
      const answer = formatUniverseCountAnswer(result);
      if (answer) return answer;
    }
  }
  return null;
}

export function tryHandleStaticAggregateFastPath(
  db: Db,
  threadId: string,
  goal: string,
  locationContext: StaticAggregateLocationContext | null,
): string | null {
  const intent = parseStaticAggregateIntent(db, goal, locationContext);
  if (!intent) return null;

  const result = executeUniverseObjectCount(db, {
    target_kind: intent.targetKind,
    target_name: intent.targetName,
    object_kind: intent.objectKind,
  });

  const answer = formatUniverseCountAnswer(result);
  if (!answer) return null;

  storeAssistantMessage(db, threadId, answer);
  saveLastResponseId(db, threadId, null);
  log.info('static-aggregate-fast-path object=%s target=%s:%s answer=%d chars',
    intent.objectKind, intent.targetKind, intent.targetName, answer.length);
  return answer;
}

function formatUniverseCountAnswer(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if (record.ok !== true || typeof record.target_kind !== 'string' || typeof record.target_name !== 'string') {
    return null;
  }
  if (typeof record.object_kind !== 'string' || typeof record.count !== 'number') {
    return null;
  }

  const nounForms = getUniverseCountNounForms(record.object_kind);
  if (!nounForms) return null;
  const targetLabel = record.target_kind === 'system'
    ? 'системе'
    : record.target_kind === 'constellation'
      ? 'созвездии'
      : 'регионе';

  const base = `В ${targetLabel} **${record.target_name}** — **${record.count} ${formatCountNoun(record.count, nounForms)}**.`;

  // Enriched moon answer: append planet_count and system_count extras (region-level)
  if (record.object_kind === 'moons') {
    const extras: string[] = [];
    if (typeof record.system_count === 'number') {
      extras.push(`систем: **${record.system_count}**`);
    }
    if (typeof record.planet_count === 'number') {
      extras.push(`планет: **${record.planet_count}**`);
    }
    if (extras.length > 0) {
      return `${base}\n\nДополнительно:\n- ${extras.join('\n- ')}`;
    }
  }

  return base;
}

function getUniverseCountNounForms(objectKind: string): [string, string, string] | null {
  switch (objectKind) {
    case 'constellations':
      return ['созвездие', 'созвездия', 'созвездий'];
    case 'systems':
      return ['система', 'системы', 'систем'];
    case 'planets':
      return ['планета', 'планеты', 'планет'];
    case 'moons':
      return ['луна', 'луны', 'лун'];
    case 'asteroid_belts':
      return ['астероидный пояс', 'астероидных пояса', 'астероидных поясов'];
    case 'stations':
      return ['станция', 'станции', 'станций'];
    case 'stargates':
      return ['старгейт', 'старгейта', 'старгейтов'];
    default:
      return null;
  }
}

export function formatCountNoun(count: number, [one, few, many]: [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function storeAssistantMessage(db: Db, threadId: string, content: string): void {
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'assistant', content);
}

function saveLastResponseId(db: Db, threadId: string, responseId: string | null): void {
  db.prepare(
    "UPDATE agent_threads SET last_response_id = ?, last_response_message_id = NULL, updated_at = datetime('now') WHERE thread_id = ?"
  ).run(responseId, threadId);
}
