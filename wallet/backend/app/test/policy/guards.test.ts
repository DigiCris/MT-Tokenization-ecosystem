// P15.T08 [C-GRD-17]: Guards sucesores fijados en el snapshot de policy del backend. Sin el campo el snapshot es el de
// siempre; con él, el timelock del sucesor se decodifica como destino de propose/cancel, la policy exige el timelock del
// Guard que gobierna la Safe, una Safe con el Guard o el module guard sucesor no tiene deriva de configuración y los
// sucesores nunca son destino de fondos ni clave de una rotación.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, getAddress, type Address } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { rotationTimelockAbi } from '../../src/chain/abis/index.ts';
import { RotationKind } from '../../src/chain/constants.ts';
import { safeConfigDrift, type SafeChainState } from '../../src/chain/safe-state.ts';
import type { SafeTx } from '../../src/chain/safe-tx.ts';
import { decodeOperation, evaluatePolicy, type PolicyFacts } from '../../src/policy/evaluate.ts';
import {
  guardInfo,
  guardOfTimelock,
  guardsOf,
  isAcceptedModuleGuard,
  successorAddresses,
  timelocksOf,
} from '../../src/policy/guards.ts';
import { loadPolicySnapshot } from '../../src/policy/snapshot.ts';
import { edKey, vectorSystem, writePolicySnapshot } from '../helpers/signer-shard.ts';

const GUARD_V2 = getAddress('0x2222222222222222222222222222222222222222');
const TIMELOCK_V2 = getAddress('0x3333333333333333333333333333333333333333');
const MODULE_GUARD_V2 = getAddress('0x4444444444444444444444444444444444444444');
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const SAFE = getAddress('0x5555555555555555555555555555555555555555');
const ROLES = {
  userKey: getAddress('0x1000000000000000000000000000000000000001'),
  recoveryKey: getAddress('0x1000000000000000000000000000000000000002'),
  executor: getAddress('0x1000000000000000000000000000000000000003'),
};

const dir = mkdtempSync(join(tmpdir(), 'mtw-guards-'));
const key = edKey();
const plain = loadPolicySnapshot(
  writePolicySnapshot(mkdtempSync(join(dir, 'p-')), key, vectorSystem()),
  key.publicKey,
  'local',
);
const withSuccessors = loadPolicySnapshot(
  writePolicySnapshot(mkdtempSync(join(dir, 's-')), key, vectorSystem(), 2, {
    guards: [{ guard: GUARD_V2, rotationTimelock: TIMELOCK_V2 }],
    moduleGuards: [MODULE_GUARD_V2],
  }),
  key.publicKey,
  'local',
);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tx(to: Address, data: `0x${string}`): SafeTx {
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
    nonce: 1n,
  };
}

const proposeTx = (timelock: Address) =>
  tx(
    timelock,
    encodeFunctionData({
      abi: rotationTimelockAbi,
      functionName: 'propose',
      args: [RotationKind.Executor, ROLES.executor, getAddress('0x1000000000000000000000000000000000000009')],
    }),
  );

describe('snapshot y Guards aceptados', () => {
  it('sin sucesores sólo el Guard del sistema; con sucesores, cada Guard con su timelock', () => {
    expect(plain.successors).toEqual({ guards: [], moduleGuards: [] });
    expect(guardsOf(plain)).toHaveLength(1);
    expect(guardsOf(withSuccessors).map((g) => g.guard)).toEqual([withSuccessors.contracts.securityGuard, GUARD_V2]);
    expect(guardInfo(withSuccessors, GUARD_V2)).toEqual({ guard: GUARD_V2, rotationTimelock: TIMELOCK_V2 });
    expect(guardInfo(plain, GUARD_V2)).toBeNull();
    expect(guardOfTimelock(withSuccessors, TIMELOCK_V2)?.guard).toBe(GUARD_V2);
    expect(timelocksOf(withSuccessors)).toEqual([withSuccessors.contracts.rotationTimelock, TIMELOCK_V2]);
    expect(isAcceptedModuleGuard(withSuccessors, MODULE_GUARD_V2)).toBe(true);
    expect(isAcceptedModuleGuard(plain, MODULE_GUARD_V2)).toBe(false);
    expect(successorAddresses(withSuccessors)).toEqual([GUARD_V2, TIMELOCK_V2, MODULE_GUARD_V2]);
  });
});

