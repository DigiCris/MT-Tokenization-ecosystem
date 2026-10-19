// Registro de integridad en el backend (P20.T03): cada `intervalMs` el worker pide las atestaciones al monitor, las
// verifica (monitor-client.ts) y guarda en `integrity_status` cada cambio de estado o de release por app, más un latido
// cada 2 min (por debajo de los 5 min de antigüedad máxima de una atestación, para que lo registrado siga vigente).
// Audita `INTEGRITY_MISMATCH` al entrar en MISMATCH y `COOPERATION_PAUSED` / `COOPERATION_RESUMED` en
// cada cambio de la cooperación de S (calculada igual que el signer, que es quien decide). Con varios workers, un
// advisory lock serializa cada pasada; el estado anterior se lee de la base (no de memoria): reiniciar no duplica eventos.
import { sql, type Kysely } from 'kysely';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import {
  cooperationState,
  INTEGRITY_APPS,
  type CooperationState,
  type IntegrityApp,
  type IntegrityAttestation,
  type IntegrityMonitorClient,
} from './monitor-client.ts';

/** "MTWINTEG" en ASCII: lock de las pasadas del registro de integridad. */
const INTEGRITY_LOCK_KEY = 0x4d5457494e544547n;
/** Menor que ATTESTATION_MAX_AGE_SECONDS: con un estado estable, lo registrado nunca queda vencido. */
const HEARTBEAT_SECONDS = 120;
const STATUS_VALUE = { OK: 0, UNREACHABLE: 1, MISMATCH: 2 } as const;
const COOPERATION_VALUE: Record<CooperationState, number> = { ACTIVE: 0, DEGRADED: 1, PAUSED: 2 };

export interface StoredIntegrity {
  latest: Partial<Record<IntegrityApp, IntegrityAttestation>>;
  lastOk: Partial<Record<IntegrityApp, number>>;
}

interface Details {
  manifestSha256?: string;
  observedAt?: number;
  expiresAt?: number;
}

/** Último estado registrado por app (como atestación) y el último OK de cada una. */
export async function storedIntegrity(db: Kysely<Database>, platformId: string): Promise<StoredIntegrity> {
  const rows = await db
    .selectFrom('integrity_status')
    .select(['app', 'release_id', 'status', 'details', 'observed_at'])
    .distinctOn('app')
    .orderBy('app')
    .orderBy('observed_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const oks = await db
    .selectFrom('integrity_status')
    .select(['app', sql<Date>`max(observed_at)`.as('at')])
    .where('status', '=', 'OK')
    .groupBy('app')
    .execute();
  const latest: StoredIntegrity['latest'] = {};
  for (const row of rows) {
    const details = row.details as Details;
    latest[row.app] = {
      platformId,
      app: row.app,
      environment: 'local',
      releaseId: row.release_id,
      manifestSha256: details.manifestSha256 ?? `0x${'0'.repeat(64)}`,
      status: row.status,
      observedAt: details.observedAt ?? Math.floor(new Date(row.observed_at).getTime() / 1000),
      expiresAt: details.expiresAt ?? 0,
    };
  }
  const lastOk: StoredIntegrity['lastOk'] = {};
  for (const row of oks) lastOk[row.app] = Math.floor(new Date(row.at).getTime() / 1000);
  return { latest, lastOk };
}

export interface IntegrityRecorderDeps {
  db: Kysely<Database>;
  audit: AuditWriter;
  client: Pick<IntegrityMonitorClient, 'attestations'>;
  platformId: string;
  logger: Logger;
  metrics?: Metrics;
  now?: () => number;
}

export class IntegrityStatusRecorder {
  readonly #d: IntegrityRecorderDeps;

  constructor(deps: IntegrityRecorderDeps) {
    this.#d = deps;
  }

  /** Una pasada: registra lo nuevo y devuelve el estado de la cooperación. */
  async tick(): Promise<CooperationState> {
    const fresh = await this.#d.client.attestations();
    const nowSeconds = Math.floor((this.#d.now?.() ?? Date.now()) / 1000);
    return withTransaction(
      this.#d.db,
      async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(${INTEGRITY_LOCK_KEY.toString()}::bigint)`.execute(trx);
        const stored = await storedIntegrity(trx, this.#d.platformId);
        const previous = cooperationState(stored.latest, stored.lastOk, nowSeconds);
        for (const { attestation } of fresh) {
          const last = stored.latest[attestation.app];
          const changed =
            last === undefined ||
            last.status !== attestation.status ||
            last.releaseId !== attestation.releaseId ||
            attestation.observedAt - last.observedAt >= HEARTBEAT_SECONDS;
          if (!changed || (last !== undefined && attestation.observedAt <= last.observedAt)) continue;
          await trx
            .insertInto('integrity_status')
            .values({
              app: attestation.app,
              release_id: attestation.releaseId,
              status: attestation.status,
              details: JSON.stringify({
                manifestSha256: attestation.manifestSha256,
                observedAt: attestation.observedAt,
                expiresAt: attestation.expiresAt,
              }),
              observed_at: new Date(attestation.observedAt * 1000),
            })
            .execute();
          if (attestation.status === 'MISMATCH' && last?.status !== 'MISMATCH') {
            await this.#d.audit.append(trx, {
              actorType: 'SYSTEM',
              eventType: 'INTEGRITY_MISMATCH',
              targetType: 'APP',
              targetId: attestation.app,
              payload: { releaseId: attestation.releaseId, manifestSha256: attestation.manifestSha256 },
            });
            this.#d.logger.error({ alert: 'INTEGRITY_MISMATCH', app: attestation.app }, 'mismatch de integridad');
          }
          stored.latest[attestation.app] = attestation;
          if (attestation.status === 'OK') stored.lastOk[attestation.app] = attestation.observedAt;
        }
        const current = cooperationState(stored.latest, stored.lastOk, nowSeconds);
        const recorded = await trx
          .selectFrom('audit_events')
          .select('event_type')
          .where('event_type', 'in', ['COOPERATION_PAUSED', 'COOPERATION_RESUMED'])
          .orderBy('occurred_at', 'desc')
          .orderBy('id', 'desc')
          .executeTakeFirst();
        const wasPaused = recorded?.event_type === 'COOPERATION_PAUSED';
        if ((current === 'PAUSED') !== wasPaused && (recorded !== undefined || current === 'PAUSED')) {
          const eventType = current === 'PAUSED' ? 'COOPERATION_PAUSED' : 'COOPERATION_RESUMED';
          await this.#d.audit.append(trx, {
            actorType: 'SYSTEM',
            eventType,
            targetType: 'PLATFORM',
            targetId: this.#d.platformId,
            payload: {
              previous,
              current,
              apps: Object.fromEntries(INTEGRITY_APPS.map((app) => [app, stored.latest[app]?.status ?? 'NONE'])),
            },
          });
          const log = { alert: eventType, current };
          if (current === 'PAUSED') this.#d.logger.error(log, 'cooperación de S pausada por integridad');
          else this.#d.logger.warn(log, 'cooperación de S reanudada');
        }
        for (const app of INTEGRITY_APPS) {
          const attestation = stored.latest[app];
          const live = attestation !== undefined && attestation.expiresAt > nowSeconds;
          this.#d.metrics?.integrityStatus.set({ app }, live ? STATUS_VALUE[attestation.status] : 3);
        }
        this.#d.metrics?.cooperationState.set(COOPERATION_VALUE[current]);
        return current;
      },
      { auditLock: true },
    );
  }
}
