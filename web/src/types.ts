export type Character = {
  id: number;
  name: string;
  isActive?: boolean;
};

export type SessionPayload = {
  session: {
    displayName: string;
    csrfToken: string;
    character: Character | null;
    characters: Character[];
  } | null;
  ssoConfigured: boolean;
  turnstileSiteKey: string | null;
};

export type ProfileAvailability = 'available' | 'missing_scope' | 'unavailable';
export type PilotProfile = {
  updatedAt: string;
  character: { id: number; name: string; portraitUrl: string; title: string | null; birthday: string | null; securityStatus: number | null };
  corporation: { id: number; name: string; ticker: string | null } | null;
  alliance: { id: number; name: string; ticker: string | null } | null;
  online: boolean | null;
  location: { solarSystemId: number; solarSystemName: string | null; security: number | null } | null;
  ship: { typeId: number; typeName: string | null; name: string | null } | null;
  skills: { totalSp: number; queued: number; queueEndsAt: string | null } | null;
  wallet: { balance: number } | null;
  availability: Record<'public' | 'online' | 'location' | 'ship' | 'skills' | 'wallet', ProfileAvailability>;
};

export type Conversation = {
  id: string;
  title: string;
  characterId: number | null;
  updatedAt: string;
};

export type ActivityStep = {
  name: string;
  detail?: string;
};

export type WebAgentRequest = {
  requestId: string;
  threadId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  activity: ActivityStep[];
  progressSequence: number;
  streamText: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryAfterMs: number;
};

export type ChatMessage = {
  id: number | string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  activity?: ActivityStep[];
};

/* --- Маркет: контракты /api/web/market/* (см. src/web/market-routes.ts и src/web/market-alert-routes.ts) --- */

export type MarketOrderSide = 'sell' | 'buy';

export type MarketSnapshotRegionMeta = {
  region_id: number;
  fetched_at: string | null;
  age_minutes: number | null;
  stale: boolean;
  last_error: string | null;
};

export type MarketSnapshotMeta = {
  loaded: boolean;
  status: string;
  snapshot_time: string | null;
  age_minutes: number | null;
  stale: boolean;
  rows_loaded: number | null;
  last_error: string | null;
  regions: MarketSnapshotRegionMeta[];
};

export type MarketRegion = {
  region_id: number;
  name: string;
  stargates: number;
};

export type MarketTypeSearchRow = {
  type_id: number;
  name: string;
  group_id: number | null;
  market_group_id: number | null;
};

export type MarketOverview = {
  type_id: number;
  type_name: string | null;
  group_id: number | null;
  group_name: string | null;
  market_group_id: number | null;
  region_id: number;
  best_sell: number | null;
  best_buy: number | null;
  sell_volume: number;
  buy_volume: number;
  sell_orders: number;
  buy_orders: number;
  spread_abs: number | null;
  spread_pct: number | null;
};

export type MarketOrderRow = {
  order_id: number;
  type_id: number;
  region_id: number;
  is_buy_order: boolean;
  price: number;
  volume_remain: number;
  volume_total: number;
  min_volume: number;
  duration: number;
  range: string;
  issued: string;
  system_id: number;
  system_name: string | null;
  station_id: number | null;
  location_id: number;
  location_name: string | null;
};

export type MarketRegionComparisonRow = {
  region_id: number;
  region_name: string | null;
  min_sell: number | null;
  max_buy: number | null;
  sell_volume: number;
  buy_volume: number;
  sell_orders: number;
  buy_orders: number;
};

export type MarketGroupTreeRow = {
  market_group_id: number;
  name: string;
  parent_group_id: number | null;
  has_children: boolean;
};

export type MarketGroupTypeRow = {
  type_id: number;
  name: string;
  group_id: number | null;
  market_group_id: number | null;
};

export type MarketHistoryPoint = {
  date: string;
  order_count: number;
  volume: number;
  highest: number;
  average: number;
  lowest: number;
};

export type MarketHistoryStats = {
  mean_average: number | null;
  median_average: number | null;
  daily_log_return_stddev_percent: number | null;
  change_7d_percent: number | null;
  change_30d_percent: number | null;
  change_90d_percent: number | null;
  mean_daily_volume: number | null;
  trend_slope_per_day: number | null;
};

export type MarketHistoryFreshness = {
  last_synced_at: string | null;
  next_due_at: string | null;
  status: 'ok' | 'error' | null;
  error: string | null;
};

export type MarketHistoryResponse = {
  region_id: number;
  type_id: number;
  series: MarketHistoryPoint[];
  stats: MarketHistoryStats;
  freshness: MarketHistoryFreshness;
};

export type MarketWatchlistItem = {
  type_id: number;
  type_name: string | null;
  region_id: number;
  best_sell: number | null;
  best_buy: number | null;
  created_at: string;
};

export type MarketAlert = {
  alert_id: number;
  type_id: number;
  type_name: string | null;
  region_id: number;
  region_name: string | null;
  side: MarketOrderSide;
  comparator: 'above' | 'below';
  threshold_price: number;
  status: 'active' | 'triggered' | 'disabled';
  created_at: string;
  triggered_at: string | null;
  trigger_price: number | null;
  best_price: number | null;
};

export type MarketAlertEvent = {
  event_id: number;
  alert_id: number;
  type_id: number;
  type_name: string | null;
  region_id: number | null;
  region_name: string | null;
  price: number;
  threshold: number;
  triggered_at: string;
  delivered_at: string | null;
};

export type UsageSums = {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costMicros: number;
  unknownCostEvents: number;
};

export type UsageTotals = UsageSums & {
  totalTokens: number;
  costComplete: boolean;
  since: string | null;
};

export type ModelPricing = { input: number; output: number; cached: number; reasoning: number };

export type UsageDailyRow = { day: string } & UsageSums;
export type UsageMonthlyRow = { month: string } & UsageSums;
export type UsageModelRow = { model: string; tariff: ModelPricing | null } & UsageSums;

export type TransparencyInfrastructure = {
  status: 'not_configured' | 'misconfigured' | 'ok' | 'error';
  monthToDateUsd: number | null;
  byService: Array<{ service: string; costUsd: number }>;
  asOf: string | null;
  error: string | null;
  actualsNote: string | null;
  estimate: { monthlyUsd: number; components: string[] } | null;
};

export type TransparencyPayload = {
  generatedAt: string;
  currency: 'USD';
  currentModel: string;
  totals: UsageTotals;
  daily: UsageDailyRow[];
  monthly: UsageMonthlyRow[];
  models: UsageModelRow[];
  infrastructure: TransparencyInfrastructure;
  fx: { usdRubRate: number; date: string } | null;
  donations: { boostyUrl: string | null };
};

export type MyTransparency = {
  generatedAt: string;
  currency: 'USD';
  totals: UsageTotals;
  daily: UsageDailyRow[];
  monthly: UsageMonthlyRow[];
  models: UsageModelRow[];
};
