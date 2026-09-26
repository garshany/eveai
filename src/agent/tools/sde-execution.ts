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

export type SqlToken = {
  value: string;
  upper: string;
  /**
   * 'quoted' = a "..." / `...` / [...] identifier; 'string' = a '...' literal
   * (emitted with an empty value so it never matches a keyword or identifier).
   * Undefined for bare words, numbers and punctuation.
   */
  kind?: 'quoted' | 'string';
};

export type QueryPlanRow = {
  id: number;
  parent: number;
  detail: string;
};

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
// Plan rows for literal row sources (VALUES lists, constant SELECTs). They read
// no table, and their row count is bounded by the SQL text itself.
const CONSTANT_ROWS_SCAN = /^SCAN (?:CONSTANT ROW|\d+ CONSTANT ROWS|\d+-ROW VALUES CLAUSE)$/iu;
// Characters SQLite does not treat as whitespace but JS/LLM output often
// carries after a statement (NBSP, zero-width space/joiners, word joiner, BOM).
const INERT_TAIL_CHAR = /[\s​-‍⁠﻿]/u;
const MULTI_STATEMENT_ERROR = 'Only one SQL statement per call is allowed. Run separate calls, or combine SELECTs with UNION ALL / a CTE.';

export function tokenizeSql(sql: string): SqlToken[] {
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
      tokens.push({ value: '', upper: '', kind: 'string' });
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
      tokens.push({ value, upper: value.toUpperCase(), kind: 'quoted' });
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
  return token !== undefined && PLAIN_IDENTIFIER.test(token.value);
}

/**
 * Splits off a statement terminator: returns the SQL before the first
 * top-level `;` when everything after it is inert (semicolons, whitespace
 * including Unicode spaces SQLite does not recognise, comments). Any other
 * trailing content is a second statement and is rejected. The lexer mirrors
 * SQLite's (quotes with doubled escapes, [..] identifiers, -- and block
 * comments). Callers validate AND execute the returned string, so a lexer
 * disagreement cannot smuggle a statement past validation — and better-sqlite3
 * still refuses multi-statement strings in prepare().
 */
export function stripStatementTerminator(sql: string): { ok: true; sql: string } | { ok: false; error: string } {
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (closing !== ']' && sql[index + 1] === closing) {
            index += 2;
            continue;
          }
          break;
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === ';') break;
    index += 1;
  }

  if (index >= sql.length) return { ok: true, sql: sql.trim() };
  if (!isInertSqlTail(sql.slice(index))) return { ok: false, error: MULTI_STATEMENT_ERROR };
  return { ok: true, sql: sql.slice(0, index).trim() };
}

function isInertSqlTail(tail: string): boolean {
  let index = 0;
  while (index < tail.length) {
    const char = tail[index];
    if (char === ';' || INERT_TAIL_CHAR.test(char)) {
      index += 1;
    } else if (char === '-' && tail[index + 1] === '-') {
      const end = tail.indexOf('\n', index + 2);
      index = end === -1 ? tail.length : end + 1;
    } else if (char === '/' && tail[index + 1] === '*') {
      const end = tail.indexOf('*/', index + 2);
      index = end === -1 ? tail.length : end + 2;
    } else {
      return false;
    }
  }
  return true;
}

export function isConstantRowsScan(detail: string): boolean {
  return CONSTANT_ROWS_SCAN.test(detail.trim());
}

/**
 * CTE names whose every materialization in the plan (CO-ROUTINE/MATERIALIZE
 * node) reads only literal rows — e.g. `WITH wanted(name) AS (VALUES ...)`.
 * Conservative: any table/index/virtual-table scan or nested co-routine below
 * the node disqualifies the CTE, as does a second non-constant node with the
 * same name.
 */
