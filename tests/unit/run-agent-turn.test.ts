import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const { handleAgentMessageMock, readUserProfileMock, refreshUserProfileMock } = vi.hoisted(() => ({
  handleAgentMessageMock: vi.fn(),
  readUserProfileMock: vi.fn(),
  refreshUserProfileMock: vi.fn(),
}));

vi.mock('../../src/agent/executor.js', () => ({
  handleAgentMessage: handleAgentMessageMock,
}));
vi.mock('../../src/eve/user-profile.js', () => ({
  isUserProfileStale: vi.fn(() => true),
  readUserProfile: readUserProfileMock,
  refreshUserProfile: refreshUserProfileMock,
}));

import { runAgentTurn } from '../../src/chat/shared.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'web')").run();
  db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (-2000000001, 'web')").run();
  db.prepare(`
    INSERT INTO agent_threads (thread_id, chat_id, user_id)
    VALUES ('thread-1', -2000000001, 1)
  `).run();
  handleAgentMessageMock.mockReset();
  handleAgentMessageMock.mockResolvedValue({ text: 'done', peakInputTokens: 0 });
  readUserProfileMock.mockReset();
  refreshUserProfileMock.mockReset();
});

afterEach(() => {
  db.close();
});

describe('runAgentTurn profile ownership', () => {
  it('does not start a fire-and-forget profile refresh when the durable runner disables it', async () => {
    await expect(runAgentTurn(
      db,
      'thread-1',
      { userId: 1, chatId: -2_000_000_001, notificationCapability: 'web' },
      'hello',
      { userMessagePersisted: true, backgroundProfileRefresh: false },
    )).resolves.toBe('done');

    expect(readUserProfileMock).not.toHaveBeenCalled();
    expect(refreshUserProfileMock).not.toHaveBeenCalled();
    expect(handleAgentMessageMock).toHaveBeenCalledTimes(1);
  });
});
