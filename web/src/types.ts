export type Character = {
  id: number;
  name: string;
};

export type SessionPayload = {
  session: {
    displayName: string;
    csrfToken: string;
    character: Character | null;
  } | null;
  ssoConfigured: boolean;
  runtime: {
    providerId: 'openai' | 'cheapvibecode';
    providerName: string;
    model: string;
    reasoningEffort: string;
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
