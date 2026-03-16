import type { Db } from '../db/sqlite.js';
import { loadEsiCatalog } from './esi-catalog.js';
import { getLinkedCharacter } from './sso.js';

export interface Capabilities {
  authenticated: boolean;
  characterId: number | null;
  characterName: string | null;
  grantedScopes: string[];
  allowedNamespaces: string[];
  deniedNamespaces: Record<string, string[]>;
  accessibleOperations: number;
}

export async function getEveCapabilities(db: Db, _intent: string, chatId?: number): Promise<Capabilities> {
  const linked = getLinkedCharacter(db, chatId);
  const catalog = await loadEsiCatalog();

  const grantedScopes = linked?.scopes ?? [];
  const grantedScopeSet = new Set(grantedScopes);
  const allowedNamespaces = new Set<string>();
  const deniedNamespaces = new Map<string, Set<string>>();
  let accessibleOperations = 0;

  for (const operation of catalog.values()) {
    if (!operation.requiresAuth) {
      allowedNamespaces.add(operation.namespace);
      accessibleOperations += 1;
      continue;
    }
    if (!linked) {
      const bucket = deniedNamespaces.get(operation.namespace) ?? new Set<string>();
      for (const scope of operation.requiredScopes) bucket.add(scope);
      deniedNamespaces.set(operation.namespace, bucket);
      continue;
    }
    const missing = operation.requiredScopes.filter((scope) => !grantedScopeSet.has(scope));
    if (missing.length === 0) {
      allowedNamespaces.add(operation.namespace);
      accessibleOperations += 1;
      continue;
    }
    const bucket = deniedNamespaces.get(operation.namespace) ?? new Set<string>();
    for (const scope of missing) bucket.add(scope);
    deniedNamespaces.set(operation.namespace, bucket);
  }

  return {
    authenticated: Boolean(linked),
    characterId: linked?.characterId ?? null,
    characterName: linked?.characterName ?? null,
    grantedScopes,
    allowedNamespaces: [...allowedNamespaces].sort(),
    deniedNamespaces: Object.fromEntries(
      [...deniedNamespaces.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, [...value].sort()]),
    ),
    accessibleOperations,
  };
}

export async function canAccessOperation(db: Db, operationName: string, chatId?: number): Promise<boolean> {
  const catalog = await loadEsiCatalog();
  const operation = catalog.get(operationName);
  if (!operation) return false;
  if (!operation.requiresAuth) return true;
  const linked = getLinkedCharacter(db, chatId);
  if (!linked) return false;
  return operation.requiredScopes.every((scope) => linked.scopes.includes(scope));
}
