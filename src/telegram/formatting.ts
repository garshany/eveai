const HTML_MARKUP_RE = /<(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|code|pre|a)(?:\s|>)/i;

export function pickTelegramParseMode(text: string): 'HTML' | undefined {
  return HTML_MARKUP_RE.test(text) ? 'HTML' : undefined;
}
