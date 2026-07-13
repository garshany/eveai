import type { Db } from '../../db/sqlite.js';

type UniverseTargetKind = 'system' | 'constellation' | 'region';
type UniverseObjectKind = 'constellations' | 'systems' | 'planets' | 'moons' | 'asteroid_belts' | 'stations' | 'stargates';

const MAX_SDE_ROWS = 50;
const SDE_OBJECT_CACHE = new WeakMap<Db, Set<string>>();
const SDE_WRITE_KEYWORDS = new Set(['ALTER', 'ATTACH', 'CREATE', 'DELETE', 'DETACH', 'DROP', 'INSERT', 'PRAGMA', 'REINDEX', 'REPLACE', 'UPDATE', 'VACUUM']);
const SDE_ALIAS_STOP_KEYWORDS = new Set([
  'CROSS',
  'EXCEPT',
  'FULL',
  'GROUP',
  'HAVING',
  'INDEXED',
  'INNER',
  'INTERSECT',
  'JOIN',
  'LEFT',
  'LIMIT',
  'NATURAL',
  'ON',
  'ORDER',
  'RIGHT',
  'UNION',
  'USING',
  'WHERE',
  'WINDOW',
]);
const SDE_CTE_HINT_KEYWORDS = new Set(['MATERIALIZED', 'NOT']);
const SDE_IGNORED_PLAN_REFERENCES = new Set(['constant']);

type SqlToken = {
  value: string;
  upper: string;
};

type QueryPlanRow = {
  detail: string;
};

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    if (char === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(index + 2, sql.length);
      continue;
    }

    if (char === '\'') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '\'' && sql[index + 1] === '\'') {
          index += 2;
          continue;
        }
        if (sql[index] === '\'') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      let value = '';
      index += 1;
      while (index < sql.length) {
        const current = sql[index];
        if (current === closing) {
          if (closing !== ']' && sql[index + 1] === closing) {
            value += closing;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ value, upper: value.toUpperCase() });
      continue;
    }

    if (/[A-Za-z_]/u.test(char)) {
      let value = char;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index])) {
        value += sql[index];
        index += 1;
      }
      tokens.push({ value, upper: value.toUpperCase() });
      continue;
    }

    if (/[0-9]/u.test(char)) {
      let value = char;
      index += 1;
      while (index < sql.length && /[0-9.]/u.test(sql[index])) {
        value += sql[index];
        index += 1;
      }
      tokens.push({ value, upper: value.toUpperCase() });
      continue;
    }

    tokens.push({ value: char, upper: char.toUpperCase() });
    index += 1;
  }

  return tokens;
}

function isSqlIdentifierToken(token: SqlToken | undefined): token is SqlToken {
  return token !== undefined && /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(token.value);
}

function normalizeSqlIdentifier(value: string): string {
  return value.toLowerCase();
}

function normalizeObjectReference(value: string): string | null {
  const parts = value
    .split('.')
    .map((part) => normalizeSqlIdentifier(part))
    .filter((part) => part.length > 0);

  if (parts.length === 0 || parts.length > 2) {
    return null;
  }

  return parts.join('.');
}

function skipParenthesizedTokens(tokens: SqlToken[], startIndex: number): number {
  let depth = 0;
  let index = startIndex;

  while (index < tokens.length) {
    if (tokens[index].value === '(') {
      depth += 1;
    } else if (tokens[index].value === ')') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }

  return index;
}

function extractCteNames(tokens: SqlToken[]): Set<string> {
  const cteNames = new Set<string>();
  let index = 0;

  if (tokens[index]?.upper !== 'WITH') {
    return cteNames;
  }

  index += 1;
  if (tokens[index]?.upper === 'RECURSIVE') {
    index += 1;
  }

  while (index < tokens.length) {
    const nameToken = tokens[index];
    if (!isSqlIdentifierToken(nameToken)) {
      return cteNames;
    }

    cteNames.add(normalizeSqlIdentifier(nameToken.value));
    index += 1;

    if (tokens[index]?.value === '(') {
      index = skipParenthesizedTokens(tokens, index);
    }

    if (tokens[index]?.upper !== 'AS') {
      return cteNames;
    }
    index += 1;

    while (SDE_CTE_HINT_KEYWORDS.has(tokens[index]?.upper ?? '')) {
      index += 1;
    }

    if (tokens[index]?.value !== '(') {
      return cteNames;
    }
    index = skipParenthesizedTokens(tokens, index);

    if (tokens[index]?.value === ',') {
      index += 1;
      continue;
    }

    return cteNames;
  }

  return cteNames;
}

