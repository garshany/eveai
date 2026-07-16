import { Fragment, type ReactNode } from 'react';

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'code'; language: string; value: string };

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseBlocks(normalizeLegacyFormatting(content));
  return blocks.map((block, blockIndex) => {
    const key = `${block.kind}-${blockIndex}`;
    if (block.kind === 'code') {
      return <pre key={key} data-language={block.language || undefined}><code>{block.value}</code></pre>;
    }
    if (block.kind === 'unordered-list') {
      return <ul key={key}>{block.items.map((item, index) => (
        <li key={`${key}-${index}`}>{parseInline(item, `${key}-${index}`)}</li>
      ))}</ul>;
    }
    if (block.kind === 'ordered-list') {
      return <ol key={key}>{block.items.map((item, index) => (
        <li key={`${key}-${index}`}>{parseInline(item, `${key}-${index}`)}</li>
      ))}</ol>;
    }
    return <p key={key}>{block.lines.map((line, index) => (
      <Fragment key={`${key}-${index}`}>
        {index > 0 ? <br /> : null}
        {parseInline(line, `${key}-${index}`)}
      </Fragment>
    ))}</p>;
  });
}

function parseBlocks(content: string): Block[] {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```([\w+-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', language: fence[1] ?? '', value: code.join('\n') });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push({ kind: 'unordered-list', items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push({ kind: 'ordered-list', items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length
      && (lines[index] ?? '').trim()
      && !/^```/.test(lines[index] ?? '')
      && !/^\s*[-*]\s+/.test(lines[index] ?? '')
      && !/^\s*\d+\.\s+/.test(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}

function parseInline(value: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const result: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(value)) !== null) {
    if (match.index > cursor) result.push(value.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith('**')) {
      result.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      result.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeLink(link[2] ?? '') : null;
      result.push(href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{link?.[1]}</a>
        : token);
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) result.push(value.slice(cursor));
  return result;
}

export function safeLink(value: string): string | null {
  try {
    if (/[\u0000-\u001f\u007f]/.test(value)) return null;
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeLegacyFormatting(content: string): string {
  let value = decodeHtmlEntities(content.replaceAll('\r\n', '\n'));
  value = value.replace(/<code>([\s\S]*?)<\/code>/gi, (_match, body: string) => {
    const clean = body.replace(/^\s+|\s+$/g, '');
    return clean.includes('\n') ? `\n\n\`\`\`\n${clean}\n\`\`\`\n\n` : `\`${clean.replaceAll('`', '′')}\``;
  });
  value = value.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, body: string) => `**${body}**`);
  value = value.replace(/<a\s+href=(['"])(.*?)\1\s*>([\s\S]*?)<\/a>/gi, (_match, _quote: string, href: string, label: string) => {
    const safe = safeLink(href);
    return safe ? `[${label.replace(/[\[\]]/g, '')}](${safe})` : label;
  });
  return value;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (entity, code: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
    const lower = code.toLowerCase();
    if (named[lower] !== undefined) return named[lower];
    const numeric = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}