describe('decodificación y policy de la propuesta', () => {
  it('propose al timelock del sucesor se decodifica con su timelock sólo si el snapshot lo fija', () => {
    expect(decodeOperation(withSuccessors, SAFE, proposeTx(TIMELOCK_V2))).toMatchObject({
      kind: 'ROTATION_PROPOSE',
      timelock: TIMELOCK_V2,
    });
    expect(decodeOperation(plain, SAFE, proposeTx(TIMELOCK_V2))).toBeNull();
  });

  it('exige el timelock del Guard que gobierna la Safe (sin el dato, el del sistema)', () => {
    const facts = (safeTimelock?: Address): PolicyFacts => ({
      now: 1,
      roles: ROLES,
      dailyOutflowUsed: 0n,
      newKeyIsSignerKey: true,
      ...(safeTimelock === undefined ? {} : { safeTimelock }),
    });
    const input = (timelock: Address, safeTimelock?: Address) => ({
      safe: SAFE,
      role: 'U' as const,
      scope: 'OPERATIONS' as const,
      declaredType: 'ROTATION_PROPOSE' as const,
      safeTx: proposeTx(timelock),
      facts: facts(safeTimelock),
    });
    expect(evaluatePolicy(withSuccessors, input(TIMELOCK_V2, TIMELOCK_V2))).toMatchObject({ verdict: 'ACCEPT' });
    expect(evaluatePolicy(withSuccessors, input(TIMELOCK_V2, withSuccessors.contracts.rotationTimelock))).toMatchObject(
      { verdict: 'REJECT', code: 'ROTATION_INVALID', detail: 'timelock' },
    );
    expect(evaluatePolicy(withSuccessors, input(withSuccessors.contracts.rotationTimelock))).toMatchObject({
      verdict: 'ACCEPT',
    });
    // Un sucesor nunca es la clave nueva de una rotación.
    const toSuccessor = tx(
      withSuccessors.contracts.rotationTimelock,
      encodeFunctionData({
        abi: rotationTimelockAbi,
        functionName: 'propose',
        args: [RotationKind.Executor, ROLES.executor, GUARD_V2],
      }),
    );
    expect(
      evaluatePolicy(withSuccessors, { ...input(withSuccessors.contracts.rotationTimelock), safeTx: toSuccessor }),
    ).toMatchObject({ verdict: 'REJECT', code: 'ROTATION_INVALID' });
  });
});

describe('deriva de configuración', () => {
  const state = (guard: Address, moduleGuard: Address): SafeChainState => ({
    blockNumber: '1',
    timestamp: 1,
    registered: true,
    isWallet: true,
    roles: { ...ROLES, initialized: true },
    nonce: '1',
    threshold: '2',
    owners: [ROLES.userKey, ROLES.recoveryKey, ROLES.executor],
    singleton: withSuccessors.contracts.safeL2Singleton,
    guard,
    moduleGuard,
    fallbackHandler: ZERO,
    modules: [],
    governingGuard: guard,
    timelock: TIMELOCK_V2,
  });

  it('el Guard y el module guard sucesores fijados no son deriva; sin el snapshot nuevo, sí', () => {
    expect(safeConfigDrift(state(GUARD_V2, MODULE_GUARD_V2), withSuccessors)).toEqual([]);
    expect(safeConfigDrift(state(GUARD_V2, MODULE_GUARD_V2), plain)).toEqual(['GUARD', 'MODULE_GUARD']);
    expect(safeConfigDrift(state(SAFE, withSuccessors.contracts.denyAllModuleGuard), withSuccessors)).toEqual([
      'GUARD',
    ]);
  });
});
