import { describe, expect, it } from 'vitest';
import { htmlToDiscordMarkdown, splitForDiscord, MAX_DISCORD_LENGTH } from '../../src/discord/format.js';

describe('htmlToDiscordMarkdown', () => {
  it('converts basic Telegram HTML markup to Discord markdown', () => {
    expect(htmlToDiscordMarkdown('<b>bold</b> and <strong>strong</strong>')).toBe('**bold** and **strong**');
    expect(htmlToDiscordMarkdown('<i>italic</i> and <em>emphasis</em>')).toBe('*italic* and *emphasis*');
    expect(htmlToDiscordMarkdown('<u>under</u> <s>gone</s>')).toBe('__under__ ~~gone~~');
    expect(htmlToDiscordMarkdown('<code>1 + 1</code>')).toBe('`1 + 1`');
  });

  it('converts pre blocks to fenced code blocks', () => {
    expect(htmlToDiscordMarkdown('<pre>line1\nline2</pre>')).toBe('```\nline1\nline2\n```');
    expect(htmlToDiscordMarkdown('<pre><code class="language-js">x</code></pre>')).toBe('```\nx\n```');
  });

  it('converts links to label (url) form', () => {
    expect(htmlToDiscordMarkdown('<a href="https://zkillboard.com/kill/1/">килл</a>'))
      .toBe('килл (https://zkillboard.com/kill/1/)');
    expect(htmlToDiscordMarkdown('<a href="https://example.com">https://example.com</a>'))
      .toBe('https://example.com');
  });

  it('decodes HTML entities and strips unknown tags', () => {
    expect(htmlToDiscordMarkdown('Jita &gt; Amarr &amp; back')).toBe('Jita > Amarr & back');
    expect(htmlToDiscordMarkdown('<blockquote>цитата</blockquote>')).toBe('цитата');
    expect(htmlToDiscordMarkdown('line<br>break')).toBe('line\nbreak');
  });

  it('does not mangle markup inside code blocks', () => {
    expect(htmlToDiscordMarkdown('<code>&lt;b&gt;raw&lt;/b&gt;</code>')).toBe('`<b>raw</b>`');
  });

  it('leaves plain text untouched', () => {
    const text = 'Обычный текст с числами 123 и юникодом — тире.';
    expect(htmlToDiscordMarkdown(text)).toBe(text);
  });
});

describe('splitForDiscord', () => {
  it('returns a single chunk for short messages', () => {
    expect(splitForDiscord('короткий ответ')).toEqual(['короткий ответ']);
  });

  it('splits long messages under the 2000-char limit at line boundaries', () => {
    const line = 'x'.repeat(80);
    const text = Array.from({ length: 60 }, () => line).join('\n');
    const chunks = splitForDiscord(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_DISCORD_LENGTH);
    }
    expect(chunks.join('\n').replace(/\n+/g, '\n')).toBe(text.replace(/\n+/g, '\n'));
  });

  it('hard-cuts a single overlong line', () => {
    const text = 'y'.repeat(4500);
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBe(3);
    expect(chunks.join('')).toBe(text);
  });

  it('redacts leaked bearer tokens', () => {
    const text = `Bearer ${'a'.repeat(30)}`;
    expect(splitForDiscord(text)[0]).toContain('[REDACTED]');
  });

  it('closes and reopens code fences split across chunks', () => {
    const tableRow = '| Rifter | 587 | 25 |';
    const table = '```\n' + Array.from({ length: 150 }, () => tableRow).join('\n') + '\n```';
    const chunks = splitForDiscord(`Вот таблица:\n${table}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_DISCORD_LENGTH);
      const fences = (chunk.match(/```/g) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it('honors a custom limit so chunk prefixes cannot overflow 2000 chars', () => {
    const headroom = 24;
    const text = 'z'.repeat(5000);
    const chunks = splitForDiscord(text, MAX_DISCORD_LENGTH - headroom);
    for (const chunk of chunks) {
      expect(`Часть 10/10\n${chunk}`.length).toBeLessThanOrEqual(MAX_DISCORD_LENGTH);
    }
    expect(chunks.join('')).toBe(text);
  });
});
