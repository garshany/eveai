import { describe, expect, it } from 'vitest';
import {
  drainConversationsThenStopSweep,
  MARKET_SWEEP_STOP_BUDGET_MS,
} from '../../src/app-shutdown.js';

describe('drainConversationsThenStopSweep', () => {
  it('drains conversations before stopping the market sweep', async () => {
    // A deploy mid-sweep must not make live turns wait behind the sweep: the
    // drain completes first, the sweep stop runs after.
    const events: string[] = [];
    let turns = 1;
    setTimeout(() => {
      turns = 0;
      events.push('turn-finished');
    }, 40);

    const result = await drainConversationsThenStopSweep({
      drainMs: 5_000,
      drainPollMs: 5,
      drainDeadlineMs: Date.now() + 5_000,
      countInFlightTurns: () => turns,
      stopMarketSweep: () => {
        events.push('sweep-stop');
      },
    });

    expect(result.turnsLeftAfterDrain).toBe(0);
    expect(events).toEqual(['turn-finished', 'sweep-stop']);
  });

  it('bounds the sweep stop by its own small budget, not the shared drain budget', async () => {
    // The sweep may sit minutes from its next commit; the stop must not wait
    // it out with the drain's 600s. An aborted sweep is safe by design (the
    // half-filled staging table is dropped by the next sweep).
    const started = Date.now();
    const result = await drainConversationsThenStopSweep({
      drainMs: 60_000,
      drainPollMs: 5,
      drainDeadlineMs: Date.now() + 60_000,
      countInFlightTurns: () => 0,
      stopMarketSweep: () => new Promise(() => {}), // a sweep that never ends
      sweepStopBudgetMs: 50,
    });

    const elapsed = Date.now() - started;
    expect(result.turnsLeftAfterDrain).toBe(0); // drain itself was instant
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(5_000); // not the 60s drain budget
  });

  it('keeps the production sweep-stop budget in the tens of seconds', () => {
    // Long enough for a commit that is seconds away, short enough that a
    // deploy never waits a whole sweep. systemd's TimeoutStopSec headroom
    // above the drain (60s) must cover it.
    expect(MARKET_SWEEP_STOP_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
    expect(MARKET_SWEEP_STOP_BUDGET_MS).toBeLessThanOrEqual(60_000);
  });

  it('skips the drain when disabled but still stops the sweep', async () => {
    let sweepStopped = false;
    const result = await drainConversationsThenStopSweep({
      drainMs: 0,
      drainPollMs: 5,
      drainDeadlineMs: Date.now(),
      countInFlightTurns: () => 3,
      stopMarketSweep: () => {
        sweepStopped = true;
      },
    });

    expect(result.turnsLeftAfterDrain).toBeNull();
    expect(sweepStopped).toBe(true);
  });
});
