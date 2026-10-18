// P15.T09: pérdida de una clave S, procedimiento completo del runbook docs/runbooks/executor-key-loss.md en el fork.
// Se pierde el keystore de S en su shard (el signer ya no puede firmar: KEY_UNAVAILABLE); un operador corre
// `operators executor:prepare` (CLI real, TOTP por stdin): S′ nueva en el shard con su atestación y los dos documentos
// de intercambio soberano [W-05]; U + R los firman y un relayer cualquiera los ejecuta (swapOwner + updateRoles, sin el
// backend ni el signer); `operators executor:activate` verifica on-chain que S′ es la S de la Safe, la activa y retira la
// perdida (también en su shard). El gas tank recarga a S′ y la wallet sigue operando en modo asistido.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { securityGuardAbi } from '../../src/chain/abis/index.ts';
import { safeConfigDrift } from '../../src/chain/safe-state.ts';
import { safeTxHash } from '../../src/chain/safe-tx.ts';
import type { SovereignSafeTxDocument } from '../../src/recovery/executor-replacement.ts';
import { safeTxFromJson, safeTxToJson } from '../../src/operations/intent.ts';
import { SignerClientError } from '../../src/signer-client/client.ts';
import { cliJson, operatorsCli, type OperatorsCli, type TestOperator } from '../helpers/operators.ts';
import {
  activeWallet,
  noopCall,
  operationRow,
  queueOperation,
  startOperationsEnv,
  statusOf,
  submissionBody,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;
let cli: OperatorsCli;
let operator: TestOperator;
let other: TestOperator;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.executorKeyLoss });
  wallet = await activeWallet(env);
  cli = operatorsCli(env.base);
  operator = await cli.add('support');
  other = await cli.add('support-2');
}, 600_000);

afterAll(async () => {
  cli.cleanup();
  await env.close();
});

async function roles() {
  return env.chain.public.readContract({
    address: env.base.snapshot.contracts.securityGuard,
    abi: securityGuardAbi,
    functionName: 'rolesOf',
    args: [wallet.safe],
  });
}

