/**
 * Telegram output formatting.
 *
 * The agent's output contract is chat Markdown (**bold**, *italic*, `code`,
 * ``` fences, [title](url)), but Telegram renders entities only through
 * parse_mode — raw markdown displays as literal sigils. Some payloads
 * (plan_route formatted_summary, EVE mail bodies) already arrive as Telegram
 * HTML instead. formatForTelegram picks per message:
 *   - already contains Telegram HTML markup -> send as HTML unchanged;
 *   - contains markdown sigils -> convert markdownToTelegramHtml, send as HTML;
 *   - plain text -> no parse_mode (no parse risk at all).
 * Callers keep their existing plain-text fallback for parse errors.
 */
const HTML_MARKUP_RE = /<(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|code|pre|a)(?:\s|>)/i;
const TELEGRAM_HTML_TAG_RE = /<(\/?)(b|strong|i|em|u|ins|s|strike|del|tg-spoiler|code|pre|a)(?:\s[^<>]*)?>/gi;
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|#\d{1,6});/g;

/**
 * Everything whose contents must not be treated as Markdown, matched in a
 * single left-to-right scan: fenced blocks (line-anchored), same-line spans,
 * inline code, and whole <pre>/<code> elements that arrived as HTML. <pre>
 * precedes <code> so Telegram's <pre><code class="language-x"> nesting is taken
 * as one element.
 */
const VERBATIM_RE = new RegExp([
  '(^|\\n)```([^\\n`]*)\\n([\\s\\S]*?)(?:```|$)',
  '```([^`\\n]+)```',
  '`([^`\\n]+)`',
  '<pre\\b[^>]*>[\\s\\S]*?</pre>',
  '<code\\b[^>]*>[\\s\\S]*?</code>',
].join('|'), 'gi');

// Bold/italic require non-space content edges so arithmetic like "5 * 3 * 2"
// or "2 ** 3 ** 4" is never mistaken for markup (matches the converter below).
const MARKDOWN_SIGIL_RE = /\*\*[^*\s](?:[^*\n]*[^*\s])?\*\*|\*[^*\s](?:[^*\n]*[^*\s])?\*|```|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\//;

export function pickTelegramParseMode(text: string): 'HTML' | undefined {
  return HTML_MARKUP_RE.test(text) ? 'HTML' : undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert the agent's chat-Markdown subset to Telegram HTML.
 *
 * Order matters: code is stashed first (its content must not be treated as
 * markup), then the remaining text is HTML-escaped, then inline entities are
 * converted, then code is restored. An unterminated ``` fence (e.g. a chunk
 * split mid-fence) becomes a <pre> to end of text rather than leaking raw
 * backticks. Placeholders are NUL-delimited: sanitizeOutput upstream never
 * lets a raw NUL through, so user/model text cannot collide with them.
 */
