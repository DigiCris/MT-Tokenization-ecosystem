// P15.T01: propuesta asistida en el RotationTimelock. La clave nueva nunca la manda el cliente: S' la crea el signer
// para la wallet (con su SignerKeyAttestation). U propone desde Wallet y R desde Recovery ([W-07], [C-GRD-11]); la
// SafeTx `propose(kind, old, new)` la firma U o R y la ejecuta la S vigente por el pipeline real; con el evento
// `RotationProposed` confirmado la rotación queda PENDING_TIMELOCK con el `executableAt` leído on-chain, con email y
// notificación in-app. Rechazos: R no propone R ni el Guard, U sin U' registrada, una segunda propuesta del mismo rol.
import { getAddress, type Hex } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rotationTimelockAbi } from '../../src/chain/abis/index.ts';
import { RotationKind } from '../../src/chain/constants.ts';
import { resetRateLimits, type Session } from '../helpers/onboarding.ts';
import {
  activeWallet,
  expireCreated,
  nextEmail,
  startOperationsEnv,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import {
  propose,
  proposeRequest,
  recoverySession,
  rotationRow,
  rotationView,
  signAndExecute,
  syncRotations,
  TIMELOCK_DELAY_SECONDS,
} from '../helpers/rotations.ts';

let env: OperationsEnv;
let first: ActiveWallet;
let second: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.rotationPropose });
  first = await activeWallet(env);
  second = await activeWallet(env);
}, 900_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetRateLimits(env.base.redis);
  await expireCreated(env, first);
  await expireCreated(env, second);
});

async function onchainProposal(id: Hex) {
  return env.chain.public.readContract({
    address: env.base.snapshot.contracts.rotationTimelock,
    abi: rotationTimelockAbi,
    functionName: 'getProposal',
    args: [id],
  });
}

