/**
 * Discord output formatting: converts the agent's Telegram-flavored HTML
 * into Discord markdown and chunks messages to Discord's 2000-char limit.
 */
import { sanitizeOutput } from '../agent/finalizer.js';

export const MAX_DISCORD_LENGTH = 2000;

/** Convert Telegram-style HTML markup into Discord markdown. */
export function htmlToDiscordMarkdown(text: string): string {
  let result = text;

  // Extract code segments first and shield them behind placeholders so later
  // tag/entity replacements never touch their content.
  const codeSegments: string[] = [];
  const stash = (segment: string): string => {
    codeSegments.push(segment);
    return `\u0000${codeSegments.length - 1}\u0000`;
  };
  result = result.replace(/<pre>(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?<\/pre>/gi, (_m, body: string) =>
    stash(`\`\`\`\n${decodeEntities(body)}\n\`\`\``));
  result = result.replace(/<code>([\s\S]*?)<\/code>/gi, (_m, body: string) =>
    stash(`\`${decodeEntities(body)}\``));

  result = result.replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  result = result.replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*');
  result = result.replace(/<(?:u|ins)>([\s\S]*?)<\/(?:u|ins)>/gi, '__$1__');
  result = result.replace(/<(?:s|strike|del)>([\s\S]*?)<\/(?:s|strike|del)>/gi, '~~$1~~');
  result = result.replace(/<tg-spoiler>([\s\S]*?)<\/tg-spoiler>/gi, '||$1||');
  result = result.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const cleanLabel = label.trim();
    return cleanLabel && cleanLabel !== href ? `${cleanLabel} (${href})` : href;
  });

  // Drop only known leftover HTML tags (EVE mail markup, block elements), then
  // decode entities. A blanket <...> strip would eat legitimate text like an
  // alliance ticker "<CCP>" or "<C C P>" from ESI/SDE data.
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<\/?(?:font|span|div|p|blockquote|small|big|sub|sup|strong|em|b|i|u|s|strike|del|ins|ul|ol|li|table|tr|td|th|thead|tbody|h[1-6]|color|loc|url|a|code|pre)\b[^>]*>/gi, '');
  result = decodeEntities(result);

  return result.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codeSegments[Number(index)] ?? '');
}

/**
 * Sanitize secrets, convert markup, and split to Discord-sized chunks.
 * Pass a smaller `limit` when a prefix will be prepended to each chunk —
 * Discord hard-rejects payloads over 2000 chars.
 */
export function splitForDiscord(text: string, limit: number = MAX_DISCORD_LENGTH): string[] {
  const sanitized = htmlToDiscordMarkdown(sanitizeOutput(text));
  if (sanitized.length <= limit) return [sanitized];

  // Reserve room for the code-fence rebalancing markers added below.
  limit = Math.max(64, limit - 10);

  const chunks: string[] = [];
  let remaining = sanitized;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    let cut = slice.lastIndexOf('\n');
    if (cut < Math.floor(limit * 0.6)) {
      const space = slice.lastIndexOf(' ');
      if (space > Math.floor(limit * 0.6)) {
        cut = space;
      } else {
        cut = -1;
      }
    }
    if (cut === -1) cut = limit;

    chunks.push(remaining.slice(0, cut));
    let nextStart = cut;
    while (nextStart < remaining.length && (remaining[nextStart] === '\n' || remaining[nextStart] === ' ')) {
      nextStart += 1;
    }
    remaining = remaining.slice(nextStart);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return rebalanceCodeFences(chunks);
}

/**
 * The agent renders tables as fenced code blocks, so long answers often split
 * mid-fence. Close an unbalanced fence at the chunk end and reopen it at the
 * start of the next chunk so both halves render as code.
 */
function rebalanceCodeFences(chunks: string[]): string[] {
  let openFence = false;
  return chunks.map((chunk, index) => {
    let result = chunk;
    if (openFence) {
      result = '```\n' + result;
    }
    const fenceCount = (result.match(/```/g) ?? []).length;
    openFence = fenceCount % 2 === 1;
    if (openFence && index < chunks.length - 1) {
      result = result + '\n```';
    }
    return result;
  });
}

function decodeEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}