export function findConstantCteNames(planRows: QueryPlanRow[], cteNames: ReadonlySet<string>): Set<string> {
  const children = new Map<number, QueryPlanRow[]>();
  for (const row of planRows) {
    const list = children.get(row.parent) ?? [];
    list.push(row);
    children.set(row.parent, list);
  }
  const verdicts = new Map<string, boolean>();
  for (const row of planRows) {
    const match = /^(?:CO-ROUTINE|MATERIALIZE)\s+(\S+)$/iu.exec(row.detail.trim());
    if (match === null) continue;
    const name = normalizeSqlIdentifier(match[1]);
    if (!cteNames.has(name)) continue;

    let sawConstantScan = false;
    let constant = true;
    const stack = [...(children.get(row.id) ?? [])];
    while (stack.length > 0 && constant) {
      const node = stack.pop()!;
      const detail = node.detail.trim();
      if (isConstantRowsScan(detail)) {
        sawConstantScan = true;
      } else if (/^(?:SCAN|SEARCH|CO-ROUTINE|MATERIALIZE)\b/iu.test(detail)) {
        constant = false;
      }
      stack.push(...(children.get(node.id) ?? []));
    }
    verdicts.set(name, (verdicts.get(name) ?? true) && constant && sawConstantScan);
  }
  return new Set([...verdicts].filter(([, constant]) => constant).map(([name]) => name));
}

/**
 * Every FROM/JOIN name or alias mapped to ALL objects it can denote. Unlike the
 * last-write-wins alias map, an alias reused across subqueries keeps every
 * target, so callers can require an unambiguous resolution.
 */
export function collectTableAliasTargets(tokens: SqlToken[]): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  const add = (key: string, target: string) => {
    const set = targets.get(key) ?? new Set<string>();
    set.add(target);
    targets.set(key, set);
  };
  forEachFromTableReference(tokens, (parts, alias) => {
    const normalizedObject = normalizeObjectReference(parts.join('.'));
    if (normalizedObject === null) return;
    add(normalizedObject, normalizedObject);
    if (alias !== null) add(normalizeSqlIdentifier(alias), normalizedObject);
  });
  return targets;
}

/**
 * True when a plan SCAN reference denotes only literal-row CTEs, so the scan is
 * bounded by the SQL text and must not count toward the cartesian guard.
 */
export function isConstantCteReference(
  rawReference: string,
  aliasTargets: ReadonlyMap<string, ReadonlySet<string>>,
  constantCtes: ReadonlySet<string>,
): boolean {
  const normalized = normalizeObjectReference(rawReference);
  if (normalized === null || normalized.includes('.')) return false;
  const targets = aliasTargets.get(normalized);
  if (targets === undefined || targets.size === 0) return constantCtes.has(normalized);
  return [...targets].every((target) => constantCtes.has(target));
}

/**
 * Plan-text validation identifies sources by the names the plan prints, and
 * SQLite prints the ALIAS. A quoted or string-literal alias can impersonate
 * another plan row ("CONSTANT ROW", "x VIRTUAL TABLE", "sde_types junk"), so
 * table aliases must be plain identifiers that map back to the SQL text.
 */
export function findUntrackableTableAlias(tokens: SqlToken[]): string | null {
  let found: string | null = null;
  forEachFromTableReference(tokens, () => {}, (token) => {
    found ??= token.kind === 'string' ? '\'...\'' : token.value;
  });
  return found;
}

export type BtreeAccessViolation = { kind: 'write' } | { kind: 'schema' } | { kind: 'table'; name: string };

/**
 * Authoritative source check on the compiled program: every b-tree the
 * statement opens must be a main-schema table (or one of its indexes) that
 * `isAllowedTable` accepts. Unlike plan text this cannot be spoofed by aliases
 * — the root page identifies the table. Views expand to their base tables,
 * table-valued functions open no b-tree, and writes are refused outright.
 */
export function findDisallowedBtreeAccess(
  db: Db,
  sql: string,
  isAllowedTable: (tableName: string) => boolean,
): BtreeAccessViolation | null {
  const rootPages = new Map<number, string>();
  const schemaRows = db
    .prepare('SELECT rootpage, tbl_name FROM main.sqlite_master WHERE rootpage > 0')
    .all() as Array<{ rootpage: number; tbl_name: string }>;
  for (const row of schemaRows) {
    rootPages.set(row.rootpage, row.tbl_name.toLowerCase());
  }
  const program = db.prepare(`EXPLAIN ${sql}`).all() as Array<{ opcode: string; p2: number; p3: number }>;
  for (const op of program) {
    if (op.opcode === 'OpenWrite') return { kind: 'write' };
    if (op.opcode !== 'OpenRead' && op.opcode !== 'ReopenIdx') continue;
    if (op.p3 !== 0) return { kind: 'schema' };
    const table = rootPages.get(op.p2);
    // Unknown root page (sqlite_master itself, or anything unexpected): deny.
    if (table === undefined) return { kind: 'table', name: `root page ${op.p2}` };
    if (!isAllowedTable(table)) return { kind: 'table', name: table };
  }
  return null;
}

