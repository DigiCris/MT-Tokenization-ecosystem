// P15.T03: ejecución de una rotación madura. Antes de las 48 h (reloj de la cadena) la API no prepara la ejecución;
// la sincronización del worker la pasa a READY_TO_EXECUTE con notificación; `POST /rotations/{id}/execute/prepare`
// arma `swapOwner(prev, old, new)` con `prev` leído on-chain, la firma U (o R) y la ejecuta la S vigente; el Guard emite
// `RoleRotated` y el timelock `RotationExecuted`, y con el evento confirmado: EXECUTED, S′ ACTIVE y la S anterior
// RETIRED (signer_keys y metadatos de claves), email y notificación. Los efectos de U′ (OPAQUE) y R′ (enrollment) los
// prueba recovery-flows.test.ts.
import { decodeEventLog, decodeFunctionData, getAddress } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { iSafeAbi, rotationTimelockAbi, securityGuardAbi } from '../../src/chain/abis/index.ts';
import { Role } from '../../src/chain/constants.ts';
import { resetRateLimits } from '../helpers/onboarding.ts';
import {
  activeWallet,
  expireCreated,
  nextEmail,
  operationRow,
  startOperationsEnv,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import {
  executePrepare,
  executePrepareRequest,
  propose,
  rotationRow,
  signAndExecute,
  syncRotations,
  warpTimelock,
} from '../helpers/rotations.ts';

const SENTINEL = '0x0000000000000000000000000000000000000001';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.rotationExecute });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetRateLimits(env.base.redis);
  await expireCreated(env, wallet);
});

const addressBytes = (address: string) => Buffer.from(address.slice(2), 'hex');

