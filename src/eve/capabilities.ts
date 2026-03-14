import type { Db } from '../db/sqlite.js';
import { getLinkedCharacter } from './sso.js';
import { PROFILES } from './profiles.js';

export interface Capabilities {
  authenticated: boolean;
  characterId: number | null;
  characterName: string | null;
  grantedScopes: string[];
  allowedProfiles: string[];
  missingProfiles: Record<string, string[]>;
}

/**
 * Tool handler for get_eve_capabilities.
 * Returns current character binding, scopes, and which profiles are available.
 *
 * Uses the requiredScopes from each profile definition to determine access.
 */
export function getEveCapabilities(db: Db, _intent: string): Capabilities {
  const char = getLinkedCharacter(db);

  if (!char) {
    // Unauthenticated: only profiles that don't require auth
    const publicProfiles = PROFILES.filter((p) => !p.requiresAuth).map((p) => p.name);
    return {
      authenticated: false,
      characterId: null,
      characterName: null,
      grantedScopes: [],
      allowedProfiles: publicProfiles,
      missingProfiles: {},
    };
  }

  const granted = new Set(char.scopes);
  const allowed: string[] = [];
  const missing: Record<string, string[]> = {};

  for (const profile of PROFILES) {
    if (profile.requiredScopes.length === 0) {
      // Public profile -- always allowed
      allowed.push(profile.name);
      continue;
    }

    // Check if at least the first (main) scope is granted for partial access
    const missingScopes = profile.requiredScopes.filter((s) => !granted.has(s));
    if (missingScopes.length === 0) {
      allowed.push(profile.name);
    } else {
      missing[profile.name] = missingScopes;
    }
  }

  return {
    authenticated: true,
    characterId: char.characterId,
    characterName: char.characterName,
    grantedScopes: char.scopes,
    allowedProfiles: allowed,
    missingProfiles: missing,
  };
}
