import { describe, expect, it } from 'vitest';
import {
  getActivitySink,
  reportActivity,
  runWithActivitySink,
  summarizeToolArgs,
  type AgentActivityEvent,
  type AgentActivitySink,
} from '../../src/agent/activity.js';

function collectingSink(): { sink: AgentActivitySink; events: AgentActivityEvent[] } {
  const events: AgentActivityEvent[] = [];
  return { sink: { emit: (e) => events.push(e) }, events };
}

describe('agent activity sink', () => {
  it('is a no-op with no active sink', () => {
    expect(getActivitySink()).toBeUndefined();
    // Must not throw when nothing is listening.
    expect(() => reportActivity({ type: 'tool_start', name: 'sde_sql' })).not.toThrow();
  });

  it('delivers events to the sink active for the wrapped call', async () => {
    const { sink, events } = collectingSink();
    await runWithActivitySink(sink, async () => {
      expect(getActivitySink()).toBe(sink);
      reportActivity({ type: 'model_turn', iteration: 0 });
      reportActivity({ type: 'tool_start', name: 'batch_market_prices', detail: '2 items' });
      reportActivity({ type: 'reasoning', text: 'thinking' });
    });
    expect(events.map((e) => e.type)).toEqual(['model_turn', 'tool_start', 'reasoning']);
    // Sink is scoped to the wrapped call only.
    expect(getActivitySink()).toBeUndefined();
    reportActivity({ type: 'reasoning', text: 'leak?' });
    expect(events).toHaveLength(3);
  });

  it('does not leak a sink across concurrent scopes', async () => {
    const a = collectingSink();
    const b = collectingSink();
    await Promise.all([
      runWithActivitySink(a.sink, async () => {
        await new Promise((r) => setTimeout(r, 5));
        reportActivity({ type: 'tool_start', name: 'a_only' });
      }),
      runWithActivitySink(b.sink, async () => {
        reportActivity({ type: 'tool_start', name: 'b_only' });
      }),
    ]);
    expect(a.events).toEqual([{ type: 'tool_start', name: 'a_only' }]);
    expect(b.events).toEqual([{ type: 'tool_start', name: 'b_only' }]);
  });

  it('never lets a throwing sink break the turn', async () => {
    const sink: AgentActivitySink = { emit: () => { throw new Error('render boom'); } };
    await runWithActivitySink(sink, async () => {
      expect(() => reportActivity({ type: 'reasoning', text: 'x' })).not.toThrow();
    });
  });

  it('summarizes common tool args for the activity line', () => {
    expect(summarizeToolArgs('batch_market_prices', { type_ids: [1, 2, 3] })).toBe('3 items');
    expect(summarizeToolArgs('batch_market_prices', { type_ids: [44992] })).toBe('1 item');
    expect(summarizeToolArgs('plan_route', { origin: 'Jita', destination: 'Amarr' })).toBe('Jita→Amarr');
    expect(summarizeToolArgs('web_search', { query: 'tornado fit' })).toBe('tornado fit');
    expect(summarizeToolArgs('sde_sql', { sql: 'SELECT 1' })).toBe('query');
    expect(summarizeToolArgs('get_eve_capabilities', { intent: 'read assets' })).toBe('read assets');
    expect(summarizeToolArgs('unknown_tool', {})).toBeUndefined();
  });
});
