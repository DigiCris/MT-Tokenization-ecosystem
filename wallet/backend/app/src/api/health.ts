// Readiness (P08.T07): base de datos, migraciones al día, Valkey y RPC. Cada chequeo tiene su timeout; el reporte
// nunca incluye URLs, credenciales ni mensajes de error de los drivers.
import { sql, type Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import { pendingMigrations } from '../db/migrator.ts';
import type { Database } from '../db/schema.ts';

export interface ReadinessDeps {
  db: Kysely<Database>;
  redis: Redis;
  rpc: RpcQuorumClient;
  timeoutMs?: number;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: {
    database: { ok: boolean; latencyMs: number | null };
    migrations: { ok: boolean; pending: string[] };
    valkey: { ok: boolean; latencyMs: number | null };
    rpc: {
      ok: boolean;
      mode: 'local-single' | 'dual';
      providers: {
        provider: string;
        healthy: boolean;
        reason: string;
        head: string | null;
        lagBlocks: number | null;
      }[];
    };
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function timed(fn: () => Promise<unknown>, ms: number): Promise<{ ok: boolean; latencyMs: number | null }> {
  const started = performance.now();
  try {
    await withTimeout(fn(), ms);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessReport> {
  const ms = deps.timeoutMs ?? 2_000;
  const [database, migrations, valkey, rpcHealth] = await Promise.all([
    timed(() => sql`SELECT 1`.execute(deps.db), ms),
    withTimeout(pendingMigrations(deps.db), ms).then(
      (pending) => ({ ok: pending.length === 0, pending }),
      () => ({ ok: false, pending: [] as string[] }),
    ),
    timed(() => deps.redis.ping(), ms),
    (async () => {
      const current = deps.rpc.health();
      if (current.providers.some((p) => p.checkedAt === null)) {
        await withTimeout(deps.rpc.checkHealth(), ms).catch(() => undefined);
      }
      return deps.rpc.health();
    })(),
  ]);
  const rpc = {
    ok: rpcHealth.ready,
    mode: rpcHealth.mode,
    providers: rpcHealth.providers.map((p) => ({
      provider: p.provider,
      healthy: p.healthy,
      reason: p.reason,
      head: p.head === null ? null : p.head.toString(),
      lagBlocks: p.lagBlocks,
    })),
  };
  const ready = database.ok && migrations.ok && valkey.ok && rpc.ok;
  return { status: ready ? 'ready' : 'not_ready', checks: { database, migrations, valkey, rpc } };
}
