import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage, normalizeLegacyFormatting, safeLink } from '../../web/src/components/MarkdownMessage.js';
import { I18nProvider } from '../../web/src/i18n.js';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });

describe('web message formatting', () => {
  it('normalizes Telegram HTML and escaped entities into supported Markdown', () => {
    const normalized = normalizeLegacyFormatting(
      '&lt;b&gt;Dodixie → Jita&lt;/b&gt;\n&lt;code&gt;jumps 15&lt;/code&gt;\n&lt;a href="https://eve-kill.com/kill/137039248"&gt;EVE-KILL&lt;/a&gt;',
    );
    expect(normalized).toContain('**Dodixie → Jita**');
    expect(normalized).toContain('`jumps 15`');
    expect(normalized).toContain('[EVE-KILL](https://eve-kill.com/kill/137039248)');
  });

  it('renders single-asterisk emphasis but leaves snake_case identifiers alone', () => {
    const html = renderToStaticMarkup(MarkdownMessage({
      content: 'Полностью *все регионы New Eden* одним запросом ESI не отдаёт.\n\n'
        + 'Столбцы character_assets и average_price остаются как есть.\n\n'
        + '**Amarr** дороже, чем *Jita*.',
    }));

    expect(html).toContain('<em>все регионы New Eden</em>');
    expect(html).toContain('<em>Jita</em>');
    expect(html).toContain('<strong>Amarr</strong>');
    // Bold must not be swallowed by the italic branch.
    expect(html).not.toContain('<em>*Amarr*</em>');
    // Underscore emphasis stays unsupported so identifiers survive intact.
    expect(html).toContain('character_assets');
    expect(html).toContain('average_price');
    expect(html).not.toContain('<em>и average</em>');
  });

  it('rejects credentialed and non-http links', () => {
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('https://user:pass@example.com/private')).toBeNull();
    expect(safeLink('https://eve-kill.com/kill/1')).toBe('https://eve-kill.com/kill/1');
  });

  it('renders formatted nodes without injecting raw HTML', () => {
    const html = renderToStaticMarkup(MarkdownMessage({
      content: '<b>Dodixie → Jita</b>\n<code>jumps 15</code>\n<a href="https://eve-kill.com/kill/1">EVE-KILL</a>',
    }));
    expect(html).toContain('<strong>Dodixie → Jita</strong>');
    expect(html).toContain('<code>jumps 15</code>');
    expect(html).toContain('href="https://eve-kill.com/kill/1"');
    expect(html).toContain('<br/>');
    expect(html).not.toContain('&lt;b&gt;');
  });

  it('renders an unclosed fenced code block as code until the end of the text', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(MarkdownMessage, { content: 'Смотри конфиг:\n```json\n{"region": "The Forge"\n' })));
    expect(html).toContain('<figure class="code-block">');
    expect(html).toContain('{&quot;region&quot;: &quot;The Forge&quot;');
    expect(html).not.toContain('```');
  });

  it('still splits a closed code block from the following paragraph', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(MarkdownMessage, { content: '```ts\nconst a = 1;\n```\nпояснение после блока' })));
    expect(html).toContain('<code>const a = 1;</code>');
    expect(html).toContain('<p>пояснение после блока</p>');
  });

  it('keeps unpaired inline markers as literal text', () => {
    const html = renderToStaticMarkup(MarkdownMessage({
      content: 'Цена **не завершена и `тоже не завершено',
    }));
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<code>');
    expect(html).toContain('Цена **не завершена и `тоже не завершено');
  });

  it('renders a GFM-style table with header, alignment and numeric cells', () => {
    const html = renderToStaticMarkup(MarkdownMessage({
      content: '| Система | Прыжки | Цена |\n|:--------|-------:|-----:|\n| Jita | 0 | 1 250 000 |\n| Amarr | 12 | 1 180 500 |',
    }));
    expect(html).toContain('<div class="md-table">');
    expect(html).toContain('<th>Система</th>');
    expect(html).toContain('<th class="md-align-right">Прыжки</th>');
    expect(html).toContain('<td class="md-align-right md-num">1 250 000</td>');
    expect(html).toContain('<td>Amarr</td>');
    expect(html).not.toContain('---');
  });

  it('accepts table rows without leading and trailing pipes', () => {
    const html = renderToStaticMarkup(MarkdownMessage({
      content: 'Регион | Объём\n--- | ---\nThe Forge | 420',
    }));
    expect(html).toContain('<th>Регион</th>');
    expect(html).toContain('<td>The Forge</td>');
    expect(html).toContain('<td class="md-num">420</td>');
  });

  it('splits a table from the following paragraph', () => {
    const html = renderToStaticMarkup(MarkdownMessage({
      content: '| a | b |\n|---|---|\n| 1 | 2 |\nпояснение после таблицы',
    }));
    expect(html).toContain('</table>');
    expect(html).toContain('<p>пояснение после таблицы</p>');
  });

  it('keeps pipe text without a separator row as a plain paragraph', () => {
    const html = renderToStaticMarkup(MarkdownMessage({
      content: 'вариант A | вариант B\nпродолжение той же мысли',
    }));
    expect(html).not.toContain('<table>');
    expect(html).toContain('вариант A | вариант B');
  });

  it('pads short table rows and truncates extra cells to the header width', () => {
    const html = renderToStaticMarkup(MarkdownMessage({
      content: '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |',
    }));
    const cells = html.match(/<td/g) ?? [];
    expect(cells).toHaveLength(4);
    expect(html).not.toContain('>3</td>');
  });
});