function extractTableAliases(tokens: SqlToken[]): Map<string, string> {
  const aliases = new Map<string, string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.upper !== 'FROM' && token.upper !== 'JOIN') {
      continue;
    }

    let cursor = index + 1;
    if (tokens[cursor]?.value === '(') {
      continue;
    }

    const nameParts: string[] = [];
    while (isSqlIdentifierToken(tokens[cursor])) {
      nameParts.push(tokens[cursor].value);
      if (tokens[cursor + 1]?.value !== '.') {
        cursor += 1;
        break;
      }
      cursor += 2;
    }

    if (nameParts.length === 0) {
      continue;
    }

    const normalizedObject = normalizeObjectReference(nameParts.join('.'));
    if (normalizedObject === null) {
      continue;
    }

    aliases.set(normalizedObject, normalizedObject);

    if (tokens[cursor]?.upper === 'AS') {
      cursor += 1;
    }

    if (isSqlIdentifierToken(tokens[cursor]) && !SDE_ALIAS_STOP_KEYWORDS.has(tokens[cursor].upper)) {
      aliases.set(normalizeSqlIdentifier(tokens[cursor].value), normalizedObject);
    }
  }

  return aliases;
}

function extractPlanReferences(detail: string): string[] {
  const references = new Set<string>();
  const patterns = [
    /\b(?:SCAN|SEARCH)\s+(?:TABLE\s+)?([^\s]+)/giu,
    /\bON TABLE\s+([^\s]+)/giu,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(detail)) !== null) {
      references.add(match[1]);
    }
  }

  return [...references];
}

