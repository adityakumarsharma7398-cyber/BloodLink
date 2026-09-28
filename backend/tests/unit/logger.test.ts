import { describe, expect, it } from 'vitest';
import { createLogger, redact, scrubString } from '../../src/lib/logger.js';

const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2';
const DB_URL = 'postgres://postgres.ref:S3cr3tP%40ss@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true';

describe('scrubString', () => {
  it('removes connection strings, bearer tokens, JWTs and Supabase keys from free text', () => {
    const text = `connect ${DB_URL} failed; Authorization: Bearer ${JWT}; key sb_secret_abc123XYZ and sb_publishable_qwe456`;
    const clean = scrubString(text);
    expect(clean).not.toContain('S3cr3tP');
    expect(clean).not.toContain(JWT);
    expect(clean).not.toContain('abc123XYZ');
    expect(clean).not.toContain('qwe456');
    expect(clean).toContain('failed');
  });
});

describe('redact', () => {
  it('replaces sensitive keys at any depth and keeps harmless ones', () => {
    const out = redact({
      requestId: 'r1',
      headers: { authorization: `Bearer ${JWT}`, 'x-service-key': 'k', accept: 'json' },
      nested: { password: 'p', token: 't', apiKey: 'a', service_role_key: 's', databaseUrl: DB_URL, ok: 1 },
      list: [{ secret: 'x' }, 'fine'],
    }) as Record<string, any>;
    expect(out.requestId).toBe('r1');
    expect(out.headers.authorization).toBe('[REDACTED]');
    expect(out.headers['x-service-key']).toBe('[REDACTED]');
    expect(out.headers.accept).toBe('json');
    expect(out.nested).toMatchObject({ password: '[REDACTED]', token: '[REDACTED]', apiKey: '[REDACTED]', service_role_key: '[REDACTED]', databaseUrl: '[REDACTED]', ok: 1 });
    expect(out.list[0].secret).toBe('[REDACTED]');
    expect(out.list[1]).toBe('fine');
  });

  it('scrubs error messages and stacks, and survives cycles', () => {
    const error = new Error(`could not connect to ${DB_URL}`);
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    const out = JSON.stringify(redact({ error, cyclic }));
    expect(out).not.toContain('S3cr3tP');
    expect(out).toContain('[CIRCULAR]');
  });
});

describe('createLogger', () => {
  const capture = (level: Parameters<typeof createLogger>[0]['level']) => {
    const lines: string[] = [];
    return { lines, logger: createLogger({ level, sink: (line) => lines.push(line) }) };
  };

  it('writes one JSON line per entry with level, message and fields', () => {
    const { lines, logger } = capture('info');
    logger.info('hello', { requestId: 'abc' });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'info', msg: 'hello', requestId: 'abc' });
    expect(typeof entry.time).toBe('string');
  });

  it('respects the level threshold, including silent', () => {
    const info = capture('warn');
    info.logger.debug('d');
    info.logger.info('i');
    info.logger.warn('w');
    info.logger.error('e');
    expect(info.lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
    const silent = capture('silent');
    silent.logger.error('nothing');
    expect(silent.lines).toEqual([]);
  });

  it('never emits a secret, whether in fields, error text or the message', () => {
    const { lines, logger } = capture('debug');
    logger.error(`failed for ${DB_URL}`, { error: new Error(`token ${JWT}`), authorization: `Bearer ${JWT}`, url: DB_URL });
    const all = lines.join('\n');
    expect(all).not.toContain('S3cr3tP');
    expect(all).not.toContain(JWT);
  });

  it('child loggers add fields', () => {
    const { lines, logger } = capture('info');
    logger.child({ component: 'audit' }).info('x');
    expect(JSON.parse(lines[0]!).component).toBe('audit');
  });
});
