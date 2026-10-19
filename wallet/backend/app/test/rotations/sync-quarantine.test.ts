// Revisión de seguridad de ADR-033 (ALTO 1, d): un evento del RotationTimelock que no se puede aplicar ya no frena la
// sincronización de todas las wallets. Queda en cuarentena (error, intentos, próximo intento con espera exponencial,
// alerta `ROTATION_EVENT_QUARANTINED` y métricas), los eventos posteriores de su Safe esperan detrás de él y los de las
// otras Safes se aplican; corregida la causa, se aplica al reintentarlo y después sigue el resto de su Safe, en orden.
// Sin quórum de RPC (la cancelación necesita los roles on-chain) el evento espera sin cuarentena. Sin la cadena: los
// eventos se escriben como los deja el indexer.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter } from '../../src/audit/audit-writer.ts';
import type { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { addressToBuffer } from '../../src/lib/bytes.ts';
import { createMetrics, type Metrics } from '../../src/observability/metrics.ts';
import { loadPolicySnapshot, type BackendPolicySnapshot } from '../../src/policy/snapshot.ts';
import { quarantineDelayMs, RotationSync } from '../../src/rotations/sync.ts';
import { unreachableRpc } from '../helpers/api.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, insertUser, type TestDatabase } from '../helpers/db.ts';
import { captureLogger } from '../helpers/logs.ts';
import { seedActiveWallet } from '../helpers/platform.ts';
import { edKey, vectorSystem, writePolicySnapshot } from '../helpers/signer-shard.ts';

const logs = captureLogger('info');
let db: TestDatabase;
let metrics: Metrics;
let rpc: RpcQuorumClient;
let sync: RotationSync;
let snapshot: BackendPolicySnapshot;
let snapshotDir: string;
const addr = (): Address => getAddress(privateKeyToAccount(generatePrivateKey()).address);

beforeAll(async () => {
  db = await createTestDatabase();
  snapshotDir = mkdtempSync(join(tmpdir(), 'mtw-sync-quarantine-'));
  const key = edKey();
  snapshot = loadPolicySnapshot(writePolicySnapshot(snapshotDir, key, vectorSystem()), key.publicKey, 'local');
  metrics = createMetrics({ defaultMetrics: false });
  // La cancelación lee los roles del Guard del timelock: con el RPC inalcanzable, sin quórum.
  rpc = unreachableRpc(logs.logger, metrics);
  sync = new RotationSync({
    db: db.app,
    rpc,
    audit: new AuditWriter(testConfig().secrets.auditChainKey, metrics),
    emails: null,
    snapshot: () => snapshot,
    logger: logs.logger,
    metrics,
  });
});

afterAll(async () => {
  await rpc.stop();
  await db.close();
  rmSync(snapshotDir, { recursive: true, force: true });
});

async function activeSafe(): Promise<{ walletId: string; safe: Address }> {
  const userId = await insertUser(db.app);
  const { walletId, safe } = await seedActiveWallet(db, { userId, platformId: 'mt-test' });
  if (safe === null) throw new Error('wallet sin Safe');
  return { walletId, safe };
}

let block = 1_000;

/**
 * Evento confirmado del RotationTimelock, como lo deja el indexer (bloques crecientes). `rotationKind`: 0 = U, 2 = S
 * (una sola propuesta viva por rol y Safe).
 */
async function event(safe: Address, kind: 'PROPOSED' | 'CANCELLED', rotationKind = 0, proposalId = randomBytes(32)) {
  block += 1;
  const row = await db.app
    .insertInto('rotation_events')
    .values({
      chain_id: 8453,
      safe_address: addressToBuffer(safe),
      timelock: addressToBuffer(snapshot.contracts.rotationTimelock),
      proposal_id: proposalId,
      kind,
      ...(kind === 'PROPOSED'
        ? {
            rotation_kind: rotationKind,
            old_value: addressToBuffer(addr()),
            new_value: addressToBuffer(addr()),
            executable_at: new Date(Date.now() + 48 * 3600_000),
          }
        : { actor: addressToBuffer(addr()) }),
      tx_hash: randomBytes(32),
      log_index: 0,
      block_number: block,
      block_hash: randomBytes(32),
      status: 'CONFIRMED',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, proposalId };
}

async function eventRow(id: string) {
  return db.app.selectFrom('rotation_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

const quarantineAlerts = (eventId: string) =>
  logs.lines().filter((l) => l.alert === 'ROTATION_EVENT_QUARANTINED' && l.eventId === eventId);

describe('sincronización de rotaciones con un evento que falla', () => {
  it('cuarentena: el evento que falla espera con su Safe detrás; las otras Safes siguen; corregido, se aplica en orden', async () => {
    const a = await activeSafe();
    const b = await activeSafe();
    // A1 choca con una propuesta ya registrada con el mismo id (constraint único): no se puede aplicar.
    const a1 = await event(a.safe, 'PROPOSED');
    const blocker = await db.app
      .insertInto('rotation_requests')
      .values({
        wallet_id: a.walletId,
        role: 'U',
        old_key: addressToBuffer(addr()),
        new_key: addressToBuffer(addr()),
        initiated_by: 'U',
        status: 'CANCELLED',
        cancelled_by: 'U',
        proposal_id: a1.proposalId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const b1 = await event(b.safe, 'PROPOSED');
    const a2 = await event(a.safe, 'PROPOSED', 2);

    const before = Date.now();
    const first = await sync.runOnce();
    expect(first).toMatchObject({ applied: 1, quarantined: 1 });
    expect((await eventRow(b1.id)).applied_at).toBeInstanceOf(Date);
    const quarantined = await eventRow(a1.id);
    expect(quarantined.applied_at).toBeNull();
    expect(quarantined.apply_attempts).toBe(1);
    expect(quarantined.apply_error).toContain('rotation_requests_proposal_key');
    expect(quarantined.quarantined_at).toBeInstanceOf(Date);
    expect(quarantined.retry_at?.getTime()).toBeGreaterThanOrEqual(before + quarantineDelayMs(1));
    // El siguiente de la misma Safe espera detrás (el orden por Safe no se pierde).
    expect(await eventRow(a2.id)).toMatchObject({ applied_at: null, apply_attempts: 0, quarantined_at: null });
    expect(quarantineAlerts(a1.id)).toHaveLength(1);
    expect(await metrics.registry.getSingleMetricAsString('mtw_rotation_event_apply_failures_total')).toContain(
      'mtw_rotation_event_apply_failures_total{kind="PROPOSED"} 1',
    );
    expect(await metrics.registry.getSingleMetricAsString('mtw_rotation_events_quarantined')).toContain(
      'mtw_rotation_events_quarantined 1',
    );

    // Antes de que venza la espera no se reintenta y nada de A avanza.
    expect(await sync.runOnce()).toMatchObject({ applied: 0, quarantined: 0 });
    expect((await eventRow(a1.id)).apply_attempts).toBe(1);

    // Vencida la espera, si sigue fallando: más intentos y una espera más larga, sin repetir la alerta.
    await db.app.updateTable('rotation_events').set({ retry_at: new Date() }).where('id', '=', a1.id).execute();
    expect(await sync.runOnce()).toMatchObject({ applied: 0, quarantined: 1 });
    const again = await eventRow(a1.id);
    expect(again.apply_attempts).toBe(2);
    expect(again.quarantined_at).toEqual(quarantined.quarantined_at);
    expect(quarantineDelayMs(2)).toBe(2 * quarantineDelayMs(1));
    expect(quarantineAlerts(a1.id)).toHaveLength(1);
    expect((await eventRow(a2.id)).applied_at).toBeNull();

    // Corregida la causa (el operador resuelve el choque), se aplica al reintentarlo y sale de la cuarentena; el
    // siguiente de A se aplica en la pasada que sigue.
    await db.app.deleteFrom('rotation_requests').where('id', '=', blocker.id).execute();
    await db.app.updateTable('rotation_events').set({ retry_at: new Date() }).where('id', '=', a1.id).execute();
    expect(await sync.runOnce()).toMatchObject({ applied: 1, quarantined: 0 });
    expect(await eventRow(a1.id)).toMatchObject({ quarantined_at: null, retry_at: null, apply_attempts: 2 });
    expect((await eventRow(a1.id)).applied_at).toBeInstanceOf(Date);
    expect(
      logs
        .lines()
        .filter((l) => l.eventId === a1.id && l.msg === 'evento de rotación aplicado: salió de la cuarentena'),
    ).toHaveLength(1);
    expect(await sync.runOnce()).toMatchObject({ applied: 1, quarantined: 0 });
    expect((await eventRow(a2.id)).applied_at).toBeInstanceOf(Date);
    expect(await metrics.registry.getSingleMetricAsString('mtw_rotation_events_quarantined')).toContain(
      'mtw_rotation_events_quarantined 0',
    );
    const proposals = await db.app
      .selectFrom('rotation_requests')
      .select(['wallet_id', 'status', 'origin'])
      .where('wallet_id', 'in', [a.walletId, b.walletId])
      .execute();
    expect(proposals).toHaveLength(3);
    expect(proposals.every((p) => p.status === 'PENDING_TIMELOCK' && p.origin === 'ONCHAIN')).toBe(true);
  });

  it('sin quórum de RPC la cancelación espera sin cuarentena, con los siguientes de su Safe detrás, y los demás siguen', async () => {
    const c = await activeSafe();
    const d = await activeSafe();
    const c1 = await event(c.safe, 'CANCELLED');
    const c2 = await event(c.safe, 'PROPOSED');
    const d1 = await event(d.safe, 'PROPOSED');

    expect(await sync.runOnce()).toMatchObject({ applied: 1, quarantined: 0 });
    expect((await eventRow(d1.id)).applied_at).toBeInstanceOf(Date);
    for (const id of [c1.id, c2.id]) {
      expect(await eventRow(id)).toMatchObject({ applied_at: null, quarantined_at: null, apply_attempts: 0 });
    }
    expect(quarantineAlerts(c1.id)).toHaveLength(0);
    expect(
      logs
        .lines()
        .filter(
          (l) => l.eventId === c1.id && l.msg === 'evento de rotación sin aplicar: se reintenta en la próxima pasada',
        ),
    ).toHaveLength(1);
  });
});
