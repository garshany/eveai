import { format } from 'node:util';

type Redactor = (match: string, ...groups: unknown[]) => string;

// Order matters: more specific rules (Authorization header, bot tokens) run
// before the generic Bearer / opaque-token rules.
const REDACTIONS: Array<{ pattern: RegExp; replace: Redactor }> = [
  // Telegram bot token, as it appears in an api.telegram.org request URL
  // (…/bot<id>:<secret>/sendMessage) or on its own. This is the concrete leak:
  // a failed send throws an error whose message embeds the full URL.
  { pattern: /\bbot\d{5,}:[A-Za-z0-9_-]{20,}/giu, replace: () => 'bot[redacted]' },
  // Discord bot/user token: three base64url segments of characteristic length.
  { pattern: /\b[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/gu, replace: () => '[redacted]' },
  // Authorization header with any scheme (Basic base64, Bearer, Digest).
  { pattern: /\bAuthorization:\s*(Basic|Bearer|Digest)\s+[A-Za-z0-9._~+/=-]+/giu, replace: (_m, scheme) => `Authorization: ${String(scheme)} [redacted]` },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, replace: () => 'Bearer [redacted]' },
  { pattern: /\b(sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9._~+/=-]+)\b/gu, replace: () => '[redacted]' },
  { pattern: /\b(access_token|refresh_token|id_token|api_key|apikey|authorization|client_secret)=([^&\s]+)/giu, replace: (_m, key) => `${String(key)}=[redacted]` },
  // JSON form: "refresh_token":"…" / "client_secret": "…"
  { pattern: /"(access_token|refresh_token|id_token|api_key|apikey|authorization|client_secret)"\s*:\s*"([^"]+)"/giu, replace: (_m, key) => `"${String(key)}":"[redacted]"` },
  { pattern: /\/\/([^:\s/@]+):([^@\s/]+)@/gu, replace: (_m, user) => `//${String(user)}:[redacted]@` },
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

export function redactLogValue(value: unknown, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value instanceof Error) {
    if (ancestors.has(value)) return '[circular]';
    ancestors.add(value);
    try {
      const redacted = new Error(redactString(value.message));
      redacted.name = value.name;
      redacted.stack = value.stack ? redactString(value.stack) : undefined;
      // Grammy/fetch errors carry the offending request (the URL with the bot
      // token) on `cause`; redact it explicitly. Only the named `cause` field is
      // copied — never a dynamic key from the error, which would be a
      // prototype-pollution sink. Any other nested field still gets scrubbed
      // when writeLog runs redactString over the whole formatted line.
      if (value.cause !== undefined) {
        (redacted as { cause?: unknown }).cause = redactLogValue(value.cause, ancestors);
      }
      return redacted;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!value || typeof value !== 'object') return value;
  // A cyclic structure (request/socket objects, error causes) must not turn a
  // log call into a stack overflow. Only ANCESTORS count: an object shared by
  // two siblings is not a cycle and is rendered both times.
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactLogValue(entry, ancestors));
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Never assign a prototype-mutating key onto the result: an object built
      // from untrusted input could carry an own "__proto__"/"constructor"/
      // "prototype" key, and copying it dynamically is a prototype-pollution
      // sink. These keys carry no useful log content, so drop them.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      if (/token|secret|password|authorization|api[_-]?key/iu.test(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = redactLogValue(entry, ancestors);
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
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
  return REDACTIONS.reduce(
    (current, rule) => current.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string),
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
 *   ┌─ EVE AI Agent v3.3.0 ──────────────────┐
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