describe('ejecución de la rotación de S', { timeout: 600_000 }, () => {
  it('madura a las 48 h on-chain → swapOwner con prev on-chain, firma U, ejecución por la S vigente → RoleRotated, EXECUTED y S′ ACTIVE', async () => {
    const { rotation, operation } = await propose(wallet, { role: 'U' }, 'S');
    const oldS = wallet.executor;
    const newS = rotation.newKey;
    await signAndExecute(env, wallet, operation, { role: 'U' });
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('PENDING_TIMELOCK');

    // Inmadura: ni la API la prepara ni la sincronización la marca lista.
    const early = await executePrepareRequest(wallet, { role: 'U' }, rotation.id);
    expect(early.statusCode).toBe(409);
    expect(early.json<{ detail: string }>().detail).toContain('todavía no maduró');
    await env.rotationSync().runOnce();
    expect((await rotationRow(env, rotation.id)).status).toBe('PENDING_TIMELOCK');

    await warpTimelock(env);
    const synced = await env.rotationSync().runOnce();
    expect(synced.ready).toBe(1);
    expect((await rotationRow(env, rotation.id)).status).toBe('READY_TO_EXECUTE');
    const ready = await env.base.db.app
      .selectFrom('notifications')
      .select(['type', 'payload'])
      .where('wallet_id', '=', wallet.walletId)
      .where('type', '=', 'ROTATION_READY')
      .execute();
    expect(ready).toHaveLength(1);

    const prepared = await executePrepare(wallet, { role: 'U' }, rotation.id);
    expect(prepared.operation).toMatchObject({
      operationType: 'ROTATION_EXECUTE',
      safeTx: { to: wallet.safe, value: '0', operation: 0 },
      decoded: { role: 'S', oldKey: oldS, newKey: newS },
    });
    const owners = await env.chain.public.readContract({
      address: wallet.safe,
      abi: iSafeAbi,
      functionName: 'getOwners',
    });
    const index = owners.findIndex((o) => getAddress(o) === oldS);
    const expectedPrev = index === 0 ? SENTINEL : getAddress(owners[index - 1] ?? SENTINEL);
    const call = decodeFunctionData({ abi: iSafeAbi, data: prepared.operation.safeTx.data });
    expect(call.functionName).toBe('swapOwner');
    expect((call.args as readonly string[]).map((a) => getAddress(a))).toEqual([getAddress(expectedPrev), oldS, newS]);

    await signAndExecute(env, wallet, prepared.operation, { role: 'U' });
    const row = await operationRow(env, prepared.operation.operationId);
    const receipt = await env.chain.public.getTransactionReceipt({
      hash: `0x${(row.tx_hash ?? Buffer.alloc(0)).toString('hex')}`,
    });
    // La ejecuta la S vigente (todavía la anterior).
    expect(getAddress(receipt.from)).toBe(oldS);
    const events = receipt.logs.flatMap((log) => {
      for (const abi of [securityGuardAbi, rotationTimelockAbi]) {
        try {
          return [{ address: getAddress(log.address), ...decodeEventLog({ abi, data: log.data, topics: log.topics }) }];
        } catch {
          // otro evento
        }
      }
      return [];
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        address: env.base.snapshot.contracts.securityGuard,
        eventName: 'RoleRotated',
        args: expect.objectContaining({ role: Role.Executor, oldKey: oldS, newKey: newS }) as unknown,
      }),
    );
    expect(events.map((e) => e.eventName)).toContain('RotationExecuted');

    await syncRotations(env);
    const executed = await rotationRow(env, rotation.id);
    expect(executed.status).toBe('EXECUTED');
    expect(executed.executed_at).not.toBeNull();
    const roles = await env.chain.public.readContract({
      address: env.base.snapshot.contracts.securityGuard,
      abi: securityGuardAbi,
      functionName: 'rolesOf',
      args: [wallet.safe],
    });
    expect(getAddress(roles.executor)).toBe(newS);
    const signerKeys = await env.base.db.app
      .selectFrom('signer_keys')
      .select(['address', 'status'])
      .where('wallet_id', '=', wallet.walletId)
      .execute();
    expect(signerKeys.map((k) => [getAddress(`0x${k.address.toString('hex')}`), k.status]).sort()).toEqual(
      [
        [oldS, 'RETIRED'],
        [newS, 'ACTIVE'],
      ].sort(),
    );
    const metadata = await env.base.db.app
      .selectFrom('wallet_keys_metadata')
      .select(['key_address', 'status', 'source'])
      .where('wallet_id', '=', wallet.walletId)
      .where('role', '=', 'S')
      .execute();
    expect(metadata).toContainEqual(expect.objectContaining({ key_address: addressBytes(newS), status: 'ACTIVE' }));
    expect(metadata.filter((m) => m.status === 'ACTIVE')).toHaveLength(1);
    // La S anterior quedó retirada también en su shard ([B-SIG-08]: deja de firmar, keystore a destruir a los 30 días).
    const retired = await env.base.db.app
      .selectFrom('signer_keys')
      .select(['retired_at', 'signer_retired_at'])
      .where('address', '=', addressBytes(oldS))
      .executeTakeFirstOrThrow();
    expect(retired.retired_at).not.toBeNull();
    expect(retired.signer_retired_at).not.toBeNull();
    const inShard = await env.base.executorShard.client.retireKey({
      walletId: wallet.walletId,
      address: oldS,
      safe: wallet.safe,
    });
    expect(inShard.status).toBe('RETIRED');

    const email = await nextEmail(wallet.onboarded.user.account.email, 'Rotación de clave ejecutada');
    expect(email.text).toContain('clave de la plataforma (S)');
    const audit = await env.base.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('target_type', '=', 'rotation')
      .where('target_id', '=', rotation.id)
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.event_type)).toEqual([
      'ROTATION_PROPOSAL_PREPARED',
      'ROTATION_PROPOSED',
      'ROTATION_EXECUTION_PREPARED',
      'ROTATION_EXECUTED',
    ]);
    // Ejecutada: no se puede volver a preparar.
    const again = await executePrepareRequest(wallet, { role: 'U' }, rotation.id);
    expect(again.statusCode).toBe(409);
  });
});
