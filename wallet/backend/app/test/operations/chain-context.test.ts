// P13 (pasos 4–8 de [B-Q-02]): el contexto on-chain de cada tipo de operación contra el sistema desplegado en el fork
// y una Safe ACTIVE real: las lecturas de cada rama (saldos, allowance, whitelist, migración, sucesores del Guard,
// propuestas del timelock, prevOwner) usan los ABIs generados de los contratos y devuelven los hechos que la policy
// espera; el pre-check (`evaluateAssisted` + `eth_call` desde la Safe) informa ok o el motivo del revert.
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, encodeErrorResult, getAddress, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iSafeAbi, rotationTimelockAbi, securityGuardAbi, swapExecutorV3Abi } from '../../src/chain/abis/index.ts';
import { RotationKind } from '../../src/chain/constants.ts';
import type { SafeTx } from '../../src/chain/safe-tx.ts';
import { decodeRevertReason, policyFactsFrom, readOperationContext } from '../../src/operations/chain-context.ts';
import { decodedView } from '../../src/operations/intent.ts';
import { decodeOperation } from '../../src/policy/evaluate.ts';
import {
  activeWallet,
  startOperationsEnv,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.chainContext });
  wallet = await activeWallet(env);
  await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, wallet.safe, 7_000_000n);
}, 600_000);

afterAll(async () => {
  await env.close();
});

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const random = () => getAddress(`0x${randomBytes(20).toString('hex')}`);

function safeTx(to: Address, data: `0x${string}`): SafeTx {
  return {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: 0n,
  };
}

async function context(tx: SafeTx, precheck = false) {
  const call = decodeOperation(env.base.snapshot, wallet.safe, tx);
  if (call === null) throw new Error('la SafeTx de prueba no decodifica');
  const { value } = await readOperationContext(env.base.rpc, env.base.snapshot, {
    safe: wallet.safe,
    safeTx: tx,
    call,
    ownerRole: 'U',
    precheck,
  });
  return { call, value };
}

