import type { Db } from '../../db/sqlite.js';
import {
  extractCteNames,
  normalizeObjectReference,
  tokenizeSql,
  type SqlToken,
} from './sde-execution.js';

/**
 * character_sql execution: read-only SQL over the materialized private
 * profile (character_* tables) plus the public SDE (sde_* tables).
 *
 * Isolation is enforced on the server, not in the prompt:
 * 1. The active character is resolved from the caller's session context; the
 *    model never supplies a character_id.
 * 2. Before the query runs, every character_* table is shadowed by a
 *    per-query TEMP VIEW whose definition bakes in
 *    `WHERE character_id = <active id>` (an integer literal validated by
 *    Number.isSafeInteger — never string-interpolated user input). SQLite
 *    resolves unqualified names to the temp schema first, so ANY reference —
 *    top-level, subquery, CTE, join — can only ever see the active
 *    character's rows, even `SELECT * FROM character_assets WHERE
 *    character_id = <someone else>`.
 * 3. Schema-qualified references (`main.character_assets`) in the model's SQL
 *    text are rejected, closing the only path around the temp views.
 * 4. View creation, validation and execution are fully synchronous on the
 *    single-threaded better-sqlite3 connection and the views are dropped in a
 *    finally block, so no other code path can observe or be shadowed by them.
 */

const MAX_CHARACTER_ROWS = 50;
const MAX_QUERY_MS = 2_000;
const TIME_CHECK_EVERY_ROWS = 64;

const CHARACTER_WRITE_KEYWORDS = new Set(['ALTER', 'ATTACH', 'CREATE', 'DELETE', 'DETACH', 'DROP', 'INSERT', 'PRAGMA', 'REINDEX', 'REPLACE', 'UPDATE', 'VACUUM']);
const IGNORED_PLAN_REFERENCES = new Set(['constant']);

type AllowedObjects = {
  /** character_* tables that carry a character_id column (isolation-ready). */
  characterTables: Set<string>;
  /** sde_* tables/views (public static data). */
  sdeObjects: Set<string>;
};

const ALLOWED_OBJECT_CACHE = new WeakMap<Db, AllowedObjects>();

type QueryPlanRow = {
  detail: string;
};

export type CharacterSqlResult = {
  ok: boolean;
  rows: unknown[];
  count: number;
  error: string | null;
};

export type CharacterSqlAnalysis =
  | { ok: true; characterTables: string[] }
  | { ok: false; error: string };

function getAllowedObjects(db: Db): AllowedObjects {
  const cached = ALLOWED_OBJECT_CACHE.get(db);
  if (cached !== undefined) return cached;

  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type IN ('table', 'view')
      AND (name GLOB 'character_*' OR name GLOB 'sde_*')
  `).all() as { name: string }[];

  const characterTables = new Set<string>();
  const sdeObjects = new Set<string>();
  for (const row of rows) {
    const name = row.name.toLowerCase();
    if (name.startsWith('sde_')) {
      sdeObjects.add(name);
      continue;
    }
    // Isolation invariant: only character_* tables with a character_id column
    // may be exposed; a table without one could not be row-scoped.
    const columns = db.prepare(`PRAGMA table_info(${row.name})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'character_id')) {
      characterTables.add(name);
    }
  }

  const allowed: AllowedObjects = { characterTables, sdeObjects };
  ALLOWED_OBJECT_CACHE.set(db, allowed);
  return allowed;
}

const ALIAS_STOP_KEYWORDS = new Set([
  'CROSS', 'EXCEPT', 'FULL', 'GROUP', 'HAVING', 'INDEXED', 'INNER', 'INTERSECT',
  'JOIN', 'LEFT', 'LIMIT', 'NATURAL', 'ON', 'ORDER', 'RIGHT', 'UNION', 'USING',
  'WHERE', 'WINDOW',
]);

function isIdentifierToken(token: SqlToken | undefined): token is SqlToken {
  return token !== undefined && /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(token.value);
}

/**
 * Alias map covering comma-separated table lists (`FROM a x, b y`), which the
 * query plan prints BY ALIAS (`SCAN y`, `SEARCH y USING AUTOMATIC ...`). The
 * SDE extractor only maps the first table after FROM/JOIN; character queries
 * routinely comma-join wallet/profile singletons, so every entry is mapped.
 */