function getAllowedSdeObjects(db: Db): Set<string> {
  const cached = SDE_OBJECT_CACHE.get(db);
  if (cached !== undefined) {
    return cached;
  }

  const rows = db
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name GLOB 'sde_*'
    `)
    .all() as { name: string }[];

  const allowed = new Set(rows.map((row) => row.name.toLowerCase()));
  SDE_OBJECT_CACHE.set(db, allowed);
  return allowed;
}

function validateSdeReference(reference: string, allowedObjects: Set<string>): { ok: true; objectName: string } | { ok: false; error: string } {
  const normalized = normalizeObjectReference(reference);
  if (normalized === null) {
    return { ok: false, error: `Unsupported query source "${reference}"` };
  }

  const parts = normalized.split('.');
  const schemaName = parts.length === 2 ? parts[0] : null;
  const objectName = parts[parts.length - 1];

  if (schemaName !== null && schemaName !== 'main') {
    return { ok: false, error: `Only main SDE tables are allowed (got "${reference}")` };
  }

  if (!allowedObjects.has(objectName)) {
    return { ok: false, error: `Only SDE tables are allowed (got "${reference}")` };
  }

  return { ok: true, objectName };
}

function validateSdeSqlSources(db: Db, sql: string): string | null {
  const tokens = tokenizeSql(sql);
  const firstToken = tokens[0]?.upper;

  if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
    return 'Only SELECT queries are allowed';
  }

  for (const token of tokens) {
    if (SDE_WRITE_KEYWORDS.has(token.upper)) {
      return 'Write operations are not allowed';
    }
  }

  const allowedObjects = getAllowedSdeObjects(db);
  const aliasMap = extractTableAliases(tokens);
  const cteNames = extractCteNames(tokens);

  let planRows: QueryPlanRow[];
  try {
    planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as QueryPlanRow[];
  } catch (err) {
    return `SQL error: ${(err as Error).message}`;
  }

  const referencedObjects = new Set<string>();

  for (const row of planRows) {
    for (const rawReference of extractPlanReferences(row.detail)) {
      const normalizedReference = normalizeObjectReference(rawReference);
      const resolvedReference = aliasMap.get(normalizedReference ?? '') ?? normalizedReference;

      if (resolvedReference === null) {
        return `Query references an unsupported source: ${rawReference}`;
      }

      const baseName = resolvedReference.split('.').at(-1);
      if (baseName !== undefined && (cteNames.has(baseName) || SDE_IGNORED_PLAN_REFERENCES.has(baseName))) {
        continue;
      }

      const validation = validateSdeReference(resolvedReference, allowedObjects);
      if (!validation.ok) {
        return validation.error;
      }

      referencedObjects.add(validation.objectName);
    }
  }

  if (referencedObjects.size === 0) {
    return 'Query must read from at least one SDE table';
  }

  // Guard against cartesian products. A full table SCAN visits every row; two or
  // more unconstrained SCANs multiply (e.g. sde_types × sde_types ≈ 51k² rows),
  // which pins the single-threaded event loop and freezes both bots. An indexed
  // join shows up as SEARCH (bounded), so only count SCAN rows.
  const fullScans = planRows.filter((row) => /^SCAN\b/i.test(row.detail.trim())).length;
  if (fullScans >= 2) {
    return 'Query would scan multiple tables in full (possible cartesian product). Add an indexed JOIN condition (e.g. ON a.group_id = b.group_id) or query one table at a time.';
  }

  return null;
}

type UniverseTargetContext = {
  target_kind: UniverseTargetKind;
  target_name: string;
  system_id?: number;
  constellation_id?: number;
  region_id?: number;
  constellation_name?: string | null;
  region_name?: string | null;
};

export type UniverseCountResult =
  | ({
      ok: true;
      object_kind: UniverseObjectKind;
      count: number;
      /** Extra: planet count when object_kind='moons'. */
      planet_count?: number;
      /** Extra: system count when object_kind='moons' and target_kind='region'. */
      system_count?: number;
    } & UniverseTargetContext)
  | {
      ok: false;
      error: string;
    };

function resolveUniverseTargetContext(
  db: Db,
  targetKind: UniverseTargetKind,
  targetName: string,
): UniverseTargetContext | null {
  if (targetKind === 'system') {
    const row = db.prepare(`
      SELECT
        s.system_id AS system_id,
        s.name AS system_name,
        c.constellation_id AS constellation_id,
        c.name AS constellation_name,
        r.region_id AS region_id,
        r.name AS region_name
      FROM sde_systems s
      LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
      LEFT JOIN sde_regions r ON r.region_id = c.region_id
      WHERE s.name = ? COLLATE NOCASE
      LIMIT 1
    `).get(targetName) as {
      system_id: number;
      system_name: string;
      constellation_id: number | null;
      constellation_name: string | null;
      region_id: number | null;
      region_name: string | null;
    } | undefined;

    if (!row) return null;
    return {
      target_kind: 'system',
      target_name: row.system_name,
      system_id: row.system_id,
      constellation_id: row.constellation_id ?? undefined,
      constellation_name: row.constellation_name,
      region_id: row.region_id ?? undefined,
      region_name: row.region_name,
    };
  }

  if (targetKind === 'constellation') {
    const row = db.prepare(`
      SELECT
        c.constellation_id AS constellation_id,
        c.name AS constellation_name,
        r.region_id AS region_id,
        r.name AS region_name
      FROM sde_constellations c
      LEFT JOIN sde_regions r ON r.region_id = c.region_id
      WHERE c.name = ? COLLATE NOCASE
      LIMIT 1
    `).get(targetName) as {
      constellation_id: number;
      constellation_name: string;
      region_id: number | null;
      region_name: string | null;
    } | undefined;

    if (!row) return null;
    return {
      target_kind: 'constellation',
      target_name: row.constellation_name,
      constellation_id: row.constellation_id,
      region_id: row.region_id ?? undefined,
      region_name: row.region_name,
    };
  }

  const row = db.prepare(`
    SELECT region_id, name AS region_name
    FROM sde_regions
    WHERE name = ? COLLATE NOCASE
    LIMIT 1
  `).get(targetName) as { region_id: number; region_name: string } | undefined;

  if (!row) return null;
  return {
    target_kind: 'region',
    target_name: row.region_name,
    region_id: row.region_id,
  };
}

function isUniverseCountCombinationAllowed(targetKind: UniverseTargetKind, objectKind: UniverseObjectKind): boolean {
  if (targetKind === 'system') {
    return objectKind === 'planets'
      || objectKind === 'moons'
      || objectKind === 'asteroid_belts'
      || objectKind === 'stations'
      || objectKind === 'stargates';
  }
  if (targetKind === 'constellation') {
    return objectKind !== 'constellations';
  }
  return true;
}

function buildUniverseCountError(targetKind: UniverseTargetKind, objectKind: UniverseObjectKind): string {
  return `Cannot count ${objectKind} inside ${targetKind}.`;
}

export function executeUniverseObjectCount(db: Db, args: Record<string, unknown>): UniverseCountResult {
  const targetKind = args.target_kind === 'system' || args.target_kind === 'constellation' || args.target_kind === 'region'
    ? args.target_kind
    : null;
  const objectKind = args.object_kind === 'constellations'
    || args.object_kind === 'systems'
    || args.object_kind === 'planets'
    || args.object_kind === 'moons'
    || args.object_kind === 'asteroid_belts'
    || args.object_kind === 'stations'
    || args.object_kind === 'stargates'
    ? args.object_kind
    : null;
  const targetName = typeof args.target_name === 'string' ? args.target_name.trim() : '';

  if (!targetKind) {
    return { ok: false, error: 'target_kind must be one of: system, constellation, region.' };
  }
  if (!objectKind) {
    return { ok: false, error: 'object_kind must be one of: constellations, systems, planets, moons, asteroid_belts, stations, stargates.' };
  }
  if (!targetName) {
    return { ok: false, error: 'target_name must be a non-empty EVE geography name.' };
  }
  if (!isUniverseCountCombinationAllowed(targetKind, objectKind)) {
    return { ok: false, error: buildUniverseCountError(targetKind, objectKind) };
  }

  const target = resolveUniverseTargetContext(db, targetKind, targetName);
  if (!target) {
    return { ok: false, error: `${targetKind[0].toUpperCase()}${targetKind.slice(1)} not found: ${targetName}` };
  }

  let count = 0;

  switch (objectKind) {
    case 'constellations': {
      const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM sde_constellations
        WHERE region_id = ?
      `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'systems': {
      const row = targetKind === 'region'
        ? db.prepare(`
            SELECT COUNT(*) AS count
            FROM sde_systems s
            JOIN sde_constellations c ON c.constellation_id = s.constellation_id
            WHERE c.region_id = ?
          `).get(target.region_id) as { count: number }
        : db.prepare(`
            SELECT COUNT(*) AS count
            FROM sde_systems
            WHERE constellation_id = ?
          `).get(target.constellation_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'planets': {
      const row = targetKind === 'system'
        ? db.prepare(`
            SELECT COUNT(*) AS count
            FROM sde_raw_records
            WHERE dataset_name = 'mapPlanets'
              AND json_extract(data_json, '$.solarSystemID') = ?
          `).get(target.system_id) as { count: number }
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              WHERE p.dataset_name = 'mapPlanets'
                AND s.constellation_id = ?
            `).get(target.constellation_id) as { count: number }
          : db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE p.dataset_name = 'mapPlanets'
                AND c.region_id = ?
            `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'moons': {
      type MoonEnrichedRow = { moon_count: number; planet_count: number; system_count?: number };
      const enrichedRow: MoonEnrichedRow = targetKind === 'system'
        ? db.prepare(`
            SELECT
              COALESCE(SUM(
                CASE
                  WHEN json_type(data_json, '$.moonIDs') = 'array' THEN json_array_length(data_json, '$.moonIDs')
                  ELSE 0
                END
              ), 0) AS moon_count,
              COUNT(record_id) AS planet_count
            FROM sde_raw_records
            WHERE dataset_name = 'mapPlanets'
              AND json_extract(data_json, '$.solarSystemID') = ?
          `).get(target.system_id) as MoonEnrichedRow
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT
                COALESCE(SUM(
                  CASE
                    WHEN json_type(p.data_json, '$.moonIDs') = 'array' THEN json_array_length(p.data_json, '$.moonIDs')
                    ELSE 0
                  END
                ), 0) AS moon_count,
                COUNT(p.record_id) AS planet_count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              WHERE p.dataset_name = 'mapPlanets'
                AND s.constellation_id = ?
            `).get(target.constellation_id) as MoonEnrichedRow
          : db.prepare(`
              SELECT
                COALESCE(SUM(
                  CASE
                    WHEN json_type(p.data_json, '$.moonIDs') = 'array' THEN json_array_length(p.data_json, '$.moonIDs')
                    ELSE 0
                  END
                ), 0) AS moon_count,
                COUNT(p.record_id) AS planet_count,
                COUNT(DISTINCT s.system_id) AS system_count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE p.dataset_name = 'mapPlanets'
                AND c.region_id = ?
            `).get(target.region_id) as MoonEnrichedRow;
      count = Number(enrichedRow.moon_count ?? 0);
      return {
        ok: true as const,
        object_kind: objectKind,
        count,
        planet_count: Number(enrichedRow.planet_count ?? 0),
        ...(targetKind === 'region' && enrichedRow.system_count != null
          ? { system_count: Number(enrichedRow.system_count) }
          : {}),
        ...target,
      };
    }
    case 'asteroid_belts': {
      const row = targetKind === 'system'
        ? db.prepare(`
            SELECT COALESCE(SUM(
              CASE
                WHEN json_type(data_json, '$.asteroidBeltIDs') = 'array' THEN json_array_length(data_json, '$.asteroidBeltIDs')
                ELSE 0
              END
            ), 0) AS count
            FROM sde_raw_records
            WHERE dataset_name = 'mapPlanets'
              AND json_extract(data_json, '$.solarSystemID') = ?
          `).get(target.system_id) as { count: number }
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT COALESCE(SUM(
                CASE
                  WHEN json_type(p.data_json, '$.asteroidBeltIDs') = 'array' THEN json_array_length(p.data_json, '$.asteroidBeltIDs')
                  ELSE 0
                END
              ), 0) AS count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              WHERE p.dataset_name = 'mapPlanets'
                AND s.constellation_id = ?
            `).get(target.constellation_id) as { count: number }
          : db.prepare(`
              SELECT COALESCE(SUM(
                CASE
                  WHEN json_type(p.data_json, '$.asteroidBeltIDs') = 'array' THEN json_array_length(p.data_json, '$.asteroidBeltIDs')
                  ELSE 0
                END
              ), 0) AS count
              FROM sde_raw_records p
              JOIN sde_systems s ON s.system_id = json_extract(p.data_json, '$.solarSystemID')
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE p.dataset_name = 'mapPlanets'
                AND c.region_id = ?
            `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'stations': {
      const row = targetKind === 'system'
        ? db.prepare('SELECT COUNT(*) AS count FROM sde_stations WHERE system_id = ?').get(target.system_id) as { count: number }
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_stations st
              JOIN sde_systems s ON s.system_id = st.system_id
              WHERE s.constellation_id = ?
            `).get(target.constellation_id) as { count: number }
          : db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_stations st
              JOIN sde_systems s ON s.system_id = st.system_id
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE c.region_id = ?
            `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
    case 'stargates': {
      const row = targetKind === 'system'
        ? db.prepare('SELECT COUNT(*) AS count FROM sde_stargates WHERE system_id = ?').get(target.system_id) as { count: number }
        : targetKind === 'constellation'
          ? db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_stargates sg
              JOIN sde_systems s ON s.system_id = sg.system_id
              WHERE s.constellation_id = ?
            `).get(target.constellation_id) as { count: number }
          : db.prepare(`
              SELECT COUNT(*) AS count
              FROM sde_stargates sg
              JOIN sde_systems s ON s.system_id = sg.system_id
              JOIN sde_constellations c ON c.constellation_id = s.constellation_id
              WHERE c.region_id = ?
            `).get(target.region_id) as { count: number };
      count = Number(row.count ?? 0);
      break;
    }
  }

  return {
    ok: true,
    object_kind: objectKind,
    count,
    ...target,
  };
}

export function executeSdeSql(db: Db, sql: string): { ok: boolean; rows: unknown[]; count: number; error: string | null } {
  const trimmed = sql.trim();
  const validationError = validateSdeSqlSources(db, trimmed);
  if (validationError !== null) {
    return { ok: false, rows: [], count: 0, error: validationError };
  }

  try {
    const stmt = db.prepare(trimmed);
    // Iterate lazily and stop one past the cap: SQLite produces rows on demand,
    // so a query that would return millions of rows is halted after ~50 steps
    // instead of being fully materialized into memory.
    const rows: unknown[] = [];
    for (const row of stmt.iterate()) {
      rows.push(row);
      if (rows.length > MAX_SDE_ROWS) break;
    }
    const truncated = rows.length > MAX_SDE_ROWS;
    return {
      ok: true,
      rows: truncated ? rows.slice(0, MAX_SDE_ROWS) : rows,
      count: rows.length,
      error: truncated ? `Truncated to ${MAX_SDE_ROWS} rows (more available — narrow the query)` : null,
    };
  } catch (err) {
    return { ok: false, rows: [], count: 0, error: `SQL error: ${(err as Error).message}` };
  }
}
