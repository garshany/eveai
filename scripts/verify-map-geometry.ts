/**
 * Reports what the operator's loaded SDE actually provides for the Perimeter
 * map graph, before anything tries to draw it.
 *
 * The plan is written against the published SDE schema, which promises both
 * `position` and `position2D` on a solar system record. This script checks that
 * promise against the database on this host and prints the fields it found, so
 * a missing coordinate set is a one-line diagnosis instead of a blank map.
 *
 *   npx tsx scripts/verify-map-geometry.ts
 */

import { config } from '../src/config.js';
import { initDb } from '../src/db/sqlite.js';
import { buildMapGraph, MapGraphBuildError } from '../src/eve/map-graph.js';

type SystemRow = { system_id: number; name: string; data_json: string };

function main(): void {
  const db = initDb(config.db.path);

  const total = (db.prepare('SELECT COUNT(*) AS n FROM sde_systems').get() as { n: number }).n;
  const gates = (db.prepare('SELECT COUNT(*) AS n FROM sde_stargates').get() as { n: number }).n;
  console.log(`sde_systems:   ${total}`);
  console.log(`sde_stargates: ${gates}`);
  if (total === 0) {
    console.error('\nSDE is not loaded. Run `npm run setup` first.');
    process.exitCode = 1;
    return;
  }

  const rows = db.prepare('SELECT system_id, name, data_json FROM sde_systems').all() as SystemRow[];
  const fieldCounts = new Map<string, number>();
  let with2d = 0;
  let with3d = 0;
  let withSecurity = 0;
  let sample: { name: string; keys: string[]; raw: string } | null = null;

  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(row.data_json);
      parsed = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    } catch {
      continue;
    }
    for (const key of Object.keys(parsed)) {
      fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
    }
    if (parsed.position2D !== undefined) with2d += 1;
    if (parsed.position !== undefined || parsed.center !== undefined) with3d += 1;
    if (parsed.securityStatus !== undefined || parsed.security !== undefined) withSecurity += 1;
    if (!sample) {
      sample = { name: row.name, keys: Object.keys(parsed), raw: row.data_json.slice(0, 400) };
    }
  }

  console.log(`\nposition2D present: ${with2d}/${total}`);
  console.log(`position/center:    ${with3d}/${total}`);
  console.log(`security field:     ${withSecurity}/${total}`);

  console.log('\nfields on data_json (count):');
  for (const [key, count] of [...fieldCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(28)} ${count}`);
  }

  if (sample) {
    console.log(`\nsample record (${sample.name}):\n  ${sample.raw}`);
  }

  console.log('\nbuilding map graph...');
  try {
    const result = buildMapGraph(db, { force: true });
    console.log(
      `  ok: ${result.meta.systemCount} systems, ${result.meta.edgeCount} directed links, `
      + `geometry=${result.meta.geometrySource}, sde=${result.meta.sdeBuildNumber ?? 'unknown'}`,
    );
  } catch (error) {
    if (error instanceof MapGraphBuildError) {
      console.error(`  FAILED: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    db.close();
  }
}

main();
