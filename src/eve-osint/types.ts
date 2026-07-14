export type OsintScope = 'character' | 'corporation' | 'alliance';

export type OsintInferenceArgs = {
  scope: OsintScope;
  id: number;
  windowDays: number;
  includeMemberAnalysis: boolean;
  includeGraph: boolean;
  includeLlmPatternAnalysis: boolean;
};

export type OsintKillmail = {
  roles: {
    attacker: boolean;
    victim: boolean;
  };
  killmail_id: number;
  killmail_time?: string;
  solar_system_id?: number;
  total_value?: number;
  attacker_count: number;
  is_npc?: boolean;
  is_solo?: boolean;
  ship_type_id?: number;
  victim_character_id?: number;
  victim_corporation_id?: number;
  victim_alliance_id?: number;
  attackers: Array<{
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    ship_type_id?: number;
    weapon_type_id?: number;
    final_blow?: boolean;
  }>;
};

export type OsintActivityResult = {
  kills: OsintKillmail[];
  truncated: boolean;
  requestCount: number;
  windows: Array<{ from: string; to: string }>;
};
