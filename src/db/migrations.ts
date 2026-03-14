import type { Db } from './sqlite.js';
import { SCHEMA_SQL } from './schema.js';

export function runMigrations(db: Db): void {
  db.exec(SCHEMA_SQL);
}
