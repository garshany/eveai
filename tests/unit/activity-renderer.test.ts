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

function harness(isTty: boolean) {
  const screen = new VirtualScreen();
  const timers: Array<() => void> = [];
  const deps: RendererDeps = {
    write: (t) => screen.write(t),
    isTty,
    render: (t) => `RENDERED(${t})`,
    colorize: (_c, t) => t,
    setInterval: (fn) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setInterval>; },
    clearInterval: () => {},
  };
  return { screen, tickSpinner: () => timers.forEach((fn) => fn()), renderer: createActivityRenderer(deps) };
}

describe('CLI activity renderer', () => {
  it('keeps a short streamed answer on screen after finish (regression: answer erased)', () => {
    const { screen, tickSpinner, renderer } = harness(true);
    renderer.sink.emit({ type: 'model_turn', iteration: 0 });
    tickSpinner(); // spinner draws "думаю…" on the current line
    renderer.sink.emit({ type: 'token', delta: 'PLEX: 4 621 543 ISK' });
    renderer.finish('PLEX: 4 621 543 ISK');

    const out = screen.screen();
    expect(out).toContain('PLEX: 4 621 543 ISK'); // the answer must survive
    expect(out).not.toContain('думаю'); // spinner line was cleared, not left behind
  });

  it('keeps tool/reasoning lines and the answer together', () => {
    const { screen, tickSpinner, renderer } = harness(true);
    renderer.sink.emit({ type: 'model_turn', iteration: 0 });
    tickSpinner();
    renderer.sink.emit({ type: 'reasoning', text: 'Resolve PLEX type_id, then price' });
    renderer.sink.emit({ type: 'tool_start', name: 'sde_sql', detail: 'query' });
    renderer.sink.emit({ type: 'tool_start', name: 'batch_market_prices', detail: '1 item' });
    tickSpinner();
    renderer.sink.emit({ type: 'token', delta: 'Готово: 4.6M ISK' });
    renderer.finish('Готово: 4.6M ISK');

    const out = screen.screen();
    expect(out).toContain('SDE query');
    expect(out).toContain('market prices');
    expect(out).toContain('Resolve PLEX type_id');
    expect(out).toContain('Готово: 4.6M ISK');
    expect(out).not.toContain('думаю');
  });

  it('renders the final answer when nothing streamed', () => {
    const { screen, tickSpinner, renderer } = harness(true);
    renderer.sink.emit({ type: 'model_turn', iteration: 0 });
    tickSpinner();
    renderer.finish('short answer');
    const out = screen.screen();
    expect(out).toContain('RENDERED(short answer)');
    expect(out).not.toContain('думаю');
  });

  it('prints only the appended tail (commands block), never re-printing the streamed body', () => {
    const { screen, renderer } = harness(true);
    renderer.sink.emit({ type: 'token', delta: 'Body line one' });
    renderer.finish('Body line one\n\n/market jita');
    const out = screen.screen();
    expect(out).toContain('Body line one');
    // The streamed body appears once (raw), the tail once (rendered) — no dup body.
    expect(out.match(/Body line one/g)).toHaveLength(1);
    expect(out).toContain('RENDERED(/market jita)');
  });

  it('does not animate a spinner when output is not a TTY', () => {
    const { screen, tickSpinner, renderer } = harness(false);
    renderer.sink.emit({ type: 'model_turn', iteration: 0 });
    tickSpinner(); // no timer was registered, so this is a no-op
    renderer.sink.emit({ type: 'token', delta: 'answer' });
    renderer.finish('answer');
    expect(screen.screen()).toContain('answer');
    expect(screen.screen()).not.toContain('думаю');
  });

  it('maps tool names to friendly labels', () => {
    expect(toolLabel('sde_sql')).toContain('SDE');
    expect(toolLabel('batch_market_prices')).toContain('market');
    expect(toolLabel('kill_feed')).toContain('killboard');
    expect(toolLabel('get_characters_character_id_assets')).toContain('ESI');
    expect(toolLabel('mystery_tool')).toContain('mystery_tool');
  });
});