export function markdownToTelegramHtml(text: string): string {
  const stashed: string[] = [];
  const stash = (html: string): string => {
    stashed.push(html);
    return `\u0000${stashed.length - 1}\u0000`;
  };

  // One pass, so the construct that appears first in the text wins and no
  // placeholder can be nested inside another: as separate passes, an inline-code
  // stash inside an existing <code> element was re-captured by the element
  // stash, and the single restore left raw delimiters in the payload.
  let out = text.replace(
    VERBATIM_RE,
    (
      match: string,
      lead: string | undefined,
      _lang: string | undefined,
      blockBody: string | undefined,
      spanBody: string | undefined,
      inlineBody: string | undefined,
    ) => {
      // Fenced block at a line start: language tag dropped, unterminated -> EOF.
      if (blockBody !== undefined) {
        return (lead ?? '') + stash(`<pre>${escapeHtml(blockBody.replace(/\n$/, ''))}</pre>`);
      }
      // ```span``` on one line is inline code, not a block.
      if (spanBody !== undefined) return stash(`<code>${escapeHtml(spanBody)}</code>`);
      if (inlineBody !== undefined) return stash(`<code>${escapeHtml(inlineBody)}</code>`);
      // An existing <pre>/<code> element is kept verbatim, contents included:
      // Telegram forbids formatting entities inside a code entity, so Markdown
      // found in there must not be converted.
      return stash(match);
    },
  );

  // Telegram HTML that arrived with the text (plan_route summaries, EVE mail)
  // must survive the escape step below — a mixed answer carries both that and
  // the agent's Markdown, and escaping the tags would show them literally.
  // Only balanced tags are kept: an unmatched one — a literal "</b>" in prose,
  // or an opener the model never closed — makes Telegram reject the whole
  // payload, and the plain-text retry then strips formatting from the entire
  // message. Unbalanced tags fall through to escapeHtml and show as text.
  out = stashBalancedHtml(out, stash);
  // Entities last: a tag's attributes are already stashed with it by now, so an
  // entity placeholder cannot end up nested inside a tag placeholder.
  out = out.replace(HTML_ENTITY_RE, (entity: string) => stash(entity));

  out = escapeHtml(out);

  out = out
    // [title](http...) — runs on escaped text, so & in the URL is already &amp;
    // (valid inside href) and the title carries no live markup. The destination
    // may contain one level of balanced parentheses: stopping at the first ")"
    // truncates links like .../wiki/Tengu_(ship) and leaks the stray bracket.
    .replace(/\[([^\]\n]+)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))*)\)/g, (_m, title: string, url: string) =>
      `<a href="${url.replace(/"/g, '&quot;')}">${title}</a>`)
    // **bold** before *italic* so the double sigil is never eaten as italics.
    // Content edges are neither space nor star, so "2 ** 3 ** 4" stays literal
    // arithmetic instead of collapsing into <i>* 3 *</i>.
    .replace(/\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*/g, '<b>$1</b>')
    // *italic*: same-line pair with the same edge rule; a list bullet ("* item")
    // has no closing sigil and "5 * 3 * 2" has space-adjacent stars — literal.
    .replace(/(^|[^*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?!\*)/g, '$1<i>$2</i>');

  return out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => stashed[Number(index)] ?? '');
}

/**
 * Stash the Telegram tags that form complete pairs, leaving the rest to be
 * escaped. A single scan with a stack: an opener waits for its own closing tag,
 * a closer without a matching opener is text, and anything still open at the end
 * is text too.
 */
function stashBalancedHtml(text: string, stash: (html: string) => string): string {
  type Found = { start: number; end: number; tag: string; name: string; closing: boolean };
  const found: Found[] = [];
  const pattern = new RegExp(TELEGRAM_HTML_TAG_RE.source, 'gi');

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      tag: match[0],
      name: match[2].toLowerCase(),
      closing: match[1] === '/',
    });
  }
  if (found.length === 0) return text;

  const balanced = new Set<number>();
  const open: number[] = [];
  found.forEach((entry, index) => {
    if (!entry.closing) {
      open.push(index);
      return;
    }
    for (let depth = open.length - 1; depth >= 0; depth -= 1) {
      if (found[open[depth]].name !== entry.name) continue;
      balanced.add(open[depth]).add(index);
      open.length = depth; // tags opened inside an unclosed one are unbalanced too
      return;
    }
  });

  let out = '';
  let cursor = 0;
  found.forEach((entry, index) => {
    out += text.slice(cursor, entry.start);
    out += balanced.has(index) ? stash(entry.tag) : entry.tag;
    cursor = entry.end;
  });
  return out + text.slice(cursor);
}

/** Pick the wire format for one outgoing Telegram message. */
export function formatForTelegram(text: string): { text: string; parseMode: 'HTML' | undefined } {
  // Markdown decides first: a mixed answer (route summary in Telegram HTML plus
  // the agent's chat-Markdown around it) is a normal flow, and treating one tag
  // as proof the whole message is formatted left **bold** on screen literally.
  // The converter preserves the HTML it finds.
  if (MARKDOWN_SIGIL_RE.test(text)) return { text: markdownToTelegramHtml(text), parseMode: 'HTML' };
  if (HTML_MARKUP_RE.test(text)) return { text, parseMode: 'HTML' };
  return { text, parseMode: undefined };
}
