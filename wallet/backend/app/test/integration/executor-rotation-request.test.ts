// P18.T09.b: rotación de S pedida por la plataforma (migración de shard, HSM, compromiso del host o mantenimiento). Un
// operador corre `operators executor:rotation-request` (CLI real, TOTP por stdin): queda un borrador DRAFT de la
// rotación de S con el motivo y la S′ ya creada en el shard de la wallet con su SignerKeyAttestation; el usuario recibe
// el email y la notificación EXECUTOR_ROTATION_REQUESTED; GET /rotations muestra el motivo y la atestación; un pedido
// repetido devuelve el mismo borrador; la propuesta firmada por U toma ese borrador (misma S′, el signer la co-firma
// porque la creó él) y queda en el timelock.
import { getAddress, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rotationTimelockAbi } from '../../src/chain/abis/index.ts';
import { RotationKind } from '../../src/chain/constants.ts';
import { cliJson, operatorsCli, type OperatorsCli, type TestOperator } from '../helpers/operators.ts';
import {
  activeWallet,
  nextEmail,
  startOperationsEnv,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { propose, signAndExecute, syncRotations } from '../helpers/rotations.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;
let cli: OperatorsCli;
let operator: TestOperator;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.executorRotationRequest });
  wallet = await activeWallet(env);
  cli = operatorsCli(env.base);
  operator = await cli.add('ops');
}, 600_000);

afterAll(async () => {
  cli.cleanup();
  await env.close();
});

interface RequestOutput {
  rotationId: string;
  walletId: string;
  safe: Address;
  oldExecutor: Address;
  newExecutor: Address;
  shardId: string;
  reason: string;
  created: boolean;
}

interface RotationView {
  id: string;
  role: string;
  status: string;
  newKey: Address;
  requestReason: string | null;
  newKeyAttestation: string | null;
}

async function rotations(): Promise<RotationView[]> {
  const response = await wallet.onboarded.user.wallet.get(`/api/v1/wallets/${wallet.walletId}/rotations`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ items: RotationView[] }>().items;
}

describe('rotación de S pedida por la plataforma', () => {
  let requested: RequestOutput;

  it('el operador la pide con el motivo: borrador con S′ atestada por el shard, email y notificación', async () => {
    requested = cliJson(
      await cli.run(
        [
          'executor:rotation-request',
          '--wallet',
          wallet.walletId,
          '--reason',
          'SHARD_MIGRATION',
          '--operator',
          operator.email,
        ],
        await operator.next(),
      ),
    ) as RequestOutput;
    expect(requested).toMatchObject({
      walletId: wallet.walletId,
      safe: wallet.safe,
      reason: 'SHARD_MIGRATION',
      shardId: 'dev-1',
      created: true,
    });
    expect(getAddress(requested.oldExecutor)).toBe(getAddress(wallet.executor));
    expect(getAddress(requested.newExecutor)).not.toBe(getAddress(wallet.executor));

    const draft = (await rotations()).find((r) => r.id === requested.rotationId);
    expect(draft).toMatchObject({ role: 'S', status: 'DRAFT', requestReason: 'SHARD_MIGRATION' });
    expect(getAddress(draft?.newKey ?? '0x')).toBe(getAddress(requested.newExecutor));
    // La atestación es la del signer para esta wallet y esta S′ ([B-SIG-07]) y es la que guarda la base.
    const claims = JSON.parse(
      Buffer.from((draft?.newKeyAttestation ?? '').split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { walletId: string; executor: string; chainId: number };
    expect(claims).toMatchObject({ walletId: wallet.walletId, chainId: 8453 });
    expect(getAddress(claims.executor)).toBe(getAddress(requested.newExecutor));
    const key = await env.base.db.app
      .selectFrom('signer_keys')
      .select(['status', 'attestation'])
      .where('wallet_id', '=', wallet.walletId)
      .where('address', '=', Buffer.from(requested.newExecutor.slice(2), 'hex'))
      .executeTakeFirstOrThrow();
    expect(key).toEqual({ status: 'PENDING', attestation: draft?.newKeyAttestation });

    const inbox = await wallet.onboarded.user.wallet.get('/api/v1/notifications');
    const notification = inbox
      .json<{ items: { type: string; payload: Record<string, unknown> }[] }>()
      .items.find((n) => n.type === 'EXECUTOR_ROTATION_REQUESTED');
    expect(notification?.payload).toMatchObject({ rotationId: requested.rotationId, reason: 'SHARD_MIGRATION' });
    const email = await nextEmail(wallet.onboarded.user.account.email, 'pidió rotar');
    expect(email.text).toContain('migración de la clave a otro servidor de firma');
    expect(email.text).toContain(getAddress(requested.newExecutor).slice(2, 6));

    // Un pedido repetido devuelve el mismo borrador (no crea otra S′).
    const again = cliJson(
      await cli.run(
        [
          'executor:rotation-request',
          '--wallet',
          wallet.walletId,
          '--reason',
          'MAINTENANCE',
          '--operator',
          operator.email,
        ],
        await operator.next(),
      ),
    ) as RequestOutput;
    expect(again).toMatchObject({ rotationId: requested.rotationId, created: false, reason: 'SHARD_MIGRATION' });
    const audit = await env.base.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('target_id', '=', requested.rotationId)
      .execute();
    expect(audit.map((a) => a.event_type)).toContain('EXECUTOR_ROTATION_REQUESTED');
  });

  it('la propuesta de U toma el borrador (misma S′), el signer la co-firma y queda en el timelock', async () => {
    const { rotation, operation } = await propose(wallet, { role: 'U' }, 'S');
    expect(rotation).toMatchObject({ id: requested.rotationId, role: 'S', requestReason: 'SHARD_MIGRATION' });
    expect(getAddress(rotation.newKey)).toBe(getAddress(requested.newExecutor));
    expect(operation.operationType).toBe('ROTATION_PROPOSE');
    await signAndExecute(env, wallet, operation, { role: 'U' });
    await syncRotations(env);
    const active = await env.chain.public.readContract({
      address: env.base.snapshot.contracts.rotationTimelock,
      abi: rotationTimelockAbi,
      functionName: 'activeProposal',
      args: [wallet.safe, RotationKind.Executor],
    });
    const proposal = await env.chain.public.readContract({
      address: env.base.snapshot.contracts.rotationTimelock,
      abi: rotationTimelockAbi,
      functionName: 'getProposal',
      args: [active],
    });
    expect(getAddress(proposal.newValue)).toBe(getAddress(requested.newExecutor));
    expect((await rotations()).find((r) => r.id === requested.rotationId)?.status).toBe('PENDING_TIMELOCK');
  });

  it('motivo desconocido o wallet inexistente: la CLI falla sin efectos', async () => {
    const before = await env.base.db.app.selectFrom('rotation_requests').select('id').execute();
    const unknown = await cli.run(
      ['executor:rotation-request', '--wallet', wallet.walletId, '--reason', 'PORQUE_SI', '--operator', operator.email],
      await operator.next(),
    );
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('--reason tiene que ser uno de');
    const missing = await cli.run(
      [
        'executor:rotation-request',
        '--wallet',
        crypto.randomUUID(),
        '--reason',
        'MAINTENANCE',
        '--operator',
        operator.email,
      ],
      await operator.next(),
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('NOT_FOUND');
    expect(await env.base.db.app.selectFrom('rotation_requests').select('id').execute()).toHaveLength(before.length);
  });
}, 600_000);
