import { describe, expect, it, vi } from 'vitest';
import { createActivityRenderer, toolLabel, type RendererDeps } from '../../src/cli/activity-renderer.js';

/**
 * Minimal terminal emulator: replays a raw write stream (with \r, \n, and the
 * CSI "erase to end of line" \x1b[K) onto a screen buffer, so a test can assert
 * what a real terminal would still be showing. Color codes are stripped.
 */
class VirtualScreen {
  private lines: string[] = [''];
  private row = 0;
  private col = 0;

  write(chunk: string): void {
    // Drop SGR color sequences (\x1b[...m); keep \x1b[K for erase handling.
    const cleaned = chunk.replace(/\x1b\[[0-9;]*m/g, '');
    for (let i = 0; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (ch === '\x1b' && cleaned[i + 1] === '[' && cleaned[i + 2] === 'K') {
        this.lines[this.row] = this.lines[this.row].slice(0, this.col);
        i += 2;
        continue;
      }
      if (ch === '\n') { this.row += 1; this.col = 0; if (!this.lines[this.row]) this.lines[this.row] = ''; continue; }
      if (ch === '\r') { this.col = 0; continue; }
      const line = this.lines[this.row] ?? '';
      this.lines[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
      this.col += 1;
    }
  }

  screen(): string {
    return this.lines.join('\n');
  }
}

// Stand-in for the real sanitizeOutput: redacts a Bearer token so the test can
const fakeSanitize = (t: string) => t.replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [REDACTED]');

function harness(isTty: boolean) {
  const screen = new VirtualScreen();
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const deps: RendererDeps = {
    write: (t) => screen.write(t),
    isTty,
    render: (t) => `RENDERED(${t})`,
    sanitize: fakeSanitize,
    colorize: (_c, t) => t,
    setInterval: (fn) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setInterval>;
    },
    // Faithful to the real timer: a cleared interval stops firing.
    clearInterval: (handle) => { timers.delete(handle as unknown as number); },
  };
  return { screen, tickSpinner: () => { for (const fn of timers.values()) fn(); }, renderer: createActivityRenderer(deps) };
}

describe('CLI activity renderer', () => {
  it('renders the answer after the spinner, never erasing it (regression: answer erased)', () => {
    const { screen, tickSpinner, renderer } = harness(true);
    renderer.sink.emit({ type: 'model_turn', iteration: 0 });
    tickSpinner(); // spinner draws "думаю…" on the current line
    renderer.finish('PLEX: 4 621 543 ISK');

    const out = screen.screen();
    expect(out).toContain('RENDERED(PLEX: 4 621 543 ISK)'); // the answer must survive
    expect(out).not.toContain('думаю'); // spinner line was cleared, not left behind
  });

  it('keeps tool and reasoning lines above the rendered answer', () => {
    const { screen, tickSpinner, renderer } = harness(true);
    renderer.sink.emit({ type: 'model_turn', iteration: 0 });
    tickSpinner();
    renderer.sink.emit({ type: 'reasoning', text: 'Resolve PLEX type_id, then price' });
    renderer.sink.emit({ type: 'tool_start', name: 'sde_sql', detail: 'query' });
    renderer.sink.emit({ type: 'tool_start', name: 'batch_market_prices', detail: '1 item' });
    renderer.finish('Готово: 4.6M ISK');

    const out = screen.screen();
    expect(out).toContain('SDE query');
    expect(out).toContain('market prices');
    expect(out).toContain('Resolve PLEX type_id');
    expect(out).toContain('RENDERED(Готово: 4.6M ISK)');
    expect(out).not.toContain('думаю');
  });

  it('starts the spinner on begin(), before any model turn (pre-loop work)', () => {
    const { screen, tickSpinner, renderer } = harness(true);
    renderer.begin();      // called right after input, before runAgentTurn
    tickSpinner();          // pre-loop work is happening; spinner should already animate
    expect(screen.screen()).toContain('думаю');
    renderer.finish('done');
    expect(screen.screen()).toContain('RENDERED(done)');
    expect(screen.screen()).not.toContain('думаю'); // cleared before the answer
  });

  it('renders the answer even when no spinner ran (non-TTY)', () => {
    const { screen, tickSpinner, renderer } = harness(false);
    renderer.sink.emit({ type: 'model_turn', iteration: 0 });
    tickSpinner(); // no timer registered on non-TTY, so this is a no-op
    renderer.finish('answer');
    expect(screen.screen()).toContain('RENDERED(answer)');
    expect(screen.screen()).not.toContain('думаю');
  });

  it('redacts secrets in reasoning and tool-detail feed lines', () => {
    const { screen, renderer } = harness(true);
    renderer.sink.emit({ type: 'reasoning', text: 'using Bearer 0123456789abcdefghij to call' });
    renderer.sink.emit({ type: 'tool_start', name: 'web_search', detail: 'Bearer 0123456789abcdefghij' });
    renderer.finish('done');
    const out = screen.screen();
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('0123456789abcdefghij');
  });

  it('mutes all output after abort() — an abandoned turn must not print over the prompt', () => {
    const { screen, renderer, tickSpinner } = harness(true);
    renderer.sink.emit({ type: 'model_turn', iteration: 0 });
    tickSpinner();
    expect(renderer.sink.aborted?.()).toBe(false);
    renderer.abort(); // Ctrl-C: prompt is redrawn by the CLI right after this
    // The executor polls this probe to stop before the next model call/tool.
    expect(renderer.sink.aborted?.()).toBe(true);

    const after = screen.screen();
    // The agent keeps running in the background — later events must be no-ops.
    renderer.sink.emit({ type: 'tool_start', name: 'sde_sql', detail: 'late query' });
    renderer.sink.emit({ type: 'reasoning', text: 'late thought' });
    renderer.sink.emit({ type: 'model_turn', iteration: 1 });
    tickSpinner();
    renderer.begin();
    tickSpinner();
    renderer.finish('late answer');

    expect(screen.screen()).toBe(after);
    expect(screen.screen()).not.toContain('late');
  });

  it('maps tool names to friendly labels', () => {
    expect(toolLabel('sde_sql')).toContain('SDE');
    expect(toolLabel('batch_market_prices')).toContain('market');
    expect(toolLabel('kill_feed')).toContain('killboard');
    expect(toolLabel('get_characters_character_id_assets')).toContain('ESI');
    expect(toolLabel('mystery_tool')).toContain('mystery_tool');
  });
});
