import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { getMarketTypeInfo, MARKET_TYPE_INFO_VARIATIONS_SQL } from '../../src/eve/market-type-info.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

const RIFTER = 587;
const RIFTER_FLEET = 588;
const OTHER_MARKET_GROUP_TYPE = 589;
const GUNNERY = 3300;

function insertType(typeId: number, name: string, groupId: number | null, data: Record<string, unknown>): void {
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(typeId, name, groupId, JSON.stringify(data));
}

function seedCard(): void {
  db.prepare("INSERT INTO sde_categories (category_id, name, data_json) VALUES (6, 'Ship', '{}')").run();
  db.prepare("INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (25, 'Frigate', 6, '{}')").run();
  db.prepare("INSERT INTO sde_market_groups (market_group_id, name, parent_group_id, data_json) VALUES (61, 'Standard Frigates', NULL, '{}')").run();
  db.prepare("INSERT INTO sde_market_groups (market_group_id, name, parent_group_id, data_json) VALUES (62, 'Navy Frigates', NULL, '{}')").run();
  db.prepare("INSERT INTO sde_meta_groups (meta_group_id, name, data_json) VALUES (1, 'Tech I', '{}')").run();
  db.prepare("INSERT INTO sde_meta_groups (meta_group_id, name, data_json) VALUES (2, 'Tech II', '{}')").run();
  db.prepare("INSERT INTO sde_dogma_units (unit_id, name, data_json) VALUES (101, 'hp', ?)")
    .run(JSON.stringify({ displayName: { en: 'HP', ru: 'ед.' } }));
  db.prepare("INSERT INTO sde_dogma_units (unit_id, name, data_json) VALUES (102, 'skillLevel', '{}')").run();

  insertType(RIFTER, 'Rifter', 25, {
    published: 1,
    marketGroupID: 61,
    metaGroupID: 1,
    mass: 1_067_000,
    volume: 27_289,
    capacity: 140,
    basePrice: 250_000,
    description: { en: 'The Rifter is a versatile frigate.', ru: 'Рифтер — универсальный фрегат.' },
  });
  insertType(RIFTER_FLEET, 'Rifter Fleet Issue', 25, {
    published: 1,
    marketGroupID: 61,
    metaGroupID: 2,
  });
  // Та же SDE-группа, но другая маркет-группа — в варианты не попадает.
  insertType(OTHER_MARKET_GROUP_TYPE, 'Republic Fleet Firetail', 25, {
    published: 1,
    marketGroupID: 62,
    metaGroupID: 4,
  });
  insertType(GUNNERY, 'Gunnery', null, { published: 1 });

  const insertAttribute = db.prepare(
    'INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)',
  );
  insertAttribute.run(263, 'shieldCapacity', JSON.stringify({
    attribute_id: 263,
    displayName: { en: 'Shield Capacity', ru: 'Ёмкость щита' },
    unitID: 101,
    published: true,
  }));
  insertAttribute.run(9, 'hp', JSON.stringify({
    attribute_id: 9,
    displayName: 'Structure HP',
    unitID: 101,
    published: true,
  }));
  insertAttribute.run(182, 'requiredSkill1', JSON.stringify({ attribute_id: 182, published: false }));
  insertAttribute.run(277, 'requiredSkill1Level', JSON.stringify({ attribute_id: 277, published: false }));
  insertAttribute.run(400, 'hiddenInternal', JSON.stringify({ attribute_id: 400, published: false }));
  // SDE встречает published и числом: 0 — тоже «не показывать».
  insertAttribute.run(401, 'hiddenNumeric', JSON.stringify({ attribute_id: 401, published: 0 }));

  db.prepare('INSERT INTO sde_type_dogma (type_id, data_json) VALUES (?, ?)').run(RIFTER, JSON.stringify({
    dogmaAttributes: [
      { attributeID: 263, value: 450 },
      // snake_case вариант ключа тоже поддерживается (SDE нестабилен в именовании).
      { attribute_id: 9, value: 350 },
      { attributeID: 182, value: GUNNERY },
      { attributeID: 277, value: 3 },
      { attributeID: 400, value: 1 },
      { attributeID: 401, value: 1 },
    ],
  }));
}