function normalizeSqlIdentifier(value: string): string {
  return value.toLowerCase();
}

export function normalizeObjectReference(value: string): string | null {
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

export function extractCteNames(tokens: SqlToken[]): Set<string> {
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

/**
 * Invokes `visit` for every table reference in each FROM/JOIN clause. Unlike a
 * "first table after FROM" scan, this walks the whole comma-separated table
 * list (`FROM a x, b y, c`) and skips parenthesized subquery sources, so no
 * entry can hide from validation behind a comma. `parts` is the dotted name
 * (e.g. ['main','eve_accounts']); `alias` is the following alias when present.
 * Table references inside subqueries are still visited because the outer loop
 * scans every token and reaches their own FROM/JOIN keywords.
 */
export function forEachFromTableReference(
  tokens: SqlToken[],
  visit: (parts: string[], alias: string | null) => void,
  onUntrackableAlias?: (token: SqlToken) => void,
): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].upper !== 'FROM' && tokens[index].upper !== 'JOIN') {
      continue;
    }

    let cursor = index + 1;
    for (;;) {
      let parts: string[] | null = null;

      if (tokens[cursor]?.value === '(') {
        // Subquery / parenthesized source: skip it whole, but still consume a
        // trailing alias and any following comma so the next table is seen.
        cursor = skipParenthesizedTokens(tokens, cursor);
      } else {
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
          break;
        }
        parts = nameParts;
      }

      if (tokens[cursor]?.upper === 'AS') {
        cursor += 1;
      }
      const aliasToken = tokens[cursor];
      if (aliasToken !== undefined && (aliasToken.kind === 'string'
        || (aliasToken.kind === 'quoted' && !PLAIN_IDENTIFIER.test(aliasToken.value)))) {
        onUntrackableAlias?.(aliasToken);
      }
      if (isSqlIdentifierToken(tokens[cursor]) && !SDE_ALIAS_STOP_KEYWORDS.has(tokens[cursor].upper)) {
        if (parts !== null) {
          visit(parts, tokens[cursor].value);
        }
        cursor += 1;
      } else if (parts !== null) {
        visit(parts, null);
      }

      if (tokens[cursor]?.value === ',') {
        cursor += 1;
        continue;
      }
      break;
    }
  }
}

/**
 * The first schema-qualified FROM/JOIN table reference (`main.x`, `temp.x`) in
 * the SQL text, or null. Covers every entry of a comma-separated table list,
 * so a qualified table cannot slip in as the 2nd+ entry.
 */
export function findSchemaQualifiedTableReference(tokens: SqlToken[]): string | null {
  let found: string | null = null;
  forEachFromTableReference(tokens, (parts) => {
    if (found === null && parts.length > 1) {
      found = parts.join('.');
    }
  });
  return found;
}

