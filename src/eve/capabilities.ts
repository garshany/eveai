import type { Db } from '../db/sqlite.js';
import { loadEsiCatalog } from './esi-catalog.js';
import { getLinkedCharacter } from './sso.js';
import type { UserContext } from '../auth/user-resolver.js';

export interface Capabilities {
  authenticated: boolean;
  characterId: number | null;
  characterName: string | null;
  grantedScopes: string[];
  allowedNamespaces: string[];
  deniedNamespaces: Record<string, string[]>;
  accessibleOperations: number;
}

type CapabilitySnapshot = {
  characterId: number;
  capturedAt: number;
};

const CAPABILITY_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const capabilitySnapshots = new Map<string, CapabilitySnapshot>();

export async function getEveCapabilities(db: Db, _intent: string, ctx: UserContext): Promise<Capabilities> {
  const linked = getLinkedCharacter(db, ctx);
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

  const result = {
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

  recordCapabilitySnapshot(ctx, result);
  return result;
}

export async function canAccessOperation(db: Db, operationName: string, ctx: UserContext): Promise<boolean> {
  const catalog = await loadEsiCatalog();
  const operation = catalog.get(operationName);
  if (!operation) return false;
  if (!operation.requiresAuth) return true;
  const linked = getLinkedCharacter(db, ctx);
  if (!linked) return false;
  return operation.requiredScopes.every((scope) => linked.scopes.includes(scope));
}

export function hasFreshCapabilitySnapshot(ctx: UserContext, characterId: number | null): boolean {
  if (!characterId) return false;
  const key = buildCapabilitySnapshotKey(ctx);
  const snapshot = capabilitySnapshots.get(key);
  if (!snapshot) return false;
  if (snapshot.characterId !== characterId) return false;
  if (Date.now() - snapshot.capturedAt > CAPABILITY_SNAPSHOT_TTL_MS) {
    capabilitySnapshots.delete(key);
    return false;
  }
  return true;
}

export function clearCapabilitySnapshots(): void {
  capabilitySnapshots.clear();
}

function recordCapabilitySnapshot(ctx: UserContext, capabilities: Capabilities): void {
  if (!capabilities.authenticated || !capabilities.characterId) return;
  capabilitySnapshots.set(buildCapabilitySnapshotKey(ctx), {
    characterId: capabilities.characterId,
    capturedAt: Date.now(),
  });
}

function buildCapabilitySnapshotKey(ctx: UserContext): string {
  return `${ctx.userId}:${ctx.chatId ?? 'none'}`;
}
