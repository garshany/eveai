import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { executeEveKillTool } from '../../src/eve-kill/executor.js';
import { buildEveKillNamespace, EVE_KILL_TOOL_NAMES } from '../../src/eve-kill/tools.js';
import {
  buildEveKillAnalyticsNamespace,
  EVE_KILL_ANALYTICS_TOOL_NAMES,
} from '../../src/eve-kill/analytics-tools.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => db.close());

describe('local EVE-KILL agent surface', () => {
  it('exposes four strict deferred analytics wrappers in a separate namespace', () => {
    expect(EVE_KILL_ANALYTICS_TOOL_NAMES).toEqual([
      'doctrine_detect',
      'meta_pulse',
      'killmail_forensics',
      'coalition_graph',
    ]);
    const namespace = buildEveKillAnalyticsNamespace();
    expect(namespace.name).toBe('eve_kill_analytics');
    expect(namespace.tools.map((tool) => tool.name)).toEqual(EVE_KILL_ANALYTICS_TOOL_NAMES);
    expect(namespace.tools.every((tool) => tool.strict === true && tool.defer_loading === true)).toBe(true);
    for (const tool of namespace.tools) {
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.parameters.required).toEqual(Object.keys(tool.parameters.properties));
    }
    expect(JSON.stringify(namespace)).not.toContain('type":"mcp');
    expect(namespace.description).toContain('no chat history');
  });

  it('exposes only current third-party discovery, enrichment, aggregate, battle, and watch tools', () => {
    expect(EVE_KILL_TOOL_NAMES).toEqual([
      'kill_search',
      'kill_activity',
      'kill_detail',
      'kill_intel',
      'kill_battles',
      'kill_watch',
    ]);
    const namespace = buildEveKillNamespace();
    expect(namespace.tools.map((tool) => tool.name)).toEqual(EVE_KILL_TOOL_NAMES);
    const serialized = JSON.stringify(namespace);
    for (const forbidden of ['kill_query', 'kill_prices', 'build_price', 'war_killmails', 'corp_history', 'alliance_history', 'members', 'MongoDB']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(namespace.description).toContain('official ESI');
    expect(namespace.description).toContain('local SDE');

    const transientNamespace = buildEveKillNamespace({ includeWatch: false });
    expect(transientNamespace.tools.map((tool) => tool.name)).toEqual([
      'kill_search',
      'kill_activity',
      'kill_detail',
      'kill_intel',
      'kill_battles',
    ]);
    expect(transientNamespace.description).not.toContain('feed watches');
  });

  it('updates feed watches without reconnect-specific side effects', async () => {
    const watched = await executeEveKillTool(db, 'kill_watch', {
      action: 'watch',
      topic_type: 'region',
      topic_id: 10000002,
      label: 'The Forge',
    }, -42);
    const listed = await executeEveKillTool(db, 'kill_watch', { action: 'list' }, -42);

    expect(watched).toMatchObject({ ok: true, source: 'EVE-KILL', topic: 'region.10000002' });
    expect(listed).toMatchObject({
      ok: true,
      source: 'EVE-KILL',
      data: [{ chat_id: -42, topic: 'region.10000002', label: 'The Forge' }],
    });
  });
});