function extractCharacterTableAliases(tokens: SqlToken[]): Map<string, string> {
  const aliases = new Map<string, string>();

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].upper !== 'FROM' && tokens[index].upper !== 'JOIN') continue;

    let cursor = index + 1;
    // Parse a comma-separated list of table references after FROM.
    for (;;) {
      if (tokens[cursor]?.value === '(') break;

      const nameParts: string[] = [];
      while (isIdentifierToken(tokens[cursor])) {
        nameParts.push(tokens[cursor].value);
        if (tokens[cursor + 1]?.value !== '.') {
          cursor += 1;
          break;
        }
        cursor += 2;
      }
      if (nameParts.length === 0) break;

      const normalizedObject = normalizeObjectReference(nameParts.join('.'));
      if (normalizedObject === null) break;
      aliases.set(normalizedObject, normalizedObject);

      if (tokens[cursor]?.upper === 'AS') cursor += 1;
      if (isIdentifierToken(tokens[cursor]) && !ALIAS_STOP_KEYWORDS.has(tokens[cursor].upper)) {
        aliases.set(normalizeIdentifier(tokens[cursor].value), normalizedObject);
        cursor += 1;
      }

      if (tokens[cursor]?.value === ',') {
        cursor += 1;
        continue;
      }
      break;
    }
  }

  return aliases;
}

function normalizeIdentifier(value: string): string {
  return value.toLowerCase();
}

/**
 * Rejects schema-qualified FROM/JOIN references (`main.x`, `temp.x`). After
 * the isolation views exist, an unqualified `character_assets` resolves to
 * the row-scoped TEMP VIEW; a qualified one would bypass it.
 */
function findSchemaQualifiedReference(tokens: SqlToken[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.upper !== 'FROM' && token.upper !== 'JOIN') continue;

    let cursor = index + 1;
    if (tokens[cursor]?.value === '(') continue;

    const parts: string[] = [];
    while (tokens[cursor] && /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(tokens[cursor].value)) {
      parts.push(tokens[cursor].value);
      if (tokens[cursor + 1]?.value !== '.') break;
      cursor += 2;
    }
    if (parts.length > 1) {
      return parts.join('.');
    }
  }
  return null;
}

function validateCharacterSqlSources(
  db: Db,
  sql: string,
  allowed: AllowedObjects,
): { ok: true; characterTables: string[] } | { ok: false; error: string } {
  const tokens = tokenizeSql(sql);
  const firstToken = tokens[0]?.upper;

  if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
    return { ok: false, error: 'Only SELECT queries are allowed' };
  }

  for (const token of tokens) {
    if (CHARACTER_WRITE_KEYWORDS.has(token.upper)) {
      return { ok: false, error: 'Write operations are not allowed' };
    }
  }

  const qualified = findSchemaQualifiedReference(tokens);
  if (qualified !== null) {
    return {
      ok: false,
      error: `Schema-qualified references are not allowed (got "${qualified}"); use unqualified table names`,
    };
  }

  const aliasMap = extractCharacterTableAliases(tokens);
  const cteNames = extractCteNames(tokens);

  let planRows: QueryPlanRow[];
  try {
    planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as QueryPlanRow[];
  } catch (err) {
    return { ok: false, error: `SQL error: ${(err as Error).message}` };
  }

  const referencedCharacterTables = new Set<string>();
  let fullScans = 0;

  for (const row of planRows) {
    const detail = row.detail.trim();
    // Table-valued functions (json_each, json_tree) read no table and their
    // SCAN is bounded by the JSON array, so they count neither as full table
    // scans nor as table references.
    if (/VIRTUAL TABLE/i.test(detail)) continue;
    if (/^SCAN\b/i.test(detail)) fullScans += 1;

    for (const rawReference of extractPlanReferences(detail)) {
      const normalizedReference = normalizeObjectReference(rawReference);
      const resolvedReference = aliasMap.get(normalizedReference ?? '') ?? normalizedReference;

      if (resolvedReference === null) {
        return { ok: false, error: `Query references an unsupported source: ${rawReference}` };
      }

      const parts = resolvedReference.split('.');
      // The query plan resolves the isolation TEMP VIEWs to their underlying
      // main-schema table, so a leading "main." is legitimate here; any other
      // schema is not.
      if (parts.length === 2 && parts[0] !== 'main') {
        return { ok: false, error: `Only main-schema tables are allowed (got "${resolvedReference}")` };
      }
      const baseName = parts.at(-1) ?? '';

      if (cteNames.has(baseName) || IGNORED_PLAN_REFERENCES.has(baseName)) {
        continue;
      }

      if (allowed.characterTables.has(baseName)) {
        referencedCharacterTables.add(baseName);
        continue;
      }
      if (allowed.sdeObjects.has(baseName)) {
        continue;
      }
      return {
        ok: false,
        error: `Only character profile (character_*) and SDE (sde_*) tables are allowed (got "${resolvedReference}")`,
      };
    }
  }

  if (referencedCharacterTables.size === 0) {
    return {
      ok: false,
      error: 'Query must read from at least one character_* table (use sde_sql for static data)',
    };
  }

  // Same cartesian guard as sde_sql: two or more unconstrained full scans can
  // multiply (e.g. character_assets x sde_types) and pin the event loop.
  if (fullScans >= 2) {
    return {
      ok: false,
      error: 'Query would scan multiple tables in full (possible cartesian product). Add an indexed JOIN condition (e.g. ON a.type_id = t.type_id) or query one table at a time.',
    };
  }

  return { ok: true, characterTables: [...referencedCharacterTables] };
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

