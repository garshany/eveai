import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, CopyIcon } from '../icons';
import { useI18n } from '../i18n';

type TableAlign = 'left' | 'center' | 'right';

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'table'; header: string[]; aligns: TableAlign[]; rows: string[][] }
  | { kind: 'code'; language: string; value: string };

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseBlocks(normalizeLegacyFormatting(content));
  return blocks.map((block, blockIndex) => {
    const key = `${block.kind}-${blockIndex}`;
    if (block.kind === 'code') {
      return <CodeBlock key={key} language={block.language} value={block.value} />;
    }
    if (block.kind === 'heading') {
      const Tag = (`h${Math.min(Math.max(block.level + 2, 3), 6)}`) as 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag key={key}>{parseInline(block.text, key)}</Tag>;
    }
    if (block.kind === 'quote') {
      return <blockquote key={key}>{block.lines.map((line, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 ? <br /> : null}
          {parseInline(line, `${key}-${index}`)}
        </Fragment>
      ))}</blockquote>;
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
    if (block.kind === 'table') {
      return (
        <div className="md-table" key={key}>
          <table>
            <thead>
              <tr>{block.header.map((cell, index) => (
                <th key={`${key}-h${index}`} className={tableCellClass(block.aligns[index], cell)}>
                  {parseInline(cell, `${key}-h${index}`)}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-r${rowIndex}`}>{row.map((cell, cellIndex) => (
                  <td key={`${key}-r${rowIndex}-${cellIndex}`} className={tableCellClass(block.aligns[cellIndex], cell)}>
                    {parseInline(cell, `${key}-r${rowIndex}-${cellIndex}`)}
                  </td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <p key={key}>{block.lines.map((line, index) => (
      <Fragment key={`${key}-${index}`}>
        {index > 0 ? <br /> : null}
        {parseInline(line, `${key}-${index}`)}
      </Fragment>
    ))}</p>;
  });
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      // Clipboard unavailable (permissions policy) — leave the button inert.
    }
  };

  return (
    <figure className="code-block">
      <figcaption className="code-block__bar">
        <span className="code-block__language">{language || 'code'}</span>
        <button className="code-block__copy" type="button" onClick={() => void copy()} aria-label={t('copyCode')}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          <span>{copied ? t('copied') : t('copyCode')}</span>
        </button>
      </figcaption>
      <pre data-language={language || undefined}><code>{value}</code></pre>
    </figure>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
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
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quote });
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
    if (isTableStart(lines, index)) {
      const header = splitTableRow(line);
      const aligns = parseTableAligns(lines[index + 1] ?? '', header.length);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').trim() && (lines[index] ?? '').includes('|')) {
        rows.push(normalizeTableRow(splitTableRow(lines[index] ?? ''), header.length));
        index += 1;
      }
      blocks.push({ kind: 'table', header, aligns, rows });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length
      && (lines[index] ?? '').trim()
      && !/^```/.test(lines[index] ?? '')
      && !/^(#{1,4})\s+/.test(lines[index] ?? '')
      && !/^\s*>\s?/.test(lines[index] ?? '')
      && !/^\s*[-*]\s+/.test(lines[index] ?? '')
      && !/^\s*\d+\.\s+/.test(lines[index] ?? '')
      && !isTableStart(lines, index)
    ) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  const next = lines[index + 1] ?? '';
  return line.includes('|') && splitTableRow(line).length > 1 && isTableSeparator(next);
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
}

function parseTableAligns(line: string, columns: number): TableAlign[] {
  const cells = splitTableRow(line);
  return Array.from({ length: columns }, (_, index) => {
    const cell = cells[index] ?? '';
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function normalizeTableRow(cells: string[], columns: number): string[] {
  const row = cells.slice(0, columns);
  while (row.length < columns) row.push('');
  return row;
}

function tableCellClass(align: TableAlign | undefined, cell: string): string | undefined {
  const classes: string[] = [];
  if (align === 'center' || align === 'right') classes.push(`md-align-${align}`);
  if (/\d/.test(cell) && /^[-+−–\d\s.,''%]+$/.test(cell.trim())) classes.push('md-num');
  return classes.length ? classes.join(' ') : undefined;
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
