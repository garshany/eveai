import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage, normalizeLegacyFormatting, safeLink } from '../../web/src/components/MarkdownMessage.js';

describe('web message formatting', () => {
  it('normalizes Telegram HTML and escaped entities into supported Markdown', () => {
    const normalized = normalizeLegacyFormatting(
      '&lt;b&gt;Dodixie → Jita&lt;/b&gt;\n&lt;code&gt;jumps 15&lt;/code&gt;\n&lt;a href="https://eve-kill.com/kill/137039248"&gt;EVE-KILL&lt;/a&gt;',
    );
    expect(normalized).toContain('**Dodixie → Jita**');
    expect(normalized).toContain('`jumps 15`');
    expect(normalized).toContain('[EVE-KILL](https://eve-kill.com/kill/137039248)');
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
});
