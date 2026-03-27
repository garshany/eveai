import { existsSync, rmSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { config } from '../config.js';
import type { UserContext } from '../auth/user-resolver.js';

export function resolveUserProfilePath(ctx: UserContext, characterId: number): string {
  const base = config.userProfile.path;
  const chatId = ctx.chatId;
  if (base.includes('{chat_id}') || base.includes('{character_id}')) {
    return base
      .replace('{chat_id}', chatId !== undefined ? String(chatId) : String(ctx.userId))
      .replace('{character_id}', String(characterId));
  }

  const identifier = chatId !== undefined ? chatId : ctx.userId;
  const pathInfo = parse(base);
  const stem = pathInfo.ext ? pathInfo.name : pathInfo.base || 'USER';
  return join(pathInfo.dir || dirname(base), `${stem}_${identifier}_${characterId}.md`);
}

export function deleteUserProfileArtifact(ctx: UserContext, characterId: number): void {
  const path = resolveUserProfilePath(ctx, characterId);
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}
