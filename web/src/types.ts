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