function createIsolationViews(db: Db, characterTables: ReadonlySet<string>, characterId: number): string[] {
  const created: string[] = [];
  for (const table of characterTables) {
    db.exec(`DROP VIEW IF EXISTS temp.${table}`);
    // The body MUST qualify main. explicitly: an unqualified self-reference
    // would resolve back to this temp view and be circular.
    db.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM main.${table} WHERE character_id = ${characterId}`);
    created.push(table);
  }
  return created;
}

function dropIsolationViews(db: Db, viewNames: readonly string[]): void {
  for (const name of viewNames) {
    db.exec(`DROP VIEW IF EXISTS temp.${name}`);
  }
}

/**
 * Validates the query and reports which character_* tables it touches, so the
 * caller can refresh exactly the backing ESI datasets before executing.
 * Does not require the isolation views; never executes the query.
 */
export function analyzeCharacterSqlTables(db: Db, sql: string): CharacterSqlAnalysis {
  const validation = validateCharacterSqlSources(db, sql.trim(), getAllowedObjects(db));
  if (!validation.ok) return { ok: false, error: validation.error };
  return { ok: true, characterTables: validation.characterTables };
}

/**
 * Executes read-only SQL scoped to one character. characterId MUST come from
 * server-side session resolution (getLinkedCharacter), never from tool args.
 */
export function executeCharacterSql(db: Db, sql: string, characterId: number): CharacterSqlResult {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    return { ok: false, rows: [], count: 0, error: 'Invalid character context' };
  }

  const allowed = getAllowedObjects(db);
  const viewNames = createIsolationViews(db, allowed.characterTables, characterId);
  try {
    const validation = validateCharacterSqlSources(db, sql.trim(), allowed);
    if (!validation.ok) {
      return { ok: false, rows: [], count: 0, error: validation.error };
    }

    const startedAt = Date.now();
    const stmt = db.prepare(sql.trim());
    // Iterate lazily and stop one past the cap (same rationale as sde_sql).
    const rows: unknown[] = [];
    for (const row of stmt.iterate()) {
      rows.push(row);
      if (rows.length > MAX_CHARACTER_ROWS) break;
      if (rows.length % TIME_CHECK_EVERY_ROWS === 0 && Date.now() - startedAt > MAX_QUERY_MS) {
        return { ok: false, rows: [], count: 0, error: `Query exceeded the ${MAX_QUERY_MS}ms execution limit` };
      }
    }
    const truncated = rows.length > MAX_CHARACTER_ROWS;
    return {
      ok: true,
      rows: truncated ? rows.slice(0, MAX_CHARACTER_ROWS) : rows,
      count: rows.length,
      error: truncated ? `Truncated to ${MAX_CHARACTER_ROWS} rows (more available — narrow the query)` : null,
    };
  } catch (err) {
    return { ok: false, rows: [], count: 0, error: `SQL error: ${(err as Error).message}` };
  } finally {
    dropIsolationViews(db, viewNames);
  }
}
