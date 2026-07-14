import { format } from 'node:util';

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9._~+/=-]+)\b/gu,
  /\b(access_token|refresh_token|id_token|api_key|apikey|authorization)=([^&\s]+)/giu,
  // JSON form: "refresh_token":"…" / "access_token": "…"
  /"(access_token|refresh_token|id_token|api_key|apikey|authorization)"\s*:\s*"([^"]+)"/giu,
  /\/\/([^:\s/@]+):([^@\s/]+)@/gu,
];

export type LogLevel = 'info' | 'warn' | 'error';

export type Logger = {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
};

// ---------------------------------------------------------------------------
// Terminal colors (TTY-aware; NO_COLOR / FORCE_COLOR respected)
// ---------------------------------------------------------------------------

const colorsEnabled = process.env.NO_COLOR === undefined
  && (process.env.FORCE_COLOR !== undefined || Boolean(process.stdout.isTTY));

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  magenta: '[35m',
  cyan: '[36m',
  gray: '[90m',
} as const;

export type AnsiColor = keyof typeof ANSI;

export function colorize(color: AnsiColor, text: string): string {
  if (!colorsEnabled) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

const LEVEL_BADGES: Record<LogLevel, string> = {
  info: colorize('green', 'INF'),
  warn: colorize('yellow', 'WRN'),
  error: colorize('red', 'ERR'),
};

const SCOPE_COLORS: AnsiColor[] = ['cyan', 'magenta', 'blue', 'green', 'yellow'];

function scopeColor(scope: string): AnsiColor {
  let hash = 0;
  for (let i = 0; i < scope.length; i += 1) {
    hash = (hash * 31 + scope.charCodeAt(i)) | 0;
  }
  return SCOPE_COLORS[Math.abs(hash) % SCOPE_COLORS.length];
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value instanceof Error) {
    const redacted = new Error(redactString(value.message));
    redacted.name = value.name;
    redacted.stack = value.stack ? redactString(value.stack) : undefined;
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValue(entry));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/token|secret|password|authorization|api[_-]?key/iu.test(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = redactLogValue(entry);
      }
    }
    return result;
  }
  return value;
}

export function createLogger(scope?: string): Logger {
  const scopeTag = scope ? colorize(scopeColor(scope), scope.padEnd(10).slice(0, 10)) + ' ' : '';

  return {
    info(message, ...args) {
      writeLog('info', scopeTag, message, args);
    },
    warn(message, ...args) {
      writeLog('warn', scopeTag, message, args);
    },
    error(message, ...args) {
      writeLog('error', scopeTag, message, args);
    },
  };
}

function writeLog(level: LogLevel, scopeTag: string, message: string, args: unknown[]): void {
  const redactedArgs = args.map((arg) => redactLogValue(arg));
  const body = redactString(format(message, ...redactedArgs));
  const line = `${colorize('gray', timestamp())} ${LEVEL_BADGES[level]} ${scopeTag}${body}`;
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}

function redactString(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (match, first: string | undefined) => {
      if (match.startsWith('//') && first) {
        return `//${first}:[redacted]@`;
      }
      if (/^Bearer\s/iu.test(match)) {
        return 'Bearer [redacted]';
      }
      if (/=/u.test(match)) {
        return match.replace(/=([^&\s]+)/u, '=[redacted]');
      }
      return '[redacted]';
    }),
    value,
  );
}

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

export type BannerRow = { label: string; value: string; state?: 'ok' | 'off' | 'warn' };

/**
 * Print a boxed startup summary, e.g.:
 *
 *   ┌─ EVE AI Agent v3.2.0 ──────────────────┐
 *   │ Database   ✔ ./data/eve-agent.db       │
 *   │ Telegram   ✔ long polling              │
 *   │ Discord    − disabled (no token)       │
 *   └────────────────────────────────────────┘
 */
export function printStartupBanner(title: string, rows: BannerRow[]): void {
  const labelWidth = Math.max(...rows.map((row) => row.label.length), 8);
  const lines = rows.map((row) => {
    const mark = row.state === 'off' ? '−' : row.state === 'warn' ? '!' : '✔';
    return `${row.label.padEnd(labelWidth)}  ${mark} ${row.value}`;
  });
  const contentWidth = Math.max(title.length + 4, ...lines.map((line) => line.length)) + 2;

  const top = `┌─ ${title} ${'─'.repeat(Math.max(1, contentWidth - title.length - 3))}┐`;
  const bottom = `└${'─'.repeat(top.length - 2)}┘`;

  console.log(colorize('cyan', top));
  for (const row of rows) {
    const mark = row.state === 'off'
      ? colorize('gray', '−')
      : row.state === 'warn'
        ? colorize('yellow', '!')
        : colorize('green', '✔');
    const label = row.label.padEnd(labelWidth);
    const plain = `${label}  ${row.state === 'off' ? '−' : row.state === 'warn' ? '!' : '✔'} ${row.value}`;
    const padding = ' '.repeat(Math.max(0, top.length - 4 - plain.length));
    console.log(`${colorize('cyan', '│')} ${colorize('bold', label)}  ${mark} ${row.value}${padding} ${colorize('cyan', '│')}`);
  }
  console.log(colorize('cyan', bottom));
}
