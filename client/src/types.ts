export type PageKind = 'landing' | 'dashboard' | 'handoff';

export interface AppConfig {
  page: PageKind;
  botUsername: string;
  authUrl: string;
  botLink: string;
}

export interface ProfileCharacter {
  characterId: number;
  characterName: string;
  portrait: string;
  isActive: boolean;
}

export interface ProfileResponse {
  displayName: string;
  telegramUsername?: string;
  characters: ProfileCharacter[];
}