describe('getMarketTypeInfo', () => {
  it('returns null for an unknown type', () => {
    expect(getMarketTypeInfo(db, 999999)).toBeNull();
  });

  it('assembles the full card with localized description and traits', () => {
    seedCard();
    const info = getMarketTypeInfo(db, RIFTER, 'ru');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('Rifter');
    expect(info!.description).toBe('Рифтер — универсальный фрегат.');
    expect(info!.group_name).toBe('Frigate');
    expect(info!.category_name).toBe('Ship');
    expect(info!.market_group_name).toBe('Standard Frigates');
    expect(info!.meta_group_name).toBe('Tech I');
    expect(info!.mass).toBe(1_067_000);
    expect(info!.volume).toBe(27_289);
    expect(info!.capacity).toBe(140);
    expect(info!.base_price).toBe(250_000);
  });

  it('prefers en and falls back across localized fields', () => {
    seedCard();
    expect(getMarketTypeInfo(db, RIFTER, 'en')!.description).toBe('The Rifter is a versatile frigate.');
    // Rifter Fleet Issue has no description at all.
    expect(getMarketTypeInfo(db, RIFTER_FLEET, 'en')!.description).toBeNull();
  });

  it('resolves attributes to human names and units, grouped like in-game', () => {
    seedCard();
    const info = getMarketTypeInfo(db, RIFTER, 'en')!;
    const groupKeys = info.attribute_groups.map((group) => group.key);
    expect(groupKeys).toEqual(['shield', 'structure']);

    const shield = info.attribute_groups[0]!.attributes[0]!;
    expect(shield).toMatchObject({
      attribute_id: 263,
      name: 'shieldCapacity',
      display_name: 'Shield Capacity',
      value: 450,
      unit: 'HP',
    });
    const structure = info.attribute_groups[1]!.attributes[0]!;
    expect(structure).toMatchObject({ attribute_id: 9, value: 350, unit: 'HP' });

    // Скрытые (published=false/0) и служебные requiredSkill* атрибуты не показываем.
    const allIds = info.attribute_groups.flatMap((group) => group.attributes.map((attr) => attr.attribute_id));
    expect(allIds).not.toContain(400);
    expect(allIds).not.toContain(401);
    expect(allIds).not.toContain(182);
    expect(allIds).not.toContain(277);
  });

  it('localizes attribute display names', () => {
    seedCard();
    const info = getMarketTypeInfo(db, RIFTER, 'ru')!;
    const shield = info.attribute_groups[0]!.attributes[0]!;
    expect(shield.display_name).toBe('Ёмкость щита');
  });

  it('extracts required skills with levels', () => {
    seedCard();
    const info = getMarketTypeInfo(db, RIFTER, 'en')!;
    expect(info.required_skills).toEqual([{ type_id: GUNNERY, name: 'Gunnery', level: 3 }]);
  });

  it('lists the meta chain variations of the same market group', () => {
    seedCard();
    const info = getMarketTypeInfo(db, RIFTER, 'en')!;
    expect(info.variations.map((variation) => variation.type_id)).toEqual([RIFTER, RIFTER_FLEET]);
    expect(info.variations[1]).toMatchObject({ meta_group_id: 2, meta_group_name: 'Tech II' });
  });

  it('runs the variations lookup through the sde_types(group_id) index, not a full scan', () => {
    seedCard();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${MARKET_TYPE_INFO_VARIATIONS_SQL}`)
      .all(25, 61, 30) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail);
    expect(details.some((detail) => detail.includes('idx_sde_types_group_id'))).toBe(true);
    expect(details.some((detail) => detail.startsWith('SCAN sde_types'))).toBe(false);
  });
});
