import type { Db } from '../db/sqlite.js';

/**
 * Полная карточка предмета для веб-маркета. Всё читается из локального SDE
 * (sde_types/sde_type_dogma/sde_dogma_attributes/sde_dogma_units/
 * sde_meta_groups), сетевых вызовов нет. Локализация (en/ru) резолвится на
 * сервере параметром lang: SDE хранит name/displayName/description как
 * локализованные объекты {en, ru, …}.
 */

export type MarketInfoLang = 'en' | 'ru';

export type MarketTypeInfoAttribute = {
  attribute_id: number;
  name: string | null;
  display_name: string | null;
  value: number;
  unit: string | null;
};

export type MarketTypeInfoAttributeGroup = {
  key: AttributeGroupKey;
  attributes: MarketTypeInfoAttribute[];
};

export type MarketTypeInfoSkill = {
  type_id: number;
  name: string;
  level: number | null;
};

export type MarketTypeInfoVariation = {
  type_id: number;
  name: string;
  meta_group_id: number | null;
  meta_group_name: string | null;
};

export type MarketTypeInfo = {
  type_id: number;
  name: string;
  description: string | null;
  group_id: number | null;
  group_name: string | null;
  category_name: string | null;
  market_group_id: number | null;
  market_group_name: string | null;
  meta_group_id: number | null;
  meta_group_name: string | null;
  mass: number | null;
  volume: number | null;
  capacity: number | null;
  base_price: number | null;
  required_skills: MarketTypeInfoSkill[];
  attribute_groups: MarketTypeInfoAttributeGroup[];
  variations: MarketTypeInfoVariation[];
};

// Группировка атрибутов «как в игре». Ключи уезжают на клиент, который
// локализует их через i18n; порядок массива — порядок блоков на экране.
const ATTRIBUTE_GROUP_ORDER = [
  'fitting',
  'capacitor',
  'shield',
  'armor',
  'structure',
  'propulsion',
  'targeting',
  'drones',
  'misc',
] as const;

type AttributeGroupKey = (typeof ATTRIBUTE_GROUP_ORDER)[number];

const VARIATIONS_LIMIT = 30;

export function getMarketTypeInfo(db: Db, typeId: number, lang: MarketInfoLang = 'en'): MarketTypeInfo | null {
  const typeRow = db.prepare(`
    SELECT t.type_id AS type_id, t.name AS name, t.group_id AS group_id, t.data_json AS data_json,
      g.name AS group_name, c.name AS category_name
    FROM sde_types t
    LEFT JOIN sde_groups g ON g.group_id = t.group_id
    LEFT JOIN sde_categories c ON c.category_id = g.category_id
    WHERE t.type_id = ?
  `).get(typeId) as {
    type_id: number;
    name: string;
    group_id: number | null;
    data_json: string;
    group_name: string | null;
    category_name: string | null;
  } | undefined;
  if (!typeRow) return null;

  const data = safeParse(typeRow.data_json);
  const marketGroupId = readNumber(data, 'market_group_id');
  const metaGroupId = readNumber(data, 'meta_group_id');
  const metaGroupNames = loadMetaGroupNames(db);

  const dogmaRows = db.prepare(`
    SELECT
      COALESCE(json_extract(j.value, '$.attributeID'), json_extract(j.value, '$.attribute_id')) AS attribute_id,
      json_extract(j.value, '$.value') AS value,
      a.name AS name,
      a.data_json AS meta_json
    FROM sde_type_dogma d, json_each(d.data_json, '$.dogmaAttributes') j
    LEFT JOIN sde_dogma_attributes a
      ON a.attribute_id = COALESCE(json_extract(j.value, '$.attributeID'), json_extract(j.value, '$.attribute_id'))
    WHERE d.type_id = ?
    ORDER BY attribute_id ASC
  `).all(typeId) as Array<{
    attribute_id: number | null;
    value: number | string | null;
    name: string | null;
    meta_json: string | null;
  }>;

  const unitNames = loadUnitNames(db);
  const attributes: MarketTypeInfoAttribute[] = [];
  const skillSlots = new Map<number, { skillTypeId: number | null; level: number | null }>();
  for (const row of dogmaRows) {
    if (row.attribute_id === null || row.value === null) continue;
    const value = typeof row.value === 'number' ? row.value : Number(row.value);
    if (!Number.isFinite(value)) continue;
    const meta = row.meta_json ? safeParse(row.meta_json) : {};
    const name = row.name;

    // requiredSkill{N}/requiredSkill{N}Level уходят в отдельный блок навыков,
    // в списке атрибутов они только шумят.
    const skillMatch = name !== null ? /^requiredSkill(\d+)(Level)?$/.exec(name) : null;
    if (skillMatch) {
      const slot = skillSlots.get(Number(skillMatch[1])) ?? { skillTypeId: null, level: null };
      if (skillMatch[2]) slot.level = value;
      else slot.skillTypeId = value;
      skillSlots.set(Number(skillMatch[1]), slot);
      continue;
    }

    // Как в игровом Show Info: служебные атрибуты скрыты. SDE пишет published
    // и булевым false, и числом 0 — оба варианта означают «не показывать».
    const published = readField(meta, 'published');
    if (published === false || published === 0) continue;

    const unitId = readNumber(meta, 'unit_id');
    attributes.push({
      attribute_id: row.attribute_id,
      name,
      display_name: localize(readField(meta, 'display_name'), lang) ?? name,
      value,
      unit: unitId !== null ? unitNames.get(unitId) ?? null : null,
    });
  }

  return {
    type_id: typeRow.type_id,
    name: typeRow.name,
    description: localize(readField(data, 'description'), lang),
    group_id: typeRow.group_id,
    group_name: typeRow.group_name,
    category_name: typeRow.category_name,
    market_group_id: marketGroupId,
    market_group_name: marketGroupId !== null ? lookupName(db, 'sde_market_groups', 'market_group_id', marketGroupId) : null,
    meta_group_id: metaGroupId,
    meta_group_name: metaGroupId !== null ? metaGroupNames.get(metaGroupId) ?? null : null,
    mass: readNumber(data, 'mass'),
    volume: readNumber(data, 'volume'),
    capacity: readNumber(data, 'capacity'),
    base_price: readNumber(data, 'base_price'),
    required_skills: resolveRequiredSkills(db, skillSlots),
    attribute_groups: groupAttributes(attributes),
    variations: loadVariations(db, typeRow, marketGroupId, metaGroupNames),
  };
}

