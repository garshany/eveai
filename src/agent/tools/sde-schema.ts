export const SDE_SCHEMA = `Tables (all read-only, SQLite):
sde_types (type_id INT, name TEXT, group_id INT, data_json TEXT) — 51k items/ships/modules
sde_groups (group_id INT, name TEXT, category_id INT, data_json TEXT)
sde_categories (category_id INT, name TEXT, data_json TEXT)
sde_market_groups (market_group_id INT, name TEXT, parent_group_id INT, data_json TEXT)
sde_systems (system_id INT, name TEXT, constellation_id INT, data_json TEXT) — json has security
sde_constellations (constellation_id INT, name TEXT, region_id INT, data_json TEXT)
sde_regions (region_id INT, name TEXT, data_json TEXT)
sde_stations (station_id INT, name TEXT, system_id INT, data_json TEXT)
sde_stargates (stargate_id INT, system_id INT, destination_system_id INT, destination_stargate_id INT, data_json TEXT)
sde_blueprints (blueprint_type_id INT, name TEXT, data_json TEXT)
sde_factions (faction_id INT, name TEXT, data_json TEXT)
sde_npc_corporations (corporation_id INT, name TEXT, station_id INT, data_json TEXT)
sde_type_dogma (type_id INT, data_json TEXT) — dogma attributes per type, data_json has {dogmaAttributes: [{attributeID, value}]}
sde_type_bonus (type_id INT, data_json TEXT)
sde_type_materials (type_id INT, name TEXT, data_json TEXT)
sde_dogma_attributes (attribute_id INT, name TEXT, data_json TEXT) — 2825 attr definitions, JOIN with sde_type_dogma to resolve attributeID→name
sde_dogma_effects (effect_id INT, name TEXT, data_json TEXT)
sde_dogma_units (unit_id INT, name TEXT, data_json TEXT)
sde_meta_groups (meta_group_id INT, name TEXT, data_json TEXT) — 13 rows: Tech I(1), Tech II(2), Storyline(3), Faction(4), Officer(5), Deadspace(6), Tech III(14), Abyssal(15), Premium(17), Limited Time(19)
sde_races (race_id INT, name TEXT, data_json TEXT) — Caldari, Minmatar, Gallente, Amarr и др.
sde_raw_records (dataset_name TEXT, record_id TEXT, name TEXT, data_json TEXT) — raw SDE datasets like mapPlanets

data_json fields accessed via json_extract():
  sde_systems.data_json: security (float), securityClass (text)
  sde_types.data_json: mass, volume, capacity, basePrice, published (bool), marketGroupID, metaGroupID, portionSize
  sde_blueprints.data_json: activities.manufacturing.materials[], activities.manufacturing.products[]
  sde_raw_records datasets: mapPlanets (solarSystemID, planetIndex, moonIDs[]), mapMoons (344k), mapAsteroidBelts (40k), mapStars (8k), planetResources (25k, schematicID, planetIndex), planetSchematics (cycleTime, nameID, pins)

Dogma lookup (resolve attributeID to name+value for a type):
  SELECT a.name, json_extract(j.value,'$.value') AS val
  FROM sde_type_dogma d, json_each(d.data_json,'$.dogmaAttributes') j
  JOIN sde_dogma_attributes a ON a.attribute_id=json_extract(j.value,'$.attributeID')
  WHERE d.type_id=<ID> AND a.name IN ('shieldCapacity','shieldRechargeRate','shieldEmDamageResonance','shieldThermalDamageResonance','shieldKineticDamageResonance','shieldExplosiveDamageResonance','armorHP','armorEmDamageResonance','armorThermalDamageResonance','armorKineticDamageResonance','armorExplosiveDamageResonance','maxVelocity','agility','signatureRadius','droneCapacity','droneBandwidth','maxRange','falloff','trackingSpeed','capacitorCapacity','rechargeRate','cpuOutput','powerOutput','hp')
Resonance 0-1: resist = 1 - resonance. rechargeRate is in ms.`;