export function extractTableAliases(tokens: SqlToken[]): Map<string, string> {
  const aliases = new Map<string, string>();
  forEachFromTableReference(tokens, (parts, alias) => {
    const normalizedObject = normalizeObjectReference(parts.join('.'));
    if (normalizedObject === null) {
      return;
    }
    aliases.set(normalizedObject, normalizedObject);
    if (alias !== null) {
      aliases.set(normalizeSqlIdentifier(alias), normalizedObject);
    }
  });
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

/**
 * Every table/view name in the database, lower-cased (real virtual tables
 * included). Deliberately uncached: a table created after the first query must
 * never be mistaken for a table-valued function.
 */
function getAllSchemaObjects(db: Db): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all() as { name: string }[];
  return new Set(rows.map((row) => row.name.toLowerCase()));
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

  const untrackableAlias = findUntrackableTableAlias(tokens);
  if (untrackableAlias !== null) {
    return `Table aliases must be plain identifiers (letters, digits, underscore); got ${untrackableAlias}`;
  }

  const allowedObjects = getAllowedSdeObjects(db);
  const aliasMap = extractTableAliases(tokens);
  const aliasTargets = collectTableAliasTargets(tokens);
  const cteNames = extractCteNames(tokens);

  let planRows: QueryPlanRow[];
  let btreeViolation: BtreeAccessViolation | null;
  try {
    planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as QueryPlanRow[];
    btreeViolation = findDisallowedBtreeAccess(db, sql, (table) => allowedObjects.has(table));
  } catch (err) {
    return `SQL error: ${(err as Error).message}`;
  }
  if (btreeViolation !== null) {
    if (btreeViolation.kind === 'write') return 'Write operations are not allowed';
    if (btreeViolation.kind === 'schema') return 'Only main SDE tables are allowed';
    return `Only SDE tables are allowed (got "${btreeViolation.name}")`;
  }
  const constantCtes = findConstantCteNames(planRows, cteNames);

  const referencedObjects = new Set<string>();
  const schemaObjects = getAllSchemaObjects(db);
  // A VIRTUAL TABLE plan row whose name is not a real schema object is a
  // table-valued function (json_each / json_tree), usually under an alias
  // the FROM parser cannot see (`json_each(...) j`). It reads no table — any
  // table inside its arguments appears as its own plan row and is validated —
  // and its SCAN is bounded by one JSON value, so it is neither a reference
  // nor a full scan. Real virtual tables (e.g. FTS) resolve to a schema
  // object and stay fully validated.
  const isTableValuedFunctionRow = (detail: string): boolean => {
    if (!/VIRTUAL TABLE/i.test(detail)) return false;
    return extractPlanReferences(detail).every((rawReference) => {
      const normalized = normalizeObjectReference(rawReference);
      if (normalized === null) return false;
      const resolved = aliasMap.get(normalized) ?? normalized;
      return !schemaObjects.has(resolved.split('.').at(-1) ?? '');
    });
  };

  for (const row of planRows) {
    // Literal rows (VALUES / constant SELECT) name no table: "SCAN 2 CONSTANT ROWS".
    if (isTableValuedFunctionRow(row.detail) || isConstantRowsScan(row.detail)) continue;
    for (const rawReference of extractPlanReferences(row.detail)) {
      const normalizedReference = normalizeObjectReference(rawReference);
      const resolvedReference = aliasMap.get(normalizedReference ?? '') ?? normalizedReference;

      if (resolvedReference === null) {
        return `Query references an unsupported source: ${rawReference}`;
      }

      const referenceParts = resolvedReference.split('.');
      const baseName = referenceParts.at(-1);
      // A CTE (and the "constant" plan token) is always an unqualified name;
      // SQLite does not allow a schema on a CTE. A schema-qualified reference
      // (main.x, temp.x) is therefore a real table and must be validated even
      // when its base name happens to collide with a declared CTE name —
      // otherwise `WITH sde_x AS (...) SELECT ... FROM main.eve_accounts`
      // would be skipped and read the real table.
      if (referenceParts.length === 1 && baseName !== undefined && (cteNames.has(baseName) || SDE_IGNORED_PLAN_REFERENCES.has(baseName))) {
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
  // join shows up as SEARCH (bounded), so only count SCAN rows. Literal rows and
  // scans of literal-only CTEs are bounded by the SQL text, so they do not count.
  const isUnboundedScanRow = (detail: string): boolean => {
    const trimmed = detail.trim();
    if (!/^SCAN\b/i.test(trimmed) || isConstantRowsScan(trimmed)) return false;
    const reference = /^SCAN\s+(\S+)/iu.exec(trimmed)?.[1];
    return reference === undefined || !isConstantCteReference(reference, aliasTargets, constantCtes);
  };
  const fullScans = planRows.filter((row) => isUnboundedScanRow(row.detail)
    && !isTableValuedFunctionRow(row.detail)).length;
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
  const statement = stripStatementTerminator(sql);
  if (!statement.ok) {
    return { ok: false, rows: [], count: 0, error: statement.error };
  }
  const trimmed = statement.sql;
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
