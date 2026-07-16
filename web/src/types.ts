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

export type ScanPayload = {
  source: { transport: 'rest_poll'; running: boolean; lastPollAt: string | null; lastSuccessAt: string | null; lastError: string | null };
  monitor: null | {
    active: boolean; baselineReady: boolean; threatLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null; locationFailures: number;
    characterId: number; characterMatchesActive: boolean;
    origin: { id: number; name: string }; destination: { id: number; name: string }; current: { id: number; name: string };
    routeSystems: Array<{ id: number; name: string }>;
    progress: { completed: number; total: number; remaining: number | null };
    ship: { typeId: number; name: string; ehp: number };
    startedAt: string; lastLocationCheck: string; lastOnlineCheck: string; killsSeen: number;
    dangerEvents: Array<{ systemId: number; systemName: string; time: string; threatLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; description: string }>;
  };
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

export type ChatMessage = {
  id: number | string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  activity?: ActivityStep[];
};
