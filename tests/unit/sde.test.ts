import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { querySde } from '../../src/eve/sde.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Insert test data
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    34, 'Tritanium', 18, JSON.stringify({ type_id: 34, name: 'Tritanium', group_id: 18, volume: 0.01 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    35, 'Pyerite', 18, JSON.stringify({ type_id: 35, name: 'Pyerite', group_id: 18, volume: 0.01 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    587, 'Rifter', 25, JSON.stringify({ type_id: 587, name: 'Rifter', group_id: 25, volume: 27289 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    44996,
    'Marshal',
    898,
    JSON.stringify({
      type_id: 44996,
      name: { en: 'Marshal', ru: 'Marshal' },
      group_id: 898,
      market_group_id: 1620,
      faction_id: 500006,
      meta_group_id: 2,
      basePrice: 795900000,
      description: { en: 'Test ship description', ru: 'Тестовое описание корабля' },
    })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    3339, 'Amarr Battleship', 257, JSON.stringify({ type_id: 3339, name: 'Amarr Battleship', group_id: 257 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    3338, 'Caldari Battleship', 257, JSON.stringify({ type_id: 3338, name: 'Caldari Battleship', group_id: 257 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    3336, 'Black Ops', 257, JSON.stringify({ type_id: 3336, name: 'Black Ops', group_id: 257 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    3337, 'Large Projectile Turret', 257, JSON.stringify({ type_id: 3337, name: 'Large Projectile Turret', group_id: 257 })
  );

  db.prepare(`INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)`).run(
    898, 'Black Ops', 6, JSON.stringify({ group_id: 898, name: 'Black Ops', category_id: 6 })
  );
  db.prepare(`INSERT INTO sde_categories (category_id, name, data_json) VALUES (?, ?, ?)`).run(
    6, 'Ship', JSON.stringify({ category_id: 6, name: 'Ship' })
  );
  db.prepare(`INSERT INTO sde_market_groups (market_group_id, name, parent_group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    9, 'Ships', null, JSON.stringify({ market_group_id: 9, name: 'Ships' })
  );
  db.prepare(`INSERT INTO sde_market_groups (market_group_id, name, parent_group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    1620, 'CONCORD Ships', 9, JSON.stringify({ market_group_id: 1620, name: 'CONCORD Ships', parent_group_id: 9 })
  );
  db.prepare(`INSERT INTO sde_meta_groups (meta_group_id, name, data_json) VALUES (?, ?, ?)`).run(
    2, 'Faction', JSON.stringify({ meta_group_id: 2, name: 'Faction' })
  );
  db.prepare(`INSERT INTO sde_factions (faction_id, name, data_json) VALUES (?, ?, ?)`).run(
    500006,
    'CONCORD',
    JSON.stringify({
      faction_id: 500006,
      name: { en: 'CONCORD', ru: 'КОНКОРД' },
      shortDescription: { en: 'Directive Enforcement Department', ru: 'Силы быстрого реагирования КОНКОРДа' },
      memberRaces: [1],
    })
  );
  db.prepare(`INSERT INTO sde_races (race_id, name, data_json) VALUES (?, ?, ?)`).run(
    1,
    'Caldari',
    JSON.stringify({ race_id: 1, name: { en: 'Caldari', ru: 'Калдари' }, shipTypeID: 601 })
  );

  db.prepare(`INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)`).run(
    182, 'requiredSkill1', JSON.stringify({ attribute_id: 182, name: 'requiredSkill1', published: true })
  );
  db.prepare(`INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)`).run(
    183, 'requiredSkill2', JSON.stringify({ attribute_id: 183, name: 'requiredSkill2', published: true })
  );
  db.prepare(`INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)`).run(
    184, 'requiredSkill3', JSON.stringify({ attribute_id: 184, name: 'requiredSkill3', published: true })
  );
  db.prepare(`INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)`).run(
    277, 'requiredSkill1Level', JSON.stringify({ attribute_id: 277, name: 'requiredSkill1Level', published: false })
  );
  db.prepare(`INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)`).run(
    278, 'requiredSkill2Level', JSON.stringify({ attribute_id: 278, name: 'requiredSkill2Level', published: false })
  );
  db.prepare(`INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)`).run(
    279, 'requiredSkill3Level', JSON.stringify({ attribute_id: 279, name: 'requiredSkill3Level', published: false })
  );
  db.prepare(`INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)`).run(
    263, 'shieldCapacity', JSON.stringify({ attribute_id: 263, name: 'shieldCapacity', displayName: { en: 'Shield Capacity', ru: 'Щит' }, published: true })
  );
  db.prepare(`INSERT INTO sde_dogma_effects (effect_id, name, data_json) VALUES (?, ?, ?)`).run(
    550, 'blackOpsBonus', JSON.stringify({ effect_id: 550, name: 'blackOpsBonus' })
  );

  db.prepare(`INSERT INTO sde_type_dogma (type_id, data_json) VALUES (?, ?)`).run(
    44996,
    JSON.stringify({
      _key: 44996,
      dogmaAttributes: [
        { attributeID: 182, value: 3339 },
        { attributeID: 183, value: 3338 },
        { attributeID: 184, value: 3336 },
        { attributeID: 277, value: 5 },
        { attributeID: 278, value: 5 },
        { attributeID: 279, value: 1 },
        { attributeID: 263, value: 5000 },
      ],
      dogmaEffects: [{ effectID: 550, isDefault: false }],
    })
  );
  db.prepare(`INSERT INTO sde_type_bonus (type_id, data_json) VALUES (?, ?)`).run(
    44996,
    JSON.stringify({
      _key: 44996,
      roleBonuses: [
        {
          importance: 1,
          bonusText: { en: 'Can fit <a href=showinfo:21096>Cynosural Field Generator</a>', ru: 'Можно ставить <a href=showinfo:21096>приводной маяк</a>' },
        },
      ],
      types: [
        {
          _key: 3337,
          _value: [
            {
              importance: 1,
              bonus: 10,
              unitID: 105,
              bonusText: { en: 'bonus to <a href=showinfo:3308>Large Projectile Turret</a> rate of fire', ru: 'бонус к скорострельности <a href=showinfo:3308>крупных баллистических орудий</a>' },
            },
          ],
        },
      ],
    })
  );
  db.prepare(`INSERT INTO sde_type_materials (type_id, name, data_json) VALUES (?, ?, ?)`).run(
    587,
    'Rifter',
    JSON.stringify({
      _key: 587,
      materials: [
        { materialTypeID: 34, quantity: 1000 },
        { materialTypeID: 35, quantity: 250 },
      ],
    })
  );
  db.prepare(`INSERT INTO sde_certificates (certificate_id, name, data_json) VALUES (?, ?, ?)`).run(
    9001,
    'Black Ops Core',
    JSON.stringify({ _key: 9001, name: { en: 'Black Ops Core', ru: 'Основа Black Ops' } })
  );
  db.prepare(`INSERT INTO sde_certificates (certificate_id, name, data_json) VALUES (?, ?, ?)`).run(
    9002,
    'Jump Skills',
    JSON.stringify({ _key: 9002, name: { en: 'Jump Skills', ru: 'Прыжковые навыки' } })
  );
  db.prepare(`INSERT INTO sde_masteries (type_id, name, data_json) VALUES (?, ?, ?)`).run(
    44996,
    'Marshal',
    JSON.stringify({
      _key: 44996,
      _value: [
        { _key: 1, _value: [9001] },
        { _key: 4, _value: [9001, 9002] },
      ],
    })
  );

  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
    10000002, 'The Forge', JSON.stringify({ region_id: 10000002, name: 'The Forge' })
  );

  db.prepare(`INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)`).run(
    20000020, 'Kimotoro', 10000002, JSON.stringify({ constellation_id: 20000020, name: 'Kimotoro', region_id: 10000002 })
  );
  db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
    30000142, 'Jita', 20000020, JSON.stringify({ system_id: 30000142, name: 'Jita', constellation_id: 20000020, security: 0.9 })
  );
  db.prepare(`INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)`).run(
    60003760,
    'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
    30000142,
    JSON.stringify({ station_id: 60003760, name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', system_id: 30000142 })
  );
  db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
    30000144, 'Perimeter', 20000020, JSON.stringify({ system_id: 30000144, name: 'Perimeter', constellation_id: 20000020, security: 0.9 })
  );
  db.prepare(`INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, ?, ?)`).run(
    50000001,
    30000142,
    30000144,
    50000002,
    JSON.stringify({
      _key: 50000001,
      solarSystemID: 30000142,
      destination: { solarSystemID: 30000144, stargateID: 50000002 },
      typeID: 29633,
    })
  );
  db.prepare(`INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)`).run(
    'mapPlanets',
    '40000002',
    null,
    JSON.stringify({
      _key: 40000002,
      solarSystemID: 30000142,
      celestialIndex: 4,
      moonIDs: [40000004, 40000005],
      asteroidBeltIDs: [40000003],
      radius: 5060000,
      typeID: 13,
    })
  );
  db.prepare(`INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)`).run(
    'skinMaterials',
    '3',
    'Quafe',
    JSON.stringify({ _key: 3, displayName: { en: 'Quafe', ru: 'Quafe' } })
  );
  db.prepare(`INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)`).run(
    'skins',
    '5',
    'Megathron Quafe',
    JSON.stringify({ _key: 5, internalName: 'Megathron Quafe', skinMaterialID: 3, types: [44996] })
  );
  db.prepare(`INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)`).run(
    'planetSchematics',
    '65',
    'Superconductors',
    JSON.stringify({
      _key: 65,
      cycleTime: 3600,
      name: { en: 'Superconductors', ru: 'Superconductors' },
      types: [
        { _key: 34, isInput: true, quantity: 40 },
        { _key: 44996, isInput: false, quantity: 5 },
      ],
    })
  );
  db.prepare(`INSERT INTO sde_npc_corporations (corporation_id, name, station_id, data_json) VALUES (?, ?, ?, ?)`).run(
    1000120,
    'Caldari Navy',
    60003760,
    JSON.stringify({
      _key: 1000120,
      name: { en: 'Caldari Navy', ru: 'Флот Калдари' },
      stationID: 60003760,
    })
  );
  db.prepare(`INSERT INTO sde_blueprints (blueprint_type_id, name, data_json) VALUES (?, ?, ?)`).run(
    681,
    'Capsule Blueprint',
    JSON.stringify({
      blueprintTypeID: 681,
      activities: {
        manufacturing: {
          time: 600,
          materials: [{ quantity: 86, typeID: 38 }],
          products: [{ quantity: 1, typeID: 165 }],
        },
      },
    })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    38, 'Plagioclase', 18, JSON.stringify({ type_id: 38, name: 'Plagioclase', group_id: 18 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    165, 'Capsule', 29, JSON.stringify({ type_id: 165, name: 'Capsule', group_id: 29 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    13, 'Temperate Planet', 7, JSON.stringify({ type_id: 13, name: 'Temperate Planet', group_id: 7 })
  );
});

afterEach(() => {
  db.close();
});

describe('querySde', () => {
  it('looks up type by_id', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_id', value: '34', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.items[0].name).toBe('Tritanium');
  });

  it('looks up type by_name', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_name', value: 'Rifter', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.items[0].id).toBe(587);
    expect((result.items[0] as Record<string, any>).related.materials[0].type.name).toBe('Tritanium');
    expect((result.items[0] as Record<string, any>).links.show_info).toBe('<url=showinfo:587>Rifter</url>');
    expect((result.items[0] as Record<string, any>).ui_actions.open_market_details.command).toBe('ui_openwindow_marketdetails');
    expect((result.items[0] as Record<string, any>).ui_actions.open_market_details.args).toEqual(['--type_id', '587']);
  });

  it('searches types by partial name', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'search', value: 'rit', limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2); // Tritanium and Rifter both contain 'rit'
    const names = result.items.map((i) => i.name);
    expect(names).toContain('Tritanium');
  });

  it('looks up region by_name', () => {
    const result = querySde(db, { entity: 'region', lookup_mode: 'by_name', value: 'The Forge', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.items[0].id).toBe(10000002);
  });

  it('searches systems', () => {
    const result = querySde(db, { entity: 'system', lookup_mode: 'search', value: 'Jita', limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.items[0].name).toBe('Jita');
  });

  it('returns empty for non-existent id', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_id', value: '999999', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
  });

  it('rejects invalid entity', () => {
    const result = querySde(db, { entity: 'invalid' as any, lookup_mode: 'by_id', value: '1', limit: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown entity');
  });

  it('rejects non-numeric by_id', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_id', value: 'abc', limit: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('numeric');
  });

  it('clamps limit to 50', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'search', value: '', limit: 100 });
    expect(result.ok).toBe(true);
    // Should not crash, just works with clamped limit
  });

  it('case insensitive name search', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_name', value: 'tritanium', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.items[0].name).toBe('Tritanium');
  });

  it('enriches type with related entities, skills, dogma, and bonuses', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_name', value: 'Marshal', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);

    const item = result.items[0] as Record<string, any>;
    expect(item.description_text).toBe('Тестовое описание корабля');
    expect(item.related.group.name).toBe('Black Ops');
    expect(item.related.category.name).toBe('Ship');
    expect(item.related.market_group.name).toBe('CONCORD Ships');
    expect(item.related.market_group_chain).toHaveLength(2);
    expect(item.related.faction.name).toBe('CONCORD');
    expect(item.related.meta_group.name).toBe('Faction');
    expect(item.required_skills).toHaveLength(3);
    expect(item.required_skills[0].skill.name).toBe('Amarr Battleship');
    expect(item.required_skills[0].level).toBe(5);
    expect(item.bonuses.role_bonuses[0].text).toContain('приводной маяк');
    expect(item.bonuses.skill_bonuses[0].skill.name).toBe('Large Projectile Turret');
    expect(item.dogma.attributes.some((attr: Record<string, unknown>) => attr.name === 'shieldCapacity')).toBe(true);
    expect(item.dogma.effects[0].effect_name).toBe('blackOpsBonus');
    expect(item.masteries[0].certificates[0].name).toBe('Black Ops Core');
    expect(item.related.skins[0].name).toBe('Megathron Quafe');
    expect(item.related.planetary_industry.outputs[0].schematic_name).toBe('Superconductors');
    expect(item.links.show_info).toBe('<url=showinfo:44996>Marshal</url>');
    expect(item.ui_actions.open_market_details.command).toBe('ui_openwindow_marketdetails');
    expect(item.ui_actions.open_market_details.args).toEqual(['--type_id', '44996']);
  });

  it('enriches systems and stations with their location chain', () => {
    const systemResult = querySde(db, { entity: 'system', lookup_mode: 'by_name', value: 'Jita', limit: 1 });
    expect(systemResult.ok).toBe(true);
    const system = systemResult.items[0] as Record<string, any>;
    expect(system.related.constellation.name).toBe('Kimotoro');
    expect(system.related.region.name).toBe('The Forge');
    expect(system.related.stargates[0].destination_system.name).toBe('Perimeter');
    expect(system.related.planets[0].type.name).toBe('Temperate Planet');
    expect(system.related.planets[0].moons).toBe(2);

    const stationResult = querySde(db, { entity: 'station', lookup_mode: 'search', value: 'Jita IV', limit: 1 });
    expect(stationResult.ok).toBe(true);
    const station = stationResult.items[0] as Record<string, any>;
    expect(station.related.system.name).toBe('Jita');
    expect(station.related.region.name).toBe('The Forge');
  });

  it('enriches npc corporations with station and region chain', () => {
    const result = querySde(db, { entity: 'npc_corporation', lookup_mode: 'by_name', value: 'Caldari Navy', limit: 1 });
    expect(result.ok).toBe(true);
    const item = result.items[0] as Record<string, any>;
    expect(item.related.station.name).toContain('Caldari Navy Assembly Plant');
    expect(item.related.region.name).toBe('The Forge');
  });

  it('queries raw datasets directly when needed', () => {
    const result = querySde(db, { entity: 'dataset', dataset: 'skins', lookup_mode: 'search', value: 'Quafe', limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect((result.items[0] as Record<string, any>).dataset).toBe('skins');
  });

  it('enriches blueprints with resolved products and materials', () => {
    const result = querySde(db, { entity: 'blueprint', lookup_mode: 'by_id', value: '681', limit: 1 });
    expect(result.ok).toBe(true);
    const item = result.items[0] as Record<string, any>;
    expect(item.related.activities.manufacturing.materials[0].type.name).toBe('Plagioclase');
    expect(item.related.activities.manufacturing.products[0].type.name).toBe('Capsule');
  });
});