/**
 * SQL мета-цепочки вынесен в константу: тест гоняет по нему EXPLAIN QUERY
 * PLAN и страхует, что фильтр по group_id идёт индексом, а не полным SCAN
 * sde_types (~51k строк на каждое открытие карточки).
 */
export const MARKET_TYPE_INFO_VARIATIONS_SQL = `
  SELECT type_id, name, json_extract(data_json, '$.metaGroupID') AS meta_group_id
  FROM sde_types
  WHERE group_id = ?
    AND json_extract(data_json, '$.marketGroupID') = ?
    AND json_extract(data_json, '$.published') = 1
  ORDER BY meta_group_id ASC, name COLLATE NOCASE ASC
  LIMIT ?
`;

/** Мета-цепочка: опубликованные товары той же SDE-группы и маркет-группы. */
function loadVariations(
  db: Db,
  typeRow: { type_id: number; group_id: number | null },
  marketGroupId: number | null,
  metaGroupNames: Map<number, string>,
): MarketTypeInfoVariation[] {
  if (typeRow.group_id === null || marketGroupId === null) return [];
  const rows = db.prepare(MARKET_TYPE_INFO_VARIATIONS_SQL)
    .all(typeRow.group_id, marketGroupId, VARIATIONS_LIMIT) as Array<{
    type_id: number;
    name: string;
    meta_group_id: number | null;
  }>;
  return rows.map((row) => ({
    type_id: row.type_id,
    name: row.name,
    meta_group_id: row.meta_group_id,
    meta_group_name: row.meta_group_id !== null ? metaGroupNames.get(row.meta_group_id) ?? null : null,
  }));
}