describe('propuesta asistida de S', { timeout: 300_000 }, () => {
  it('U propone S → S′ creada por el signer → firma U → ejecución por S → PENDING_TIMELOCK con executableAt on-chain, email y notificación', async () => {
    const { rotation, operation } = await propose(first, { role: 'U' }, 'S');
    expect(rotation).toMatchObject({
      role: 'S',
      status: 'AWAITING_SIGNATURE',
      origin: 'PLATFORM',
      initiatedBy: 'U',
      oldKey: first.executor,
      proposalId: null,
      cancelTypedData: null,
    });
    expect(operation).toMatchObject({
      operationType: 'ROTATION_PROPOSE',
      safeTx: { to: env.base.snapshot.contracts.rotationTimelock, value: '0', operation: 0 },
      decoded: { role: 'S', oldKey: first.executor, newKey: rotation.newKey },
    });
    // S′ es una clave del signer para esta wallet, PENDING y con atestación hasta que la rotación se ejecute.
    const signerKey = await env.base.db.app
      .selectFrom('signer_keys')
      .select(['status', 'attestation', 'shard_id'])
      .where('wallet_id', '=', first.walletId)
      .where('address', '=', Buffer.from(rotation.newKey.slice(2), 'hex'))
      .executeTakeFirstOrThrow();
    expect(signerKey).toMatchObject({ status: 'PENDING', shard_id: 'dev-1' });
    expect(signerKey.attestation).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

    await signAndExecute(env, first, operation, { role: 'U' });
    // Firmada y ejecutada, antes del evento confirmado: la sincronización del worker la pasa a PROPOSING.
    await env.rotationSync().runOnce();
    expect((await rotationRow(env, rotation.id)).status).toBe('PROPOSING');
    const before = await env.chain.public.getBlock();
    await syncRotations(env);
    const row = await rotationRow(env, rotation.id);
    expect(row.status).toBe('PENDING_TIMELOCK');
    const proposalId: Hex = `0x${(row.proposal_id ?? Buffer.alloc(0)).toString('hex')}`;
    const onchain = await onchainProposal(proposalId);
    expect(onchain).toMatchObject({ kind: RotationKind.Executor, status: 1 });
    expect(getAddress(onchain.oldValue)).toBe(first.executor);
    expect(getAddress(onchain.newValue)).toBe(rotation.newKey);
    expect(row.executable_at?.getTime()).toBe(Number(onchain.executableAt) * 1000);
    // 48 h desde el bloque de la propuesta (reloj de la cadena).
    expect(Number(onchain.executableAt)).toBeGreaterThanOrEqual(Number(before.timestamp) + TIMELOCK_DELAY_SECONDS);

    const view = await rotationView(first, rotation.id);
    expect(view).toMatchObject({ status: 'PENDING_TIMELOCK', proposalId });
    expect(view.cancelTypedData).toMatchObject({
      primaryType: 'CancelRotation',
      message: { proposalId, safe: first.safe },
      domain: { verifyingContract: env.base.snapshot.contracts.rotationTimelock, chainId: 8453 },
    });

    const email = await nextEmail(first.onboarded.user.account.email, 'Propuesta de rotación de clave');
    expect(email.text).toContain('clave de la plataforma (S)');
    const notifications = await first.onboarded.user.wallet.get('/api/v1/notifications');
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json<{ items: { type: string; payload: Record<string, unknown> }[] }>().items).toContainEqual(
      expect.objectContaining({
        type: 'ROTATION_PROPOSED',
        payload: expect.objectContaining({ rotationId: rotation.id, origin: 'PLATFORM', role: 'S' }) as unknown,
      }),
    );
    const audit = await env.base.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('target_type', '=', 'rotation')
      .where('target_id', '=', rotation.id)
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.event_type)).toEqual(['ROTATION_PROPOSAL_PREPARED', 'ROTATION_PROPOSED']);
  });

  it('una segunda propuesta del mismo rol mientras la primera está pendiente → 409', async () => {
    const again = await proposeRequest(first, { role: 'U' }, 'S');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'CONFLICT' });
  });

  it('R propone S desde Recovery (sesión RECOVERY) y la ejecuta la S vigente', async () => {
    const session: Session = await recoverySession(second);
    const { rotation, operation } = await propose(second, { role: 'R', session }, 'S');
    expect(rotation).toMatchObject({ role: 'S', initiatedBy: 'R', status: 'AWAITING_SIGNATURE' });
    await signAndExecute(env, second, operation, { role: 'R', session });
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('PENDING_TIMELOCK');
  });
});

describe('rechazos de la propuesta', { timeout: 300_000 }, () => {
  it('R no propone la rotación de R ni el upgrade del Guard; U no propone U sin U′ registrada', async () => {
    const session = await recoverySession(second);
    for (const role of ['R', 'GUARD', 'MODULE_GUARD']) {
      // El step-up RECOVERY y las propuestas comparten el cupo de [B-RL] (3/día por usuario).
      await resetRateLimits(env.base.redis);
      const response = await proposeRequest(second, { role: 'R', session }, role);
      expect(response.statusCode, role).toBe(403);
      expect(response.json()).toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
    }
    await resetRateLimits(env.base.redis);
    const noReplacement = await proposeRequest(second, { role: 'U' }, 'U');
    expect(noReplacement.statusCode).toBe(409);
    expect(noReplacement.json<{ detail: string }>().detail).toContain('registrá primero la clave U nueva');
    const noEnrollment = await proposeRequest(second, { role: 'U' }, 'R');
    expect(noEnrollment.statusCode).toBe(409);
    expect(noEnrollment.json<{ detail: string }>().detail).toContain('vinculá primero la clave R nueva');
  });

  it('sin sucesor registrado en el PolicyRegistry no hay upgrade del Guard', async () => {
    const response = await proposeRequest(first, { role: 'U' }, 'GUARD');
    expect(response.statusCode).toBe(409);
    expect(response.json<{ detail: string }>().detail).toContain('sucesor');
  });

  it('[B-RL] propuestas de rotación: 3 por día por usuario (bucket recovery-sensitive)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await proposeRequest(first, { role: 'U' }, 'GUARD')).statusCode);
    expect(codes).toEqual([409, 409, 409, 429]);
  });
});
