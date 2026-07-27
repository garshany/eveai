import { describe, expect, it } from 'vitest';
import {
  withWebLaneAuthorizationLock,
  withWebLaneAuthorizationLocks,
} from '../../src/web/web-lane-lock.js';

// Deterministic gate helper: a promise plus separate entered/release signals.
function gate() {
  let entered = (): void => {};
  let release = (): void => {};
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, enteredPromise, release, releasePromise };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('withWebLaneAuthorizationLocks', () => {
  it('acquires multiple lane locks in ascending chat-id order', async () => {
    // Ascending numeric order for the negative web range: low < mid < high.
    const low = -2_000_000_103;
    const mid = -2_000_000_102;
    const high = -2_000_000_101;

    // Hold the highest lane: a sorted acquisition takes low and mid first and
    // then blocks on high; an unsorted one would block on high immediately.
    const holder = gate();
    const heldHigh = withWebLaneAuthorizationLock(high, async () => {
      holder.entered();
      await holder.releasePromise;
    });
    await holder.enteredPromise;

    let actionRan = false;
    const multi = withWebLaneAuthorizationLocks([high, low, mid], async () => {
      actionRan = true;
    });
    // Let the multi-lock advance to its blocking point first: with sorted
    // acquisition it then holds low and mid while waiting on high.
    await flushMicrotasks();

    // Lane mid must already be taken (low and mid come before high in
    // ascending order); an unsorted acquisition would leave it free.
    let probeMidEntered = false;
    const probeMid = withWebLaneAuthorizationLock(mid, async () => {
      probeMidEntered = true;
    });
    await flushMicrotasks();
    expect(probeMidEntered).toBe(false);
    expect(actionRan).toBe(false);

    holder.release();
    await multi;
    await probeMid;
    await heldHigh;
    expect(actionRan).toBe(true);
    expect(probeMidEntered).toBe(true);
  });

  it('dedupes chat ids and runs the action once', async () => {
    const a = -2_000_000_201;
    const b = -2_000_000_202;
    let runs = 0;
    const result = await withWebLaneAuthorizationLocks([b, a, b, a], async () => {
      runs += 1;
      return 'done';
    });
    expect(result).toBe('done');
    expect(runs).toBe(1);
  });

  it('serializes with the single-lane lock on the same chat id', async () => {
    const a = -2_000_000_301;
    const order: string[] = [];
    const first = gate();
    const holder = withWebLaneAuthorizationLocks([a], async () => {
      first.entered();
      await first.releasePromise;
      order.push('multi');
    });
    await first.enteredPromise;

    const single = withWebLaneAuthorizationLock(a, async () => {
      order.push('single');
    });
    first.release();
    await holder;
    await single;
    expect(order).toEqual(['multi', 'single']);
  });
});
