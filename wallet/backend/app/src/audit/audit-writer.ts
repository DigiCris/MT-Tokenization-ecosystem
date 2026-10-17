// Audit log append-only con cadena HMAC [B-AUD].
//
// Escritura serializada: cada inserción toma pg_advisory_xact_lock(AUDIT_LOCK_KEY) dentro de la transacción del
// llamador, lee la cabeza de la cadena y asigna el id con nextval bajo el lock (un solo escritor lógico). Así el
// evento se confirma atómicamente con el cambio de estado que audita.
//
// En READ COMMITTED cada sentencia toma un snapshot nuevo, así que la cabeza leída después del advisory lock es la
// vigente. En REPEATABLE READ/SERIALIZABLE el snapshot es de la primera sentencia de la transacción: si se tomó antes
// de que otro escritor confirmara, la cabeza leída sería vieja. Por eso esas transacciones deben abrirse con
// `withTransaction(db, fn, { auditLock: true })`, que toma `LOCK TABLE audit_chain_lock` antes del snapshot;
// `append` lo verifica y rechaza la escritura si falta.
//
//   entry_hash = HMAC-SHA256(AUDIT_CHAIN_KEY, prev_hash ‖ JCS(entrada))
//
// La entrada canónica incluye el id, así que ni el orden ni el contenido pueden alterarse sin romper la cadena; el
// primer evento encadena contra 32 bytes en cero. audit_events rechaza UPDATE/DELETE/TRUNCATE (trigger + GRANTs).
import { createHmac } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Secret } from '../config/secret.ts';
import { bufferToHex } from '../lib/bytes.ts';
import { canonicalJson } from '../lib/jcs.ts';
import type { Metrics } from '../observability/metrics.ts';
import { redact } from '../observability/redaction.ts';
import type { AuditActorType, Database } from '../db/schema.ts';

/** Clave del advisory lock de la cadena de auditoría ("MTWAUDIT" en ASCII). */
export const AUDIT_LOCK_KEY = 0x4d54574155444954n;
export const GENESIS_HASH = Buffer.alloc(32);

/** Eventos mínimos de [B-AUD] (`OPERATION_<ESTADO>` se arma con el estado). */
export const AUDIT_EVENT_TYPES = [
  'AUTH_LOGIN_SUCCEEDED',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGOUT',
  'AUTH_PASSWORD_RESET_REQUESTED',
  'AUTH_PASSWORD_RESET_COMPLETED',
  'SESSION_REVOKED',
  'PLATFORM_SESSION_ISSUED',
  'TOTP_ENABLED',
  'TOTP_DISABLED',
  'WHITELIST_REQUESTED',
  'WHITELIST_CHALLENGE_PASSED',
  'WHITELIST_CHALLENGE_FAILED',
  'WHITELIST_CONFIRMED_ONCHAIN',
  'WHITELIST_REMOVED',
  'OPERATION_PROPOSED',
  'OPERATION_SIGNATURE_RECEIVED',
  'S_SIGNATURE_ISSUED',
  'S_EXECUTION_SUBMITTED',
  'ROTATION_PROPOSED',
  'ROTATION_CANCELLED',
  'ROTATION_EXECUTED',
  'RECOVERY_U_REPLACEMENT_STARTED',
  'POLICY_SNAPSHOT_ACTIVATED',
  'INTEGRITY_MISMATCH',
  'COOPERATION_PAUSED',
  'COOPERATION_RESUMED',
  'RPC_DISAGREEMENT',
  'REORG_DETECTED',
] as const;

const EVENT_TYPE = /^[A-Z][A-Z0-9_]{2,63}$/;

export interface AuditEventInput {
  actorType: AuditActorType;
  eventType: string;
  actorId?: string | null;
  userId?: string | null;
  walletId?: string | null;
  sessionId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  /** Prefijo de IP ya truncado (/24 o /48). */
  ipPrefix?: string | null;
  /** Se guarda redactado (las mismas reglas que los logs). */
  payload?: Record<string, unknown>;
}

/** Entrada tal como queda guardada (y como la lee el verificador). */
export interface AuditEntry {
  id: string;
  occurredAt: Date;
  actorType: AuditActorType;
  actorId: string | null;
  userId: string | null;
  walletId: string | null;
  sessionId: string | null;
  eventType: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  ipPrefix: string | null;
  payload: unknown;
}

export function canonicalAuditEntry(entry: AuditEntry): string {
  return canonicalJson({
    id: entry.id,
    occurredAt: entry.occurredAt.toISOString(),
    actorType: entry.actorType,
    actorId: entry.actorId,
    userId: entry.userId,
    walletId: entry.walletId,
    sessionId: entry.sessionId,
    eventType: entry.eventType,
    targetType: entry.targetType,
    targetId: entry.targetId,
    requestId: entry.requestId,
    ipPrefix: entry.ipPrefix,
    payload: entry.payload,
  });
}

export function computeEntryHash(key: Buffer, prevHash: Buffer, entry: AuditEntry): Buffer {
  return createHmac('sha256', key).update(prevHash).update(canonicalAuditEntry(entry), 'utf8').digest();
}

