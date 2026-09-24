import { describe, expect, it } from 'vitest';
import { layoutsEqual, type Layout } from '../../web/src/components/map/layout.js';

function layout(entries: Array<[number, number, number]>): Layout {
  return new Map(entries.map(([id, x, y]) => [id, { x, y }]));
}

describe('layoutsEqual', () => {
  it('treats separately built but identical layouts as equal so live ticks skip the morph', () => {
    expect(layoutsEqual(layout([[1, 0, 0], [2, 120, 5]]), layout([[2, 120, 5], [1, 0, 0]]))).toBe(true);
    expect(layoutsEqual(new Map(), new Map())).toBe(true);
  });

  it('detects moved, added or removed nodes so a real change still morphs', () => {
    const base = layout([[1, 0, 0], [2, 120, 5]]);
    expect(layoutsEqual(base, layout([[1, 0, 0], [2, 120, 6]]))).toBe(false);
    expect(layoutsEqual(base, layout([[1, 0, 0], [2, 120, 5], [3, 1, 1]]))).toBe(false);
    expect(layoutsEqual(base, layout([[1, 0, 0], [3, 120, 5]]))).toBe(false);
  });
});