/** Pedido de firma directo al shard (sin operación del backend): con el keystore perdido, el signer no firma. */
async function signerAttempt(): Promise<unknown> {
  const nonce = await env.chain.safeNonce(wallet.safe);
  const safeTx = safeTxToJson({
    to: wallet.safe,
    value: 0n,
    data: '0x',
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce,
  });
  const operationId = crypto.randomUUID();
  const hash = safeTxHash(8453, wallet.safe, safeTxFromJson(safeTx));
  const body = await submissionBody(wallet, {
    operationId,
    safeTxHash: hash,
    safe: wallet.safe,
    safeTx,
    chainId: 8453,
  });
  const fees = await env.base.rpc.feeData();
  return env.base.executorShard.client
    .signSafeTx({
      operationId,
      walletId: wallet.walletId,
      safe: wallet.safe,
      chainId: 8453,
      operationType: 'NOOP_CANCEL',
      safeTx,
      ownerSignature: body.ownerSignature,
      ownerRole: 'U',
      platformSessionToken: wallet.session.token,
      submissionEnvelope: body.submissionEnvelope,
      submissionEnvelopeSignature: body.submissionEnvelopeSignature,
      policySnapshotVersion: env.base.snapshot.version,
      execution: {
        accountNonce: String(await env.chain.public.getTransactionCount({ address: wallet.executor })),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
}

describe('pérdida de S: reemplazo soberano por U + R', { timeout: 600_000 }, () => {
  it('keystore perdido → prepare (S′ + documentos W-05) → U + R ejecutan → activate → S′ opera', async () => {
    const lost = wallet.executor;
    rmSync(join(env.base.executorShard.keystoreDir, `${lost.toLowerCase()}.json`), { force: true });
    const refused = await signerAttempt();
    // La clave de esa wallet quedó inutilizable (503 reintentable); el shard sigue listo para las demás.
    expect(refused).toBeInstanceOf(SignerClientError);
    expect(refused).toMatchObject({ code: 'SIGNER_NOT_READY', reason: 'KEY_UNAVAILABLE' });

    // Activar antes de que U + R instalen S′ → conflicto (y el TOTP del operador va por stdin).
    const prepared = cliJson(
      await cli.run(
        ['executor:prepare', '--wallet', wallet.walletId, '--operator', operator.email, '--out', cli.dir],
        await operator.next(),
      ),
    ) as { newExecutor: Address; oldExecutor: Address; attestation: string; documents: string[] };
    expect(getAddress(prepared.oldExecutor)).toBe(lost);
    // La atestación es del shard para esta wallet y esta S′ ([B-SIG-07]).
    const claims = JSON.parse(Buffer.from(prepared.attestation.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      walletId: string;
      executor: string;
    };
    expect(claims).toMatchObject({ walletId: wallet.walletId });
    expect(getAddress(claims.executor)).toBe(getAddress(prepared.newExecutor));
    const early = await cli.run(
      ['executor:activate', '--wallet', wallet.walletId, '--operator', other.email],
      await other.next(),
    );
    expect(early.code).toBe(1);
    expect(early.stderr).toContain('todavía no es la nueva');

    // U + R firman los dos documentos soberanos (recalculando el SafeTxHash, como las apps) y un relayer los transmite.
    const documents = prepared.documents.map(
      (file) => JSON.parse(readFileSync(file, 'utf8')) as SovereignSafeTxDocument,
    );
    expect(documents.map((d) => d.action.type)).toEqual(['EXECUTOR_REPLACEMENT_SWAP', 'EXECUTOR_REPLACEMENT_ROLES']);
    for (const doc of documents) {
      expect(doc).toMatchObject({ format: 'mtw-sovereign-safetx', version: 1, chainId: 8453, safe: wallet.safe });
      expect(safeTxHash(8453, wallet.safe, safeTxFromJson(doc.safeTx))).toBe(doc.safeTxHash);
      expect(BigInt(doc.safeTx.nonce)).toBe(await env.chain.safeNonce(wallet.safe));
      await env.chain.execSovereign(wallet.safe, { to: getAddress(doc.safeTx.to), data: doc.safeTx.data }, [
        wallet.userKey,
        wallet.recoveryKey,
      ]);
    }
    const onchain = await roles();
    expect(getAddress(onchain.executor)).toBe(getAddress(prepared.newExecutor));
    expect(onchain.initialized).toBe(true);

    // Dos operaciones de operador seguidas: el anti-replay exige otro paso TOTP.
    const activated = cliJson(
      await cli.run(
        ['executor:activate', '--wallet', wallet.walletId, '--operator', operator.email],
        await operator.next(),
      ),
    ) as { newExecutor: Address; oldExecutor: Address };
    expect(getAddress(activated.oldExecutor)).toBe(lost);
    const keys = await env.base.db.app
      .selectFrom('signer_keys')
      .select(['address', 'status', 'retired_at'])
      .where('wallet_id', '=', wallet.walletId)
      .execute();
    expect(keys.map((k) => [getAddress(`0x${k.address.toString('hex')}`), k.status]).sort()).toEqual(
      [
        [lost, 'RETIRED'],
        [getAddress(prepared.newExecutor), 'ACTIVE'],
      ].sort(),
    );
    const walletRow = await env.base.db.app
      .selectFrom('wallets')
      .select('status')
      .where('id', '=', wallet.walletId)
      .executeTakeFirstOrThrow();
    expect(walletRow.status).toBe('ACTIVE');
    // La Safe sigue en modo asistido (owners = roles, Guard y module guard intactos).
    const state = await env.base.rpc.readSensitive('test-state', async (client, blockNumber) => {
      const { readSafeState } = await import('../../src/chain/safe-state.ts');
      return readSafeState(client, blockNumber, env.base.snapshot, wallet.safe);
    });
    expect(safeConfigDrift(state.value, env.base.snapshot)).toEqual([]);

    // La sincronización pide al shard el retiro de la S perdida; el gas tank recarga a S′ y una NoOp la ejecuta S′.
    await env.rotationSync().runOnce();
    const retired = await env.base.db.app
      .selectFrom('signer_keys')
      .select('signer_retired_at')
      .where('address', '=', Buffer.from(lost.slice(2), 'hex'))
      .executeTakeFirstOrThrow();
    expect(retired.signer_retired_at).not.toBeNull();
    await env.base.gasTank.runOnce();
    const noop = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, noop.operationId)).toBe('MINED');
    const row = await operationRow(env, noop.operationId);
    const receipt = await env.chain.public.getTransactionReceipt({
      hash: `0x${(row.tx_hash ?? Buffer.alloc(0)).toString('hex')}`,
    });
    expect(getAddress(receipt.from)).toBe(getAddress(prepared.newExecutor));
    const audit = await env.base.db.app
      .selectFrom('audit_events')
      .select(['event_type', 'actor_type'])
      .where('wallet_id', '=', wallet.walletId)
      .where('event_type', 'in', ['EXECUTOR_REPLACEMENT_PREPARED', 'EXECUTOR_REPLACED'])
      .orderBy('id')
      .execute();
    expect(audit).toEqual([
      { event_type: 'EXECUTOR_REPLACEMENT_PREPARED', actor_type: 'OPERATOR' },
      { event_type: 'EXECUTOR_REPLACED', actor_type: 'OPERATOR' },
    ]);
  });

  it('un TOTP incorrecto o reutilizado no autoriza la acción y queda auditado', async () => {
    const wrong = await cli.run(
      ['executor:prepare', '--wallet', wallet.walletId, '--operator', operator.email, '--out', cli.dir],
      '000000',
    );
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/TOTP_INVALID|TOTP_REPLAY/);
    const failures = await env.base.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('event_type', '=', 'OPERATOR_AUTH_FAILED')
      .where('actor_id', '=', operator.id)
      .execute();
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const missing = await cli.run(
      ['executor:prepare', '--wallet', wallet.walletId, '--operator', operator.email, '--out', cli.dir],
      '',
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('stdin');
  });
});
