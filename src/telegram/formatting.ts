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

  let out = text
    // Fenced blocks: ```lang\n...``` (language tag dropped; unterminated -> EOF).
    // The newline after the optional tag is required: without it, "a ```b``` c"
    // would swallow the whole line as a language tag and emit an empty <pre>,
    // losing the text. Same-line backticks fall through to the inline rule.
    .replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (_m, _lang: string, body: string) =>
      stash(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`))
    // Inline code.
    .replace(/`([^`\n]+)`/g, (_m, body: string) => stash(`<code>${escapeHtml(body)}</code>`));

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

/** Pick the wire format for one outgoing Telegram message. */
export function formatForTelegram(text: string): { text: string; parseMode: 'HTML' | undefined } {
  if (HTML_MARKUP_RE.test(text)) return { text, parseMode: 'HTML' };
  if (MARKDOWN_SIGIL_RE.test(text)) return { text: markdownToTelegramHtml(text), parseMode: 'HTML' };
  return { text, parseMode: undefined };
}
