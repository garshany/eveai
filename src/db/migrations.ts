import type { Db } from './sqlite.js';
import { SCHEMA_SQL } from './schema.js';

export function runMigrations(db: Db): void {
  db.exec(SCHEMA_SQL);
}

// Allow running as standalone script: npm run db:migrate
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  const { initDb } = await import('./sqlite.js');
  const { config } = await import('../config.js');
  const db = initDb(config.db.path);
  runMigrations(db);
  db.close();
  console.log('[migrations] Done');
}
