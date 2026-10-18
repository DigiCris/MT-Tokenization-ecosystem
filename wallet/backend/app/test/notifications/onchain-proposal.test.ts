// P15.T07: el watcher (indexer + sincronización de rotaciones) detecta propuestas de rotación hechas on-chain que no
// originó el backend —aquí U + R por el camino soberano, transmitidas por un relayer cualquiera— y notifica igual (email +
// in-app, origen ONCHAIN): el usuario puede cancelarla con su firma por el relay. La cancelación por la propia Safe
// (U + R llamando a `cancel`) también se refleja (cancelledBy SAFE).
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rotationTimelockAbi } from '../../src/chain/abis/index.ts';
import { RotationKind } from '../../src/chain/constants.ts';
import { resetRateLimits, until } from '../helpers/onboarding.ts';
import {
  activeWallet,
  nextEmail,
  startOperationsEnv,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { rotationRow, rotationView, signCancel, syncRotations } from '../helpers/rotations.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.notifications });
  wallet = await activeWallet(env);
  env.base.startDeployWorker();
}, 600_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetRateLimits(env.base.redis);
});

const random = (): Address => getAddress(`0x${randomBytes(20).toString('hex')}`);

/** U + R proponen la rotación de S por el camino soberano (sin el backend ni el signer). */
async function sovereignProposal(newValue: Address): Promise<string> {
  await env.chain.execSovereign(
    wallet.safe,
    {
      to: env.base.snapshot.contracts.rotationTimelock,
      data: encodeFunctionData({
        abi: rotationTimelockAbi,
        functionName: 'propose',
        args: [RotationKind.Executor, wallet.executor, newValue],
      }),
    },
    [wallet.userKey, wallet.recoveryKey],
  );
  await syncRotations(env);
  const row = await env.base.db.app
    .selectFrom('rotation_requests')
    .select('id')
    .where('wallet_id', '=', wallet.walletId)
    .where('new_key', '=', Buffer.from(newValue.slice(2), 'hex'))
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('propuesta on-chain no originada por el backend', { timeout: 300_000 }, () => {
  it('se registra con origen ONCHAIN y se notifica (email + in-app); el usuario la cancela con su firma', async () => {
    const newValue = random();
    const rotationId = await sovereignProposal(newValue);
    const row = await rotationRow(env, rotationId);
    expect(row).toMatchObject({
      role: 'S',
      origin: 'ONCHAIN',
      initiated_by: 'SAFE',
      status: 'PENDING_TIMELOCK',
      propose_operation_id: null,
    });
    const email = await nextEmail(wallet.onboarded.user.account.email, 'Propuesta de rotación de clave');
    expect(email.text).toContain('propuesta on-chain');
    expect(email.text).toContain('podés cancelarla');
    const notifications = await wallet.onboarded.user.recovery.get('/api/v1/notifications');
    expect(notifications.json<{ items: { type: string; payload: Record<string, unknown> }[] }>().items).toContainEqual(
      expect.objectContaining({
        type: 'ROTATION_PROPOSED',
        payload: expect.objectContaining({ origin: 'ONCHAIN', rotationId, newKey: newValue }) as unknown,
      }),
    );

    // La API ofrece la cancelación también para la propuesta que no preparó: firma de U → relay → CANCELLED.
    const view = await rotationView(wallet, rotationId);
    const response = await env.base.wallet
      .newClient()
      .post(`/api/v1/rotations/${rotationId}/cancel`, { signature: await signCancel(wallet.userKey, view) });
    expect(response.statusCode, response.body).toBe(202);
    await until(async () => {
      const proposal = await env.chain.public.readContract({
        address: env.base.snapshot.contracts.rotationTimelock,
        abi: rotationTimelockAbi,
        functionName: 'getProposal',
        args: [view.proposalId as Hex],
      });
      return proposal.status === 2 ? true : undefined;
    }, 60_000);
    await syncRotations(env);
    expect(await rotationRow(env, rotationId)).toMatchObject({ status: 'CANCELLED', cancelled_by: 'U' });
  });

  it('la propia Safe (U + R soberano) cancela su propuesta: CANCELLED con cancelledBy SAFE', async () => {
    const rotationId = await sovereignProposal(random());
    const view = await rotationView(wallet, rotationId);
    await env.chain.execSovereign(
      wallet.safe,
      {
        to: env.base.snapshot.contracts.rotationTimelock,
        data: encodeFunctionData({ abi: rotationTimelockAbi, functionName: 'cancel', args: [view.proposalId as Hex] }),
      },
      [wallet.userKey, wallet.recoveryKey],
    );
    await syncRotations(env);
    expect(await rotationRow(env, rotationId)).toMatchObject({ status: 'CANCELLED', cancelled_by: 'SAFE' });
    const cancelled = await env.base.db.app
      .selectFrom('notifications')
      .select('payload')
      .where('wallet_id', '=', wallet.walletId)
      .where('type', '=', 'ROTATION_CANCELLED')
      .execute();
    expect(cancelled.map((n) => (n.payload as { cancelledBy: string }).cancelledBy)).toContain('SAFE');
  });
});
