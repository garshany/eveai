import { describe, expect, it } from 'vitest';
import { splitForTelegram } from '../../src/agent/finalizer.js';
import { formatForTelegram } from '../../src/telegram/formatting.js';

const LIMIT = 200;

function fenceCount(text: string): number {
  return text.split('```').length - 1;
}

describe('splitForTelegram', () => {
  it('keeps short text as a single chunk', () => {
    expect(splitForTelegram('короткий ответ', LIMIT)).toEqual(['короткий ответ']);
    const fenced = '```\nconst a = 1;\n```';
    expect(splitForTelegram(fenced, LIMIT)).toEqual([fenced]);
  });

  it('chunks plain text within the limit', () => {
    const text = Array.from({ length: 40 }, (_, i) => `строка номер ${i}`).join('\n');
    const chunks = splitForTelegram(text, LIMIT);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
  });

  it('closes and reopens a fence that a split lands inside', () => {
    const body = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join('\n');
    const chunks = splitForTelegram(`\`\`\`\n${body}\n\`\`\`\n\nПосле кода — обычный текст.`, LIMIT);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Every chunk must parse on its own: fences come in pairs.
      expect(fenceCount(chunk) % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(LIMIT);
    }
    expect(chunks[0].endsWith('```')).toBe(true);
    expect(chunks[1].startsWith('```')).toBe(true);
  });

  it('does not wrap prose following a split fence in <pre>', () => {
    const body = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join('\n');
    const chunks = splitForTelegram(`\`\`\`\n${body}\n\`\`\`\n\nПосле кода — обычный текст.`, LIMIT);
    const last = formatForTelegram(chunks[chunks.length - 1]).text;

    expect(last).toContain('После кода');
    // The prose sits after the closing tag, not swallowed by the code block.
    expect(last).toMatch(/<\/pre>[^]*После кода/);
    expect(last).not.toMatch(/<pre>(?:(?!<\/pre>)[^])*После кода/);
  });

  it('never cuts through a ``` delimiter', () => {
    // No newlines and no spaces, so the cut falls on the hard limit — which
    // lands inside the fence run unless the split steps back over it.
    const text = `${'a'.repeat(190)}\`\`\`${'b'.repeat(300)}`;
    const chunks = splitForTelegram(text, LIMIT);

    for (const chunk of chunks) {
      // A fragment of a delimiter would show up as a 1- or 2-backtick run.
      const runs = chunk.match(/`+/g) ?? [];
      for (const run of runs) expect(run.length % 3).toBe(0);
    }
  });

  it('leaves a same-line ``` span alone when the split falls between its delimiters', () => {
    // Counting raw fence runs would call the first ``` an open block, close it,
    // and make the formatter eat the rest of the line as a language tag.
    const filler = 'x'.repeat(150);
    const text = `${filler}\nдо \`\`\`код\`\`\` после\n${filler}\nхвост после кода`;
    const chunks = splitForTelegram(text, LIMIT);
    const rendered = chunks.map((chunk) => formatForTelegram(chunk).text).join('\n');

    expect(rendered).not.toContain('<pre></pre>');
    expect(rendered).toContain('код');
    expect(rendered).toContain('после');
    expect(rendered).toContain('хвост после кода');
  });

  it('does not strand an opening fence without its newline', () => {
    // The cut lands exactly on the newline after ```ts — the marker alone does
    // not open a block, so the code would be sent as prose and the real closing
    // fence would become an opener.
    const text = `${'a'.repeat(180)}\n\`\`\`ts\nconst answer = 42;\nconst other = 7;\n\`\`\`\nхвост`;
    const chunks = splitForTelegram(text, LIMIT);
    const rendered = chunks.map((chunk) => formatForTelegram(chunk).text);

    expect(chunks[0].endsWith('```ts')).toBe(false);
    expect(rendered.join('\n')).toContain('const answer = 42;');
    expect(rendered.some((html) => html.includes('<pre>const answer = 42;'))).toBe(true);
    expect(rendered.join('\n')).toContain('хвост');
  });

  it('preserves the code body across the split', () => {
    const body = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join('\n');
    const chunks = splitForTelegram(`\`\`\`\n${body}\n\`\`\`\n\nхвост`, LIMIT);
    const rejoined = chunks.join('\n').split('```').join('');

    for (let i = 0; i < 40; i += 1) {
      expect(rejoined).toContain(`log line ${i}`);
    }
    expect(rejoined).toContain('хвост');
  });
});
