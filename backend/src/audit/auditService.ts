import { callPrivate, type SqlValue } from '../db/privateFunctions.js';
import { isTransactionClient, type Tx } from '../db/client.js';
import { isUuid } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';

/**
 * Backend audit trail, written through the database function `private.write_audit` (append-only
 * `audit_logs`; the database also audits its own workflow functions).
 *
 * THE RULE: a business mutation and its audit record commit or roll back TOGETHER. `record()`
 * therefore only accepts a transaction handed out by `db.withTransaction()`; passing the plain
 * client throws, so an audit row can never be written for a change that later fails (or the reverse).
 *
 *   await db.withTransaction(async (tx) => {
 *     await repository.doTheChange(tx, ...);
 *     await audit.record(tx, { actorId, action: 'user.role_grant', entityType: 'user', ... });
 *   });
 *
 * KNOWN LIMITATION: `private.write_audit` has no parameter for the client IP, so
 * `audit_logs.ip_address` stays NULL. The IP is logged with the same correlation id (see
 * requestLogger / the 'audit' log line) so an audit row can be tied to it. Adding an optional
 * `p_ip` parameter needs a new migration, which is out of scope until approved.
 */
export interface AuditEntry {
  /** null only for system actions */
  readonly actorId: string | null;
  readonly organizationId?: string | null;
  readonly facilityId?: string | null;
  /** dotted verb, e.g. 'user.role_grant' — same convention as the database's own audit actions */
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly oldValue?: Readonly<Record<string, unknown>> | null;
  readonly newValue?: Readonly<Record<string, unknown>> | null;
  readonly correlationId: string;
  /** Not stored (see limitation above); logged next to the correlation id. */
  readonly ip?: string | null;
}

const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const ENTITY = /^[a-z][a-z_]{1,60}$/;
// Audit rows must not carry personal or secret data (proposal §11.2).
const SENSITIVE_KEY = /(passw|token|secret|api_?key|patient|phone|email|date_of_birth|dob|address|contact)/i;
const MAX_JSON_BYTES = 8_000;

export class AuditUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditUsageError';
  }
}

function assertSafeValue(label: string, value: Readonly<Record<string, unknown>> | null | undefined) {
  if (!value) return;
  const json = JSON.stringify(value);
  if (json.length > MAX_JSON_BYTES) throw new AuditUsageError(`${label} is too large for an audit record`);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === 'object') {
      for (const [key, inner] of Object.entries(node)) {
        if (SENSITIVE_KEY.test(key)) throw new AuditUsageError(`${label} must not contain the sensitive field "${key}"`);
        visit(inner);
      }
    }
  };
  visit(value);
}

export interface AuditService {
  record(tx: Tx, entry: AuditEntry): Promise<void>;
}

export function createAuditService(logger: Logger): AuditService {
  return {
    async record(tx, entry) {
      if (!isTransactionClient(tx)) {
        throw new AuditUsageError('audit.record() requires the transaction of the business change (db.withTransaction)');
      }
      if (!ACTION.test(entry.action)) throw new AuditUsageError('action must look like "entity.verb"');
      if (!ENTITY.test(entry.entityType)) throw new AuditUsageError('entityType must be lower_snake_case');
      for (const [label, id] of [['actorId', entry.actorId], ['organizationId', entry.organizationId], ['facilityId', entry.facilityId],
        ['entityId', entry.entityId], ['correlationId', entry.correlationId]] as const) {
        if (id !== null && id !== undefined && !isUuid(id)) throw new AuditUsageError(`${label} must be a UUID`);
      }
      assertSafeValue('oldValue', entry.oldValue);
      assertSafeValue('newValue', entry.newValue);

      await callPrivate(tx, 'write_audit', {
        p_actor: entry.actorId,
        p_organization: entry.organizationId ?? null,
        p_facility: entry.facilityId ?? null,
        p_action: entry.action,
        p_entity_type: entry.entityType,
        p_entity_id: entry.entityId ?? null,
        p_old: (entry.oldValue ?? null) as SqlValue,
        p_new: (entry.newValue ?? null) as SqlValue,
        p_correlation: entry.correlationId,
      });
      logger.info('audit', {
        action: entry.action, entityType: entry.entityType, entityId: entry.entityId, actorId: entry.actorId,
        requestId: entry.correlationId, ip: entry.ip ?? null,
      });
    },
  };
}
