import { format } from 'node:util';

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9._-]+)\b/gu,
  /\b(access_token|refresh_token|id_token|api_key|apikey|authorization)=([^&\s]+)/giu,
  /\/\/([^:\s/@]+):([^@\s/]+)@/gu,
];

export type LogLevel = 'info' | 'warn' | 'error';

export type Logger = {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
};

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
  const prefix = scope ? `[${scope}] ` : '';

  return {
    info(message, ...args) {
      writeLog('info', prefix + message, args);
    },
    warn(message, ...args) {
      writeLog('warn', prefix + message, args);
    },
    error(message, ...args) {
      writeLog('error', prefix + message, args);
    },
  };
}

function writeLog(level: LogLevel, message: string, args: unknown[]): void {
  const redactedArgs = args.map((arg) => redactLogValue(arg));
  const text = redactString(format(message, ...redactedArgs));
  if (level === 'warn') {
    console.warn(text);
    return;
  }
  if (level === 'error') {
    console.error(text);
    return;
  }
  console.log(text);
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
