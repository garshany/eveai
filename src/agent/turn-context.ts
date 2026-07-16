import type { UserContext } from '../auth/user-resolver.js';
import type { Db } from '../db/sqlite.js';
import { getLinkedCharacter } from '../eve/sso.js';

export type TurnIdentitySnapshot = Readonly<{
  userId: number;
  chatId: number | null;
  characterId: number | null;
  characterName: string | null;
  grantedScopes: readonly string[];
  activeCharacterVersion: number;
  identityVersion: string;
}>;

export type AgentTurnContext = TurnIdentitySnapshot & Readonly<{
  requestId: string;
  threadId: string;
  locale: string;
  startedAt: number;
  deadlineAt: number;
}>;

type LinkedCharacter = ReturnType<typeof getLinkedCharacter>;

export function captureTurnIdentity(
  db: Db,
  ctx: UserContext,
  linked: LinkedCharacter = getLinkedCharacter(db, ctx),
): TurnIdentitySnapshot {
  const scopes = [...(linked?.scopes ?? [])].sort((left, right) => left.localeCompare(right));
  const activeCharacterVersion = readActiveCharacterVersion(db, ctx.userId);
  return Object.freeze({
    userId: ctx.userId,
    chatId: ctx.chatId ?? null,
    characterId: linked?.characterId ?? null,
    characterName: linked?.characterName ?? null,
    grantedScopes: Object.freeze(scopes),
    activeCharacterVersion,
    identityVersion: buildIdentityVersion(linked?.characterId ?? null, scopes, activeCharacterVersion),
  });
}

export function buildAgentTurnContext(
  identity: TurnIdentitySnapshot,
  input: {
    requestId: string;
    threadId: string;
    locale: string;
    startedAt?: number;
    deadlineMs: number;
  },
): AgentTurnContext {
  const startedAt = input.startedAt ?? Date.now();
  return Object.freeze({
    ...identity,
    requestId: input.requestId,
    threadId: input.threadId,
    locale: input.locale,
    startedAt,
    deadlineAt: startedAt + input.deadlineMs,
  });
}

export function isTurnIdentityCurrent(
  db: Db,
  ctx: UserContext,
  expected: TurnIdentitySnapshot,
): boolean {
  if (ctx.userId !== expected.userId || (ctx.chatId ?? null) !== expected.chatId) return false;
  const current = getLinkedCharacter(db, ctx);
  const scopes = [...(current?.scopes ?? [])].sort((left, right) => left.localeCompare(right));
  return buildIdentityVersion(
    current?.characterId ?? null,
    scopes,
    readActiveCharacterVersion(db, ctx.userId),
  ) === expected.identityVersion;
}

function buildIdentityVersion(
  characterId: number | null,
  scopes: readonly string[],
  activeCharacterVersion: number,
): string {
  return `${characterId ?? 'anonymous'}:${activeCharacterVersion}:${scopes.join(',')}`;
}

function readActiveCharacterVersion(db: Db, userId: number): number {
  if (userId <= 0) return 0;
  const row = db.prepare('SELECT active_character_version FROM users WHERE user_id = ?')
    .get(userId) as { active_character_version: number } | undefined;
  return row?.active_character_version ?? 0;
}
