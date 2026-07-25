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
const TELEGRAM_HTML_TAG_RE = /<\/?(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|code|pre|a)(?:\s[^<>]*)?>/gi;
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|#\d{1,6});/g;

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
    // Anchored to a line start, and the newline after the optional tag is
    // required. Without both, "до ```код``` после\nследующая строка" retries at
    // the closing delimiter, eats " после" as a language tag and wraps the next
    // line in <pre>. Same-line backticks fall through to the inline rule.
    .replace(/(^|\n)```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (_m, lead: string, _lang: string, body: string) =>
      lead + stash(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`))
    // Same-line ```span```: not a block (no newline), so it renders as inline
    // code rather than leaving stray backticks around it.
    .replace(/```([^`\n]+)```/g, (_m, body: string) => stash(`<code>${escapeHtml(body)}</code>`))
    // Inline code.
    .replace(/`([^`\n]+)`/g, (_m, body: string) => stash(`<code>${escapeHtml(body)}</code>`))
    // Whole <pre>/<code> elements that arrived as HTML are stashed with their
    // contents: Telegram forbids formatting entities inside a code entity, so
    // converting Markdown found in there ("<code>**literal**</code>") produces
    // a payload Telegram rejects, and the sender's plain-text retry then leaves
    // the whole message unformatted. <pre> goes first — Telegram nests
    // <pre><code class="language-x"> and the outer element must win.
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, (block: string) => stash(block))
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, (block: string) => stash(block))
    // Telegram HTML that arrived with the text (plan_route summaries, EVE mail)
    // must survive the escape step below — a mixed answer carries both that and
    // the agent's Markdown, and escaping the tags would show them literally.
    // Runs after code so tags inside a code block stay literal, as intended.
    .replace(TELEGRAM_HTML_TAG_RE, (tag: string) => stash(tag))
    .replace(HTML_ENTITY_RE, (entity: string) => stash(entity));

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
  // Markdown decides first: a mixed answer (route summary in Telegram HTML plus
  // the agent's chat-Markdown around it) is a normal flow, and treating one tag
  // as proof the whole message is formatted left **bold** on screen literally.
  // The converter preserves the HTML it finds.
  if (MARKDOWN_SIGIL_RE.test(text)) return { text: markdownToTelegramHtml(text), parseMode: 'HTML' };
  if (HTML_MARKUP_RE.test(text)) return { text, parseMode: 'HTML' };
  return { text, parseMode: undefined };
}
