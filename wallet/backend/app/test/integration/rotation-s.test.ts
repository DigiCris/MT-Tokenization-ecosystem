// P15.TST.d: rotación de S y continuidad de operaciones con S′. R propone y ejecuta el reemplazo de S desde Recovery
// (sesión RECOVERY, firma R; [W-07]); ya ejecutada, el gas tank recarga a S′ (pasada periódica sobre las S vigentes) y
// las operaciones siguientes (NoOp y un SEND real a un destino activo) las ejecuta S′ con la clave que el signer creó
// para la wallet. La S anterior dejó de ser owner: una ejecución directa con U + S vieja revierte.
import { randomBytes } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { iSafeAbi } from '../../src/chain/abis/index.ts';
import { safeTxHash, type SafeTx } from '../../src/chain/safe-tx.ts';
import { executorAccount } from '../helpers/compromised-signer.ts';
import { resetRateLimits, type Session } from '../helpers/onboarding.ts';
import {
  activeWallet,
  expireCreated,
  noopCall,
  operationRow,
  queueOperation,
  sendCall,
  startOperationsEnv,
  statusOf,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import {
  executePrepare,
  propose,
  recoverySession,
  rotationRow,
  signAndExecute,
  syncRotations,
  warpTimelock,
} from '../helpers/rotations.ts';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const UNIT = 1_000_000n;

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.rotationS });
  wallet = await activeWallet(env);
  await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, wallet.safe, 100n * UNIT);
}, 600_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetRateLimits(env.base.redis);
  await expireCreated(env, wallet);
});

async function txSender(operationId: string): Promise<string> {
  const row = await operationRow(env, operationId);
  const receipt = await env.chain.public.getTransactionReceipt({
    hash: `0x${(row.tx_hash ?? Buffer.alloc(0)).toString('hex')}`,
  });
  return getAddress(receipt.from);
}

describe('rotación de S con R y continuidad', { timeout: 600_000 }, () => {
  it('R propone y ejecuta S → S′; el gas tank recarga S′ y las operaciones siguientes las ejecuta S′', async () => {
    const oldS = wallet.executor;
    const session: Session = await recoverySession(wallet);
    const { rotation, operation } = await propose(wallet, { role: 'R', session }, 'S');
    const newS = rotation.newKey;
    await signAndExecute(env, wallet, operation, { role: 'R', session });
    await syncRotations(env);
    await warpTimelock(env);
    await env.rotationSync().runOnce();
    expect((await rotationRow(env, rotation.id)).status).toBe('READY_TO_EXECUTE');
    await resetRateLimits(env.base.redis);
    const execution = await executePrepare(wallet, { role: 'R', session }, rotation.id);
    await signAndExecute(env, wallet, execution.operation, { role: 'R', session });
    expect(await txSender(execution.operation.operationId)).toBe(oldS);
    await syncRotations(env);
    expect((await rotationRow(env, rotation.id)).status).toBe('EXECUTED');

    // S′ arranca sin ETH: la pasada del gas tank la lleva al objetivo (S vigente de una wallet activa).
    expect(await env.chain.public.getBalance({ address: newS })).toBe(0n);
    const pass = await env.base.gasTank.runOnce();
    expect(pass.toppedUp).toBeGreaterThanOrEqual(1);
    expect(await env.chain.public.getBalance({ address: newS })).toBeGreaterThan(0n);

    // NoOp de U ejecutada por S′.
    const noop = await queueOperation(env, wallet, noopCall(wallet));
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, noop.operationId)).toBe('MINED');
    expect(await txSender(noop.operationId)).toBe(newS);

    // SEND real a un destino activo, también por S′.
    const destination = getAddress(`0x${randomBytes(20).toString('hex')}`);
    await env.chain.whitelistSovereign(wallet.safe, env.base.snapshot.contracts.destinationWhitelist, destination, [
      wallet.userKey,
      wallet.recoveryKey,
    ]);
    const send = await queueOperation(env, wallet, sendCall(env, wallet, 'USDC', destination, 10n * UNIT));
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, send.operationId)).toBe('MINED');
    expect(await txSender(send.operationId)).toBe(newS);
    expect(await env.chain.tokenBalance(env.base.snapshot.tokens.USDC, destination)).toBe(10n * UNIT);
  });

  it('la S anterior ya no es owner: U + S vieja directo en la Safe revierte', async () => {
    const retired = await env.base.db.app
      .selectFrom('signer_keys')
      .select('address')
      .where('wallet_id', '=', wallet.walletId)
      .where('status', '=', 'RETIRED')
      .executeTakeFirstOrThrow();
    const oldS = executorAccount(env.base.executorShard, getAddress(`0x${retired.address.toString('hex')}`));
    const isOwner = await env.chain.public.readContract({
      address: wallet.safe,
      abi: iSafeAbi,
      functionName: 'isOwner',
      args: [oldS.address],
    });
    expect(isOwner).toBe(false);
    const safeTx: SafeTx = {
      to: wallet.safe,
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: await env.chain.safeNonce(wallet.safe),
    };
    const hash = safeTxHash(8453, wallet.safe, safeTx);
    const signed = await Promise.all(
      [wallet.userKey, oldS].map(async (o) => ({ signer: o.address, signature: await o.sign({ hash }) })),
    );
    signed.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
    const signatures: Hex = `0x${signed.map((s) => s.signature.slice(2)).join('')}`;
    await env.chain.setBalance(oldS.address, 10n ** 17n);
    await expect(
      env.chain.public.simulateContract({
        account: oldS,
        address: wallet.safe,
        abi: iSafeAbi,
        functionName: 'execTransaction',
        args: [wallet.safe, 0n, '0x', 0, 0n, 0n, 0n, ZERO, ZERO, signatures],
      }),
    ).rejects.toThrow(/GS026|revert/i);
  });
});
