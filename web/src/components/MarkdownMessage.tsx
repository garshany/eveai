import { Fragment, type ReactNode } from 'react';

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'code'; language: string; value: string };

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseBlocks(content);
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
        {index > 0 ? ' ' : null}
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

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
