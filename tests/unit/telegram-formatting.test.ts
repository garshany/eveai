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

  it('renders a same-line ```span``` as inline code and keeps the text around it', () => {
    expect(markdownToTelegramHtml('до ```код``` после'))
      .toBe('до <code>код</code> после');
  });

  it('does not let a same-line span swallow the following line', () => {
    // An unanchored fence rule retried at the closing delimiter, read " после"
    // as a language tag and wrapped the next line in <pre>, deleting the text.
    expect(markdownToTelegramHtml('до ```код``` после\nследующая строка'))
      .toBe('до <code>код</code> после\nследующая строка');
  });

  it('still treats a fence at a line start as a block', () => {
    expect(markdownToTelegramHtml('```js\nconst a = 1;\n```\nхвост'))
      .toBe('<pre>const a = 1;</pre>\nхвост');
  });

  it('closes an unterminated fence instead of leaking backticks', () => {
    expect(markdownToTelegramHtml('```\n[Rifter, fit]\nDamage Control II'))
      .toBe('<pre>[Rifter, fit]\nDamage Control II</pre>');
  });

  it('keeps Telegram tags, escapes everything else, and escapes inside code', () => {
    // Telegram's own tag set survives so a mixed HTML+Markdown answer renders;
    // anything outside that set is still escaped, and code stays literal.
    expect(markdownToTelegramHtml('сравни <b>жирный</b> и `a < b & c`'))
      .toBe('сравни <b>жирный</b> и <code>a &lt; b &amp; c</code>');
    expect(markdownToTelegramHtml('<script>alert(1)</script> и **жирный**'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt; и <b>жирный</b>');
    expect(markdownToTelegramHtml('шаблон <div class="x">блок</div>'))
      .toBe('шаблон &lt;div class="x"&gt;блок&lt;/div&gt;');
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
  it('converts Markdown that arrives alongside existing Telegram HTML', () => {
    // plan_route summaries ship HTML; the agent wraps its own Markdown around
    // them. Treating one tag as proof the whole message is formatted left
    // **bold** on screen literally.
    const out = formatForTelegram('<b>Маршрут</b>: Jita → Amarr\n\n**Рекомендация**: бери Rifter');
    expect(out.parseMode).toBe('HTML');
    expect(out.text).toBe('<b>Маршрут</b>: Jita → Amarr\n\n<b>Рекомендация</b>: бери Rifter');
  });

  it('does not double-escape entities in a mixed message', () => {
    expect(markdownToTelegramHtml('<b>Jita</b> &amp; Amarr — **важно**'))
      .toBe('<b>Jita</b> &amp; Amarr — <b>важно</b>');
  });

  it('escapes unmatched tags instead of shipping HTML Telegram will reject', () => {
    // A stray "</b>" made Telegram reject the payload, and the plain-text retry
    // then stripped formatting from the whole message.
    expect(markdownToTelegramHtml('Покажи </b>, но **это важно**'))
      .toBe('Покажи &lt;/b&gt;, но <b>это важно</b>');
    // Same for an opener the model never closed.
    expect(markdownToTelegramHtml('<b>забыл закрыть и **важно**'))
      .toBe('&lt;b&gt;забыл закрыть и <b>важно</b>');
    // A balanced pair still survives, nested pairs included.
    expect(markdownToTelegramHtml('<b>Маршрут <i>Jita</i></b> и **итог**'))
      .toBe('<b>Маршрут <i>Jita</i></b> и <b>итог</b>');
    // Only the unclosed tag is demoted: the inner pair is well-formed on its
    // own, so keeping it preserves formatting Telegram accepts.
    expect(markdownToTelegramHtml('<b>висит <i>курсив</i>'))
      .toBe('&lt;b&gt;висит <i>курсив</i>');
  });

  it('keeps entities inside a preserved tag intact', () => {
    expect(markdownToTelegramHtml('<a href="https://x.test/?a=1&amp;b=2">ссылка</a> и **итог**'))
      .toBe('<a href="https://x.test/?a=1&amp;b=2">ссылка</a> и <b>итог</b>');
  });

  it('does not leak stash placeholders out of a nested construct', () => {
    // Literal backticks inside an existing <code> used to be stashed by the
    // inline rule and then re-captured by the element rule, so the single
    // restore left raw delimiters in the payload and Telegram rejected it.
    const out = markdownToTelegramHtml('<code>`literal`</code>\n**Рекомендация**');
    expect(out).not.toContain(String.fromCharCode(0));
    expect(out).toBe('<code>`literal`</code>\n<b>Рекомендация</b>');
  });

  it('keeps HTML inside a Markdown fence escaped, whichever comes first', () => {
    expect(markdownToTelegramHtml('```\n<code>x</code>\n```'))
      .toBe('<pre>&lt;code&gt;x&lt;/code&gt;</pre>');
  });

  it('leaves Markdown inside an existing code element alone', () => {
    // Telegram forbids formatting entities inside a code entity: converting the
    // sigils there produces a payload it rejects, and the plain-text retry then
    // strips the formatting from the whole message.
    expect(markdownToTelegramHtml('<code>**literal**</code>\n**Рекомендация**'))
      .toBe('<code>**literal**</code>\n<b>Рекомендация</b>');
    expect(markdownToTelegramHtml('<pre><code class="language-js">const a = **1**;</code></pre>\n**итог**'))
      .toBe('<pre><code class="language-js">const a = **1**;</code></pre>\n<b>итог</b>');
  });

  it('keeps HTML inside a code block literal', () => {
    expect(markdownToTelegramHtml('```\n<b>внутри кода</b>\n```'))
      .toBe('<pre>&lt;b&gt;внутри кода&lt;/b&gt;</pre>');
  });

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
