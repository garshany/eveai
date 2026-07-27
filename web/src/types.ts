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
  estimate: { monthlyUsd: number; components: string[]; note: string } | null;
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
