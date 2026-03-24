import 'dotenv/config';
import { existsSync } from 'node:fs';
import { initDb } from './sqlite.js';

type SessionRow = {
  chat_id: number;
  username: string | null;
  active_character_id: number | null;
};

type LinkRow = {
  chat_id: number;
  character_id: number;
  character_name: string;
};

type OrphanAccountRow = {
  character_id: number;
  character_name: string;
};

const dbPath = process.env.DB_PATH || './data/eve-agent.db';

function main(): void {
  if (!existsSync(dbPath)) {
    console.log(`DB not found: ${dbPath}`);
    process.exit(1);
  }

  const db = initDb(dbPath);
  try {
    const sessions = db.prepare(
      'SELECT chat_id, username, active_character_id FROM telegram_sessions ORDER BY chat_id'
    ).all() as SessionRow[];

    const links = db.prepare(`
      SELECT l.chat_id, l.character_id, a.character_name
      FROM eve_character_links l
      JOIN eve_accounts a ON a.character_id = l.character_id
      ORDER BY l.chat_id, a.character_name COLLATE NOCASE, l.character_id
    `).all() as LinkRow[];

    const linksByChat = new Map<number, LinkRow[]>();
    for (const link of links) {
      const bucket = linksByChat.get(link.chat_id) ?? [];
      bucket.push(link);
      linksByChat.set(link.chat_id, bucket);
    }

    const orphanAccounts = db.prepare(`
      SELECT a.character_id, a.character_name
      FROM eve_accounts a
      LEFT JOIN eve_character_links l ON l.character_id = a.character_id
      WHERE l.character_id IS NULL
      ORDER BY a.character_name COLLATE NOCASE, a.character_id
    `).all() as OrphanAccountRow[];

    console.log(`DB: ${dbPath}`);
    console.log(`telegram_sessions=${sessions.length}`);
    console.log(`eve_character_links=${links.length}`);
    console.log(`orphan_eve_accounts=${orphanAccounts.length}`);
    console.log('');

    for (const session of sessions) {
      const sessionLinks = linksByChat.get(session.chat_id) ?? [];
      const activeLinked = session.active_character_id === null
        ? true
        : sessionLinks.some((entry) => entry.character_id === session.active_character_id);
      const state = sessionLinks.length === 0
        ? 'needs_login'
        : activeLinked
          ? 'ok'
          : 'invalid_active_character';

      const linkedText = sessionLinks.length === 0
        ? 'none'
        : sessionLinks
            .map((entry) => `${entry.character_name} (${entry.character_id})${entry.character_id === session.active_character_id ? ' [active]' : ''}`)
            .join(', ');

      console.log(
        `chat_id=${session.chat_id} username=${session.username ?? '-'} state=${state} active_character_id=${session.active_character_id ?? 'null'}`
      );
      console.log(`  linked_characters: ${linkedText}`);
    }

    if (orphanAccounts.length > 0) {
      console.log('');
      console.log('orphan_eve_accounts:');
      for (const account of orphanAccounts) {
        console.log(`  ${account.character_name} (${account.character_id})`);
      }
    }
  } finally {
    db.close();
  }
}

main();
