/**
 * Small, realistic SDE slice for agent-tool smoke tests: The Forge / Kimotoro
 * (Jita, Perimeter, New Caldari, Niyabainen) plus one lowsec neighbour, a few
 * ships, minerals, and the dogma attributes the hull/threat code reads.
 */
import type Database from 'better-sqlite3';

export const FORGE = 10000002;
export const KIMOTORO = 20000020;
export const JITA = 30000142;
export const PERIMETER = 30000144;
export const NEW_CALDARI = 30000145;
export const NIYABAINEN = 30000143;
export const TAMA = 30002813;
export const CITADEL = 10000033;
export const NOMINAL = 20000410;
export const RIFTER = 587;
export const DRAKE = 24698;
export const TRITANIUM = 34;
export const PYERITE = 35;
export const PLEX = 44992;
export const JITA_4_4 = 60003760;

export function seedAgentToolSde(db: Database.Database): void {
  db.prepare('INSERT INTO sde_meta (build_number) VALUES (?)').run('3000000');

  const region = db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)');
  region.run(FORGE, 'The Forge', JSON.stringify({ regionID: FORGE, name: { en: 'The Forge' } }));
  region.run(CITADEL, 'The Citadel', JSON.stringify({ regionID: CITADEL, name: { en: 'The Citadel' } }));

  const constellation = db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)');
  constellation.run(KIMOTORO, 'Kimotoro', FORGE, JSON.stringify({ regionID: FORGE }));
  constellation.run(NOMINAL, 'Nomaa', CITADEL, JSON.stringify({ regionID: CITADEL }));

  const system = db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)');
  const systems: Array<[number, string, number, number, number]> = [
    [JITA, 'Jita', KIMOTORO, 0.9459, 0],
    [PERIMETER, 'Perimeter', KIMOTORO, 0.9549, 10],
    [NEW_CALDARI, 'New Caldari', KIMOTORO, 0.9616, -10],
    [NIYABAINEN, 'Niyabainen', KIMOTORO, 0.9566, 5],
    [TAMA, 'Tama', NOMINAL, 0.3, 30],
  ];
  for (const [id, name, constellationId, security, x] of systems) {
    system.run(id, name, constellationId, JSON.stringify({
      solarSystemID: id,
      securityStatus: security,
      securityClass: security >= 0.45 ? 'B' : 'C',
      position: { x: x * 1e16, y: 0, z: 0 },
      position2D: { x, y: 0 },
    }));
  }

  const gate = db.prepare('INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, ?, ?)');
  let gateId = 50000000;
  const link = (a: number, b: number): void => {
    const ab = gateId++;
    const ba = gateId++;
    gate.run(ab, a, b, ba, JSON.stringify({ solarSystemID: a, destination: { solarSystemID: b, stargateID: ba } }));
    gate.run(ba, b, a, ab, JSON.stringify({ solarSystemID: b, destination: { solarSystemID: a, stargateID: ab } }));
  };
  link(JITA, PERIMETER);
  link(JITA, NEW_CALDARI);
  link(JITA, NIYABAINEN);
  link(PERIMETER, TAMA);

  db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
    .run(JITA_4_4, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', JITA, JSON.stringify({ solarSystemID: JITA }));
  const raw = db.prepare('INSERT INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)');
  for (let index = 1; index <= 8; index += 1) {
    raw.run('mapPlanets', String(40009076 + index), `Jita ${index}`, JSON.stringify({ solarSystemID: JITA }));
  }

  const category = db.prepare('INSERT INTO sde_categories (category_id, name, data_json) VALUES (?, ?, ?)');
  category.run(6, 'Ship', JSON.stringify({ name: { en: 'Ship' }, published: true }));
  category.run(4, 'Material', JSON.stringify({ name: { en: 'Material' }, published: true }));
  category.run(7, 'Module', JSON.stringify({ name: { en: 'Module' }, published: true }));
  const group = db.prepare('INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)');
  group.run(25, 'Frigate', 6, JSON.stringify({ categoryID: 6, published: true }));
  group.run(419, 'Combat Battlecruiser', 6, JSON.stringify({ categoryID: 6, published: true }));
  group.run(18, 'Mineral', 4, JSON.stringify({ categoryID: 4, published: true }));
  group.run(1983, 'PLEX', 4, JSON.stringify({ categoryID: 4, published: true }));
  group.run(38, 'Shield Extender', 7, JSON.stringify({ categoryID: 7, published: true }));

  const type = db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)');
  type.run(RIFTER, 'Rifter', 25, JSON.stringify({ groupID: 25, name: { en: 'Rifter' }, mass: 1067000, volume: 27289, published: true, marketGroupID: 64 }));
  type.run(DRAKE, 'Drake', 419, JSON.stringify({ groupID: 419, name: { en: 'Drake' }, mass: 13500000, volume: 252000, published: true, marketGroupID: 471 }));
  type.run(TRITANIUM, 'Tritanium', 18, JSON.stringify({ groupID: 18, name: { en: 'Tritanium' }, volume: 0.01, published: true, marketGroupID: 1857 }));
  type.run(PYERITE, 'Pyerite', 18, JSON.stringify({ groupID: 18, name: { en: 'Pyerite' }, volume: 0.01, published: true, marketGroupID: 1857 }));
  type.run(PLEX, 'PLEX', 1983, JSON.stringify({ groupID: 1983, name: { en: 'PLEX' }, volume: 0.01, published: true, marketGroupID: 1923 }));
  type.run(47408, 'Abyssal Medium Shield Extender', 38, JSON.stringify({ groupID: 38, name: { en: 'Abyssal Medium Shield Extender' }, published: true }));

  const attribute = db.prepare('INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)');
  const attributes: Array<[number, string, string]> = [
    [263, 'shieldCapacity', 'Shield Capacity'],
    [271, 'shieldEmDamageResonance', 'Shield EM Damage Resistance'],
    [272, 'shieldExplosiveDamageResonance', 'Shield Explosive Damage Resistance'],
    [273, 'shieldKineticDamageResonance', 'Shield Kinetic Damage Resistance'],
    [274, 'shieldThermalDamageResonance', 'Shield Thermal Damage Resistance'],
    [265, 'armorHP', 'Armor Hitpoints'],
    [267, 'armorEmDamageResonance', 'Armor EM Damage Resistance'],
    [9, 'hp', 'Structure Hitpoints'],
    [70, 'agility', 'Inertia Modifier'],
    [600, 'warpSpeedMultiplier', 'Warp Speed Multiplier'],
    [72, 'capacityBonus', 'Shield Hitpoint Bonus'],
    [30, 'power', 'Powergrid Usage'],
  ];
  for (const [id, name, displayName] of attributes) {
    attribute.run(id, name, JSON.stringify({ attributeID: id, name, displayName: { en: displayName }, published: true }));
  }
  const dogma = db.prepare('INSERT INTO sde_type_dogma (type_id, data_json) VALUES (?, ?)');
  dogma.run(RIFTER, JSON.stringify({ dogmaAttributes: [
    { attributeID: 263, value: 450 }, { attributeID: 271, value: 1 }, { attributeID: 272, value: 0.5 },
    { attributeID: 273, value: 0.6 }, { attributeID: 274, value: 0.8 }, { attributeID: 265, value: 350 },
    { attributeID: 267, value: 0.4 }, { attributeID: 9, value: 350 }, { attributeID: 70, value: 3.1 },
    { attributeID: 600, value: 5 },
  ] }));
  dogma.run(DRAKE, JSON.stringify({ dogmaAttributes: [
    { attributeID: 263, value: 5000 }, { attributeID: 271, value: 0.25 }, { attributeID: 265, value: 2300 },
    { attributeID: 267, value: 0.5 }, { attributeID: 9, value: 2800 }, { attributeID: 70, value: 0.62 },
    { attributeID: 600, value: 2.7 },
  ] }));
  dogma.run(47408, JSON.stringify({ dogmaAttributes: [
    { attributeID: 72, value: 1400 }, { attributeID: 30, value: 165 },
  ] }));
}
