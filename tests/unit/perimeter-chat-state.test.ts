import { describe, expect, it } from 'vitest';
import { mergePerimeterHistory, PerimeterHistoryGate } from '../../web/src/components/map/perimeter-chat-state.js';
import { mergeAdvisoryMessages } from '../../web/src/components/map/live-merge.js';
import type { PerimeterMessage } from '../../web/src/types.js';
const message = (id: number, content = 'hello'): PerimeterMessage => ({ id, content, role: 'user', createdAt: 'now', meta: null });
describe('Perimeter history reconciliation', () => {
  it('does not rerender identical polling snapshots', () => {
    const old = [message(1)];
    expect(mergePerimeterHistory(old, [message(1)])).toBe(old);
  });
  it('keeps live tail and stable rows while replacing changed rows', () => {
    const old = [message(1), message(3)];
    const merged = mergePerimeterHistory(old, [message(1, 'updated'), message(2)]);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(merged[2]).toBe(old[1]);
  });
  it('keeps older loaded rows when polling returns only the latest history window', () => {
    const previous = [message(1), message(2), message(3)];
    expect(mergePerimeterHistory(previous, [message(2), message(3)])).toBe(previous);
  });
  it('does not remove a repeated optimistic question just because older text matches', () => {
    const old = [message(1), message(-1)];
    expect(mergePerimeterHistory(old, [message(1)])).toBe(old);
    expect(mergePerimeterHistory(old, [message(1), message(2)]).map((m) => m.id)).toEqual([1, 2]);
  });
  it('rejects history from before reset and out of order snapshots', () => {
    const gate = new PerimeterHistoryGate();
    const before = gate.begin();
    gate.invalidate();
    expect(gate.accepts(before)).toBe(false);
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.accepts(first)).toBe(false);
    expect(gate.accepts(second)).toBe(true);
  });
  it('bounds live transcript growth during a long flight', () => {
    const old = Array.from({ length: 100 }, (_, i) => message(i + 1));
    const merged = mergeAdvisoryMessages(old, [message(101)], 0);
    expect(merged).toHaveLength(100);
    expect(merged[0]?.id).toBe(2);
  });
});
