export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const ORDER: Record<Exclude<LogLevel, 'silent'>, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Compared after lower-casing and dropping "_" / "-", so databaseUrl, database_url and DATABASE-URL all match.
const SENSITIVE_KEY =
  /(authorization|cookie|token|secret|passw|apikey|servicerole|privatekey|credential|databaseurl|directurl|connectionstring|jwt|xservicekey)/;
const isSensitiveKey = (key: string) => SENSITIVE_KEY.test(key.toLowerCase().replace(/[_-]/g, ''));

const STRING_SCRUBBERS: [RegExp, string][] = [
  [/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://[REDACTED]'],
  [/https?:\/\/[^\s/@]+:[^\s/@]+@[^\s"'`]+/gi, 'https://[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]'],
  [/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]'],
];

/** Removes credentials, tokens and connection strings from free text. */
export function scrubString(value: string): string {
  return STRING_SCRUBBERS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

/** Deep-copies `value`, replacing sensitive keys and scrubbing strings. Safe against cycles. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message), stack: value.stack ? scrubString(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1, seen));
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : redact(inner, depth + 1, seen);
  }
  return out;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Receives one JSON line per entry. Defaults to stdout. */
  sink?: (line: string) => void;
  base?: LogFields;
}

export function createLogger({ level, sink = (line) => process.stdout.write(`${line}\n`), base = {} }: LoggerOptions): Logger {
  const threshold = level === 'silent' ? Number.POSITIVE_INFINITY : ORDER[level];

  const write = (name: keyof typeof ORDER, message: string, fields?: LogFields) => {
    if (ORDER[name] < threshold) return;
    const entry = { time: new Date().toISOString(), level: name, msg: scrubString(message), ...(redact({ ...base, ...fields }) as object) };
    sink(JSON.stringify(entry));
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger({ level, sink, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
