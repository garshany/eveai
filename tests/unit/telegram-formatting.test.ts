import { describe, expect, it } from 'vitest';
import {
  formatForTelegram,
  markdownToTelegramHtml,
  pickTelegramParseMode,
} from '../../src/telegram/formatting.js';

describe('pickTelegramParseMode', () => {
  it('returns HTML for supported telegram html markup', () => {
    expect(pickTelegramParseMode('<b>Bold</b>')).toBe('HTML');
    expect(pickTelegramParseMode('<code>block</code>')).toBe('HTML');
    expect(pickTelegramParseMode('<a href="https://eve-kill.com/kill/1">EVE-KILL</a>')).toBe('HTML');
    expect(pickTelegramParseMode('<i>italics</i>')).toBe('HTML');
  });

  it('returns undefined for plain text', () => {
    expect(pickTelegramParseMode('Просто текст без разметки')).toBeUndefined();
  });
});

describe('markdownToTelegramHtml', () => {
  it('converts bold, italic and inline code', () => {
    expect(markdownToTelegramHtml('Цена **выросла** на *2%*: `44992`'))
      .toBe('Цена <b>выросла</b> на <i>2%</i>: <code>44992</code>');
  });

  it('converts fenced code blocks and drops the language tag', () => {
    expect(markdownToTelegramHtml('Таблица:\n```text\nRifter  500k\nPunisher 700k\n```\nВывод.'))
      .toBe('Таблица:\n<pre>Rifter  500k\nPunisher 700k</pre>\nВывод.');
  });

  it('keeps text around same-line backticks instead of eating it as a language tag', () => {
    const out = markdownToTelegramHtml('до ```код``` после');
    expect(out).toContain('код');
    expect(out).toContain('после');
    expect(out).not.toContain('<pre></pre>');
  });

  it('closes an unterminated fence instead of leaking backticks', () => {
    expect(markdownToTelegramHtml('```\n[Rifter, fit]\nDamage Control II'))
      .toBe('<pre>[Rifter, fit]\nDamage Control II</pre>');
  });

  it('escapes HTML outside and inside code', () => {
    expect(markdownToTelegramHtml('сравни <b>жирный</b> и `a < b & c`'))
      .toBe('сравни &lt;b&gt;жирный&lt;/b&gt; и <code>a &lt; b &amp; c</code>');
  });

  it('does not treat code content as markdown', () => {
    expect(markdownToTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('converts markdown links and escapes quotes in the href', () => {
    expect(markdownToTelegramHtml('[zKill](https://zkillboard.com/kill/1/?a=1&b=2)'))
      .toBe('<a href="https://zkillboard.com/kill/1/?a=1&amp;b=2">zKill</a>');
  });

  it('keeps balanced parentheses inside a link destination', () => {
    expect(markdownToTelegramHtml('[Tengu](https://wiki.eveuniversity.org/Tengu_(ship))'))
      .toBe('<a href="https://wiki.eveuniversity.org/Tengu_(ship)">Tengu</a>');
  });

  it('leaves list bullets and lone asterisks alone', () => {
    expect(markdownToTelegramHtml('- пункт один\n- пункт два *без пары'))
      .toBe('- пункт один\n- пункт два *без пары');
  });

  it('bold takes precedence over italic', () => {
    expect(markdownToTelegramHtml('**жирный** и *курсив*'))
      .toBe('<b>жирный</b> и <i>курсив</i>');
  });

  it('leaves arithmetic with space-padded stars literal', () => {
    expect(markdownToTelegramHtml('объём 5 * 3 * 2 м3')).toBe('объём 5 * 3 * 2 м3');
    expect(markdownToTelegramHtml('рост 2 ** 3 ** 4')).toBe('рост 2 ** 3 ** 4');
  });
});

describe('formatForTelegram', () => {
  it('passes existing telegram HTML through unchanged', () => {
    const html = '<b>Маршрут</b>: Jita → Amarr';
    expect(formatForTelegram(html)).toEqual({ text: html, parseMode: 'HTML' });
  });

  it('converts markdown answers to HTML', () => {
    const out = formatForTelegram('Итог: **брать Rifter**');
    expect(out.parseMode).toBe('HTML');
    expect(out.text).toBe('Итог: <b>брать Rifter</b>');
  });

  it('sends plain text with no parse mode (no parse risk)', () => {
    expect(formatForTelegram('Просто ответ без разметки'))
      .toEqual({ text: 'Просто ответ без разметки', parseMode: undefined });
  });

  it('detects italic-only markdown (no bold, code or link anywhere)', () => {
    const out = formatForTelegram('это *важно* для фита');
    expect(out.parseMode).toBe('HTML');
    expect(out.text).toBe('это <i>важно</i> для фита');
  });

  it('does not treat arithmetic as markdown at the detection stage', () => {
    expect(formatForTelegram('объём 5 * 3 * 2 м3'))
      .toEqual({ text: 'объём 5 * 3 * 2 м3', parseMode: undefined });
    expect(formatForTelegram('рост 2 ** 3 ** 4'))
      .toEqual({ text: 'рост 2 ** 3 ** 4', parseMode: undefined });
  });

  it('escapes stray angle brackets when converting markdown', () => {
    // `<y` is not a Telegram tag, so this is the markdown path with escaping.
    const out = formatForTelegram('формула x<y даёт **рост**');
    expect(out.text).toBe('формула x&lt;y даёт <b>рост</b>');
  });

  it('text that merely looks like an HTML tag takes the HTML path (plain fallback covers rejects)', () => {
    // `a<b ` matches the <b>-tag heuristic; callers retry as plain text when
    // Telegram rejects the unbalanced markup, so nothing is lost.
    expect(formatForTelegram('формула a<b даёт рост').parseMode).toBe('HTML');
  });
});