function resolveRequiredSkills(
  db: Db,
  skillSlots: Map<number, { skillTypeId: number | null; level: number | null }>,
): MarketTypeInfoSkill[] {
  const ordered = [...skillSlots.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, slot]) => slot)
    .filter((slot) => slot.skillTypeId !== null);
  if (ordered.length === 0) return [];
  const placeholders = ordered.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT type_id, name FROM sde_types WHERE type_id IN (${placeholders})`,
  ).all(...ordered.map((slot) => slot.skillTypeId)) as Array<{ type_id: number; name: string }>;
  const names = new Map(rows.map((row) => [row.type_id, row.name]));
  return ordered
    .filter((slot) => names.has(slot.skillTypeId!))
    .map((slot) => ({
      type_id: slot.skillTypeId!,
      name: names.get(slot.skillTypeId!)!,
      level: slot.level,
    }));
}

function groupAttributes(attributes: MarketTypeInfoAttribute[]): MarketTypeInfoAttributeGroup[] {
  const buckets = new Map<AttributeGroupKey, MarketTypeInfoAttribute[]>();
  for (const attribute of attributes) {
    const key = classifyAttribute(attribute.name);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(attribute);
    else buckets.set(key, [attribute]);
  }
  return ATTRIBUTE_GROUP_ORDER.flatMap((key) => {
    const bucket = buckets.get(key);
    return bucket && bucket.length > 0 ? [{ key, attributes: bucket }] : [];
  });
}

/** Классификация по стабильному имени атрибута (идентификаторы не локализуются). */
function classifyAttribute(name: string | null): AttributeGroupKey {
  if (name === null) return 'misc';
  if (name.startsWith('shield')) return 'shield';
  if (name.startsWith('armor')) return 'armor';
  if (name === 'hp' || name.startsWith('structure')) return 'structure';
  if (name.includes('capacitor') || name === 'rechargeRate' || name.startsWith('capRecharge')) return 'capacitor';
  if (
    name === 'maxVelocity' || name === 'agility' || name === 'maxWarpSpeed'
    || name.startsWith('warp') || name.includes('propulsionSkill') || name === 'massAddition'
  ) return 'propulsion';
  if (
    name === 'maxTargetRange' || name === 'maxLockedTargets' || name === 'signatureRadius'
    || name === 'trackingSpeed' || name === 'maxRange' || name === 'falloff' || name.startsWith('scan')
  ) return 'targeting';
  if (name.startsWith('drone') || name.startsWith('fighter')) return 'drones';
  if (
    name.startsWith('cpu') || name.startsWith('power') || name.endsWith('Slots')
    || name.includes('Hardpoint') || name === 'upgradeCost' || name === 'maxSubSystems'
  ) return 'fitting';
  return 'misc';
}

function loadMetaGroupNames(db: Db): Map<number, string> {
  const rows = db.prepare('SELECT meta_group_id, name FROM sde_meta_groups').all() as Array<{
    meta_group_id: number;
    name: string;
  }>;
  return new Map(rows.map((row) => [row.meta_group_id, row.name]));
}

function loadUnitNames(db: Db): Map<number, string> {
  const rows = db.prepare('SELECT unit_id, name, data_json FROM sde_dogma_units').all() as Array<{
    unit_id: number;
    name: string;
    data_json: string;
  }>;
  // displayName у единиц человеческий («m³», «Mbit/s»), name — идентификатор.
  return new Map(rows.map((row) => {
    const displayName = localize(readField(safeParse(row.data_json), 'display_name'), 'en');
    return [row.unit_id, displayName ?? row.name];
  }));
}

function lookupName(db: Db, table: string, idColumn: string, id: number): string | null {
  // Идентификаторы таблиц/колонок — из констант этого модуля, не из ввода.
  const row = db.prepare(`SELECT name FROM ${table} WHERE ${idColumn} = ?`).get(id) as { name: string } | undefined;
  return row?.name ?? null;
}

/** SDE хранит тексты как string или локализованный объект {en, ru, …}. */
function localize(value: unknown, lang: MarketInfoLang): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const localized = value as Record<string, unknown>;
  const preferred = localized[lang] ?? localized.en ?? localized['en-us'];
  if (typeof preferred === 'string') return preferred;
  for (const candidate of Object.values(localized)) {
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

/** Читает поле в snake_case, camelCase или camelID варианте (как sde.ts). */
function readField(obj: Record<string, unknown>, snakeCase: string): unknown {
  if (snakeCase in obj) return obj[snakeCase];
  const camel = snakeCase.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camel in obj) return obj[camel];
  const camelId = camel.replace(/Id$/, 'ID');
  if (camelId in obj) return obj[camelId];
  return undefined;
}

function readNumber(obj: Record<string, unknown>, field: string): number | null {
  const value = readField(obj, field);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function safeParse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}
