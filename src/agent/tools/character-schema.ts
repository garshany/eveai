export const CHARACTER_SCHEMA = `Private character profile tables (read-only, SQLite). Scope: ONLY the currently linked character — character_id is enforced server-side; never filter by it yourself.
Synced lazily from ESI per dataset TTL; check character_sync_state for freshness per dataset.
character_assets (item_id INT, type_id INT, location_id INT, location_type TEXT, location_flag TEXT, quantity INT, is_singleton INT, is_blueprint_copy INT, data_json TEXT, synced_at TEXT) — full unfiltered ESI asset list
character_wallet (balance REAL, synced_at TEXT) — current ISK balance
character_wallet_journal (journal_id INT, date TEXT, ref_type TEXT, amount REAL, balance REAL, first_party_id INT, second_party_id INT, description TEXT, context_id INT, context_id_type TEXT, data_json TEXT, synced_at TEXT) — append-only history
character_orders (order_id INT, type_id INT, region_id INT, location_id INT, price REAL, volume_total INT, volume_remain INT, min_volume INT, is_buy_order INT, range TEXT, duration INT, issued TEXT, escrow REAL, data_json TEXT, synced_at TEXT) — open market orders
character_contracts (contract_id INT, type TEXT, status TEXT, availability TEXT, price REAL, reward REAL, collateral REAL, volume REAL, title TEXT, date_issued TEXT, date_expired TEXT, date_accepted TEXT, date_completed TEXT, issuer_id INT, assignee_id INT, acceptor_id INT, start_location_id INT, end_location_id INT, for_corporation INT, data_json TEXT, synced_at TEXT)
character_skills (skill_id INT, trained_skill_level INT, active_skill_level INT, skillpoints_in_skill INT, data_json TEXT, synced_at TEXT)
character_skillqueue (queue_position INT, skill_id INT, finished_level INT, start_date TEXT, finish_date TEXT, level_end_sp INT, data_json TEXT, synced_at TEXT)
character_clones (jump_clone_id INT, location_id INT, location_type TEXT, name TEXT, implants_json TEXT, data_json TEXT, synced_at TEXT)
character_standings (from_id INT, from_type TEXT, standing REAL, data_json TEXT, synced_at TEXT)
character_presence (solar_system_id INT, station_id INT, structure_id INT, ship_type_id INT, ship_name TEXT, ship_item_id INT, online INT, last_login TEXT, last_logout TEXT, synced_at TEXT) — single row: location + ship + online
character_profile (character_name TEXT, total_skill_points INT, unallocated_skill_points INT, implants_json TEXT, home_location_json TEXT, synced_at TEXT) — single row rollup
character_sync_state (dataset TEXT, status TEXT, rows_synced INT, synced_at TEXT, expires_at TEXT, error TEXT) — per-dataset freshness; status ok/error/no_scope

All character_* tables join to SDE: a.type_id = t.type_id (sde_types), location_id = s.station_id (sde_stations) or s.system_id (sde_systems), skill_id = t.type_id.
Most valuable assets example:
  SELECT t.name, SUM(a.quantity) AS qty
  FROM character_assets a JOIN sde_types t ON t.type_id = a.type_id
  GROUP BY a.type_id ORDER BY qty DESC LIMIT 10;
Value ranking needs prices: collect type_ids here, then call batch_market_prices (Jita=10000002) and multiply by quantity.`;