/** jsonb no admite U+0000: se reemplaza para que el payload guardado sea exactamente el que se hashea. */
function sanitizeForJsonb(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '�');
  if (Array.isArray(value)) return value.map(sanitizeForJsonb);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replaceAll('\u0000', '�'), sanitizeForJsonb(v)]),
    );
  }
  return value;
}

export class AuditLockError extends Error {
  override name = 'AuditLockError';
}

export class AuditWriter {
  readonly #key: Secret<Buffer>;
  readonly #metrics: Metrics | undefined;

  constructor(key: Secret<Buffer>, metrics?: Metrics) {
    this.#key = key;
    this.#metrics = metrics;
  }

  /** Agrega un evento dentro de la transacción del llamador. */
  async append(trx: Transaction<Database>, input: AuditEventInput): Promise<{ id: string; entryHash: string }> {
    if (!EVENT_TYPE.test(input.eventType)) throw new Error('event_type inválido');

    const state = await sql<{ isolation: string; locked: boolean }>`
      SELECT current_setting('transaction_isolation') AS isolation,
             EXISTS (SELECT 1 FROM pg_locks
                     WHERE pid = pg_backend_pid() AND relation = 'audit_chain_lock'::regclass
                       AND mode = 'ExclusiveLock' AND granted) AS locked`.execute(trx);
    const row = state.rows[0];
    if (row?.isolation !== 'read committed' && row?.locked !== true) {
      throw new AuditLockError(
        'en REPEATABLE READ/SERIALIZABLE la auditoría exige withTransaction({ auditLock: true })',
      );
    }
    await sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY.toString()}::bigint)`.execute(trx);
    const head = await trx
      .selectFrom('audit_events')
      .select(['entry_hash'])
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const next = await sql<{ id: string }>`SELECT nextval('audit_events_id_seq')::text AS id`.execute(trx);
    const id = next.rows[0]?.id;
    if (id === undefined) throw new Error('nextval sin resultado');

    const payload = JSON.parse(JSON.stringify(sanitizeForJsonb(redact(input.payload ?? {})))) as unknown;
    const entry: AuditEntry = {
      id,
      occurredAt: new Date(),
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      userId: input.userId ?? null,
      walletId: input.walletId ?? null,
      sessionId: input.sessionId ?? null,
      eventType: input.eventType,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      requestId: input.requestId ?? null,
      ipPrefix: input.ipPrefix ?? null,
      payload,
    };
    const prevHash = head ? head.entry_hash : GENESIS_HASH;
    const entryHash = computeEntryHash(this.#key.reveal(), prevHash, entry);

    await trx
      .insertInto('audit_events')
      .values({
        id,
        occurred_at: entry.occurredAt,
        actor_type: entry.actorType,
        actor_id: entry.actorId,
        user_id: entry.userId,
        wallet_id: entry.walletId,
        session_id: entry.sessionId,
        event_type: entry.eventType,
        target_type: entry.targetType,
        target_id: entry.targetId,
        request_id: entry.requestId,
        ip_prefix: entry.ipPrefix,
        payload: JSON.stringify(entry.payload),
        prev_hash: prevHash,
        entry_hash: entryHash,
      })
      .execute();
    this.#metrics?.auditEventsWritten.inc({ event_type: entry.eventType });
    return { id, entryHash: bufferToHex(entryHash) };
  }
}

export type AuditVerification =
  | { ok: true; count: number; headId: string | null; headHash: string | null }
  | { ok: false; count: number; brokenAtId: string; reason: 'PREV_HASH_MISMATCH' | 'ENTRY_HASH_MISMATCH' };

/** Recorre la cadena completa en orden de id (paginado por keyset) y recalcula cada eslabón. */
export async function verifyAuditChain(
  db: Kysely<Database>,
  key: Secret<Buffer>,
  options: { batchSize?: number } = {},
): Promise<AuditVerification> {
  const batchSize = options.batchSize ?? 1_000;
  let prevHash: Buffer = GENESIS_HASH;
  let lastId: string | null = null;
  let count = 0;
  for (;;) {
    let query = db.selectFrom('audit_events').selectAll().orderBy('id', 'asc').limit(batchSize);
    if (lastId !== null) query = query.where('id', '>', lastId);
    const rows = await query.execute();
    for (const row of rows) {
      if (!row.prev_hash.equals(prevHash)) {
        return { ok: false, count, brokenAtId: row.id, reason: 'PREV_HASH_MISMATCH' };
      }
      const expected = computeEntryHash(key.reveal(), prevHash, {
        id: row.id,
        occurredAt: row.occurred_at,
        actorType: row.actor_type,
        actorId: row.actor_id,
        userId: row.user_id,
        walletId: row.wallet_id,
        sessionId: row.session_id,
        eventType: row.event_type,
        targetType: row.target_type,
        targetId: row.target_id,
        requestId: row.request_id,
        ipPrefix: row.ip_prefix,
        payload: row.payload,
      });
      if (!expected.equals(row.entry_hash)) {
        return { ok: false, count, brokenAtId: row.id, reason: 'ENTRY_HASH_MISMATCH' };
      }
      prevHash = row.entry_hash;
      lastId = row.id;
      count++;
    }
    if (rows.length < batchSize) break;
  }
  return { ok: true, count, headId: lastId, headHash: lastId === null ? null : bufferToHex(prevHash) };
}
