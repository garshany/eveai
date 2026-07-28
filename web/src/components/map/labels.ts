/**
 * Мост между машинными ключами сервера и ключами локализации.
 *
 * Сервер отдаёт стабильные машинные идентификаторы (`recent_kills`,
 * `gate_camp`, `hourly`), а не готовый текст: карта двуязычная, и переводы
 * живут в одном месте. Здесь это отображение делается явно и типизированно —
 * динамическая склейка ключа сломалась бы молча при первом переименовании на
 * сервере, а так недостающий ключ виден компилятору.
 *
 * Неизвестный ключ возвращает null: показать сырой машинный идентификатор
 * честнее, чем подставить чужую строку.
 */

import type { TranslationKey } from '../../i18n';
import type { DangerBand, MapLayerFreshness } from '../../types';

const BAND_KEYS: Record<DangerBand, TranslationKey> = {
  calm: 'perimeterBand_calm',
  watch: 'perimeterBand_watch',
  elevated: 'perimeterBand_elevated',
  hostile: 'perimeterBand_hostile',
  lethal: 'perimeterBand_lethal',
};

const TERM_KEYS: Record<string, TranslationKey> = {
  recent_kills: 'perimeterTerm_recent_kills',
  repeat_attackers: 'perimeterTerm_repeat_attackers',
  gate_camp: 'perimeterTerm_gate_camp',
  victim_similarity: 'perimeterTerm_victim_similarity',
  capability_gap: 'perimeterTerm_capability_gap',
  high_value_hull: 'perimeterTerm_high_value_hull',
  security_floor: 'perimeterTerm_security_floor',
  esi_baseline: 'perimeterTerm_esi_baseline',
  quiet_discount: 'perimeterTerm_quiet_discount',
};

const LAYER_KEYS: Record<string, TranslationKey> = {
  kills: 'perimeterLayer_kills',
  esi_kills: 'perimeterLayer_esi_kills',
  esi_jumps: 'perimeterLayer_esi_jumps',
  sovereignty: 'perimeterLayer_sovereignty',
  wormholes: 'perimeterLayer_wormholes',
  graph: 'perimeterLayer_graph',
};

const FRESHNESS_KEYS: Record<MapLayerFreshness['status'], TranslationKey> = {
  live: 'perimeterFresh_live',
  hourly: 'perimeterFresh_hourly',
  cached: 'perimeterFresh_cached',
  unavailable: 'perimeterFresh_unavailable',
};

const RULE_KEYS: Record<string, TranslationKey> = {
  pursuit: 'perimeterRule_pursuit',
  camp_next_hop: 'perimeterRule_camp_next_hop',
  threat_rise: 'perimeterRule_threat_rise',
  value_spike: 'perimeterRule_value_spike',
  capability_gap: 'perimeterRule_capability_gap',
  route_degraded: 'perimeterRule_route_degraded',
  all_clear: 'perimeterRule_all_clear',
  security_band: 'perimeterRule_security_band',
};

export function bandLabelKey(band: DangerBand): TranslationKey {
  return BAND_KEYS[band] ?? BAND_KEYS.calm;
}

export function dangerTermKey(key: string): TranslationKey | null {
  return TERM_KEYS[key] ?? null;
}

export function layerLabelKey(layer: string): TranslationKey | null {
  return LAYER_KEYS[layer] ?? null;
}

export function freshnessKey(status: MapLayerFreshness['status']): TranslationKey {
  return FRESHNESS_KEYS[status] ?? FRESHNESS_KEYS.unavailable;
}

export function advisoryRuleKey(rule: string): TranslationKey | null {
  return RULE_KEYS[rule] ?? null;
}