describe('contexto on-chain por tipo de operación', () => {
  it('SWAP: saldo y allowance hacia el SwapExecutor del token de entrada', async () => {
    const s = env.base.snapshot;
    const { call, value } = await context(
      safeTx(
        s.contracts.swapExecutor,
        encodeFunctionData({
          abi: swapExecutorV3Abi,
          functionName: 'swap',
          args: [s.tokens.USDC, 2_000_000n, 1_990_000n, BigInt(Math.floor(Date.now() / 1000) + 600)],
        }),
      ),
    );
    expect(value.facts).toEqual({ balance: '7000000', allowance: '0' });
    expect(decodedView(call)).toMatchObject({
      tokenIn: 'USDC',
      tokenOut: 'USDT',
      amount: '2000000',
      minAmountOut: '1990000',
    });
    expect(policyFactsFrom(value)).toMatchObject({ balance: 7_000_000n, allowance: 0n });
  });

  it('ROTATION_PROPOSE del Guard: sucesor registrado en PolicyRegistry (no lo hay); de S: sin lecturas extra', async () => {
    const s = env.base.snapshot;
    const guard = await context(
      safeTx(
        s.contracts.rotationTimelock,
        encodeFunctionData({
          abi: rotationTimelockAbi,
          functionName: 'propose',
          args: [RotationKind.Guard, s.contracts.securityGuard, random()],
        }),
      ),
    );
    expect(guard.value.facts).toEqual({ successorRegistered: false });
    expect(decodedView(guard.call)).toMatchObject({ role: 'GUARD', oldKey: s.contracts.securityGuard });
    expect(policyFactsFrom(guard.value)).toMatchObject({
      currentGuard: s.contracts.securityGuard,
      currentModuleGuard: s.contracts.denyAllModuleGuard,
    });
    const executor = await context(
      safeTx(
        s.contracts.rotationTimelock,
        encodeFunctionData({
          abi: rotationTimelockAbi,
          functionName: 'propose',
          args: [RotationKind.Executor, wallet.executor, random()],
        }),
      ),
    );
    expect(executor.value.facts).toEqual({});
    expect(decodedView(executor.call)).toMatchObject({ role: 'S', oldKey: getAddress(wallet.executor) });
  });

  it('ROTATION_EXECUTE (swapOwner): prevOwner correcto o no y propuesta ejecutable (no la hay)', async () => {
    const owners = await env.chain.public.readContract({
      address: wallet.safe,
      abi: iSafeAbi,
      functionName: 'getOwners',
    });
    const index = owners.findIndex((o) => o.toLowerCase() === wallet.executor.toLowerCase());
    const prev = index === 0 ? '0x0000000000000000000000000000000000000001' : (owners[index - 1] ?? ZERO);
    const right = await context(
      safeTx(
        wallet.safe,
        encodeFunctionData({ abi: iSafeAbi, functionName: 'swapOwner', args: [prev, wallet.executor, random()] }),
      ),
    );
    expect(right.value.facts).toEqual({ prevOwnerCorrect: true, rotationExecutable: false });
    expect(decodedView(right.call)).toMatchObject({ oldKey: getAddress(wallet.executor) });
    const wrong = await context(
      safeTx(
        wallet.safe,
        encodeFunctionData({ abi: iSafeAbi, functionName: 'swapOwner', args: [random(), wallet.executor, random()] }),
      ),
    );
    expect(wrong.value.facts.prevOwnerCorrect).toBe(false);
    // Una clave que no es de ningún rol: no hay propuesta posible.
    const stranger = await context(
      safeTx(
        wallet.safe,
        encodeFunctionData({ abi: iSafeAbi, functionName: 'swapOwner', args: [prev, random(), random()] }),
      ),
    );
    expect(stranger.value.facts).toEqual({ prevOwnerCorrect: false, rotationExecutable: false });
  });

  it('GUARD_UPGRADE (setGuard / setModuleGuard): sucesor y propuesta madura (no los hay)', async () => {
    const next = random();
    const guard = await context(
      safeTx(wallet.safe, encodeFunctionData({ abi: iSafeAbi, functionName: 'setGuard', args: [next] })),
    );
    expect(guard.value.facts).toEqual({ successorRegistered: false, guardUpgradeMature: false });
    expect(decodedView(guard.call)).toEqual({ role: 'GUARD', newKey: next });
    const moduleGuard = await context(
      safeTx(wallet.safe, encodeFunctionData({ abi: iSafeAbi, functionName: 'setModuleGuard', args: [next] })),
    );
    expect(moduleGuard.value.facts).toEqual({ successorRegistered: false, guardUpgradeMature: false });
    expect(decodedView(moduleGuard.call)).toEqual({ role: 'MODULE_GUARD', newKey: next });
  });

  it('pre-check: el Guard informa el motivo de un rechazo y la llamada desde la Safe su revert', async () => {
    // setGuard asistido hacia una dirección cualquiera: el Guard lo rechaza (no es un upgrade autorizado).
    const { value } = await context(
      safeTx(wallet.safe, encodeFunctionData({ abi: iSafeAbi, functionName: 'setGuard', args: [random()] })),
      true,
    );
    expect(value.precheck?.guardOk).toBe(false);
    expect(decodeRevertReason(value.precheck?.guardReason ?? '0x')).toMatch(/^[A-Z][A-Za-z]+$/);
  });
});

describe('motivos de revert', () => {
  it('errores custom del Guard, Error(string) de Safe y datos desconocidos', () => {
    const custom = encodeErrorResult({ abi: securityGuardAbi, errorName: 'DestinationNotWhitelisted' });
    expect(decodeRevertReason(custom)).toBe('DestinationNotWhitelisted');
    const safeError = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['GS013'],
    });
    expect(decodeRevertReason(safeError)).toBe('GS013');
    expect(decodeRevertReason('0xdeadbeef00')).toBe('0xdeadbeef');
    expect(decodeRevertReason(null)).toBe('UNKNOWN');
    expect(decodeRevertReason('0x')).toBe('UNKNOWN');
  });
});
