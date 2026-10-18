// P15.T08 [C-GRD-17]: Guards y module guards sucesores fijados en el snapshot de policy. Sin sucesores (el formato de
// siempre) el snapshot sigue siendo válido; con ellos, el RotationTimelock de un Guard sucesor recibe propuestas y
// cancelaciones retransmitidas, la policy exige que la propuesta vaya al timelock del Guard que gobierna la Safe, una
// Safe con un sucesor instalado no es una configuración modificada y los sucesores nunca son destino de fondos.
import { describe, expect, it } from 'vitest';
import { encodeCall, encodeDynamicBytes, SELECTORS, wordAddress, wordUint } from '../../src/chain/abi.ts';
import { safeConfigProblems, type SafeState } from '../../src/chain/reader.ts';
import type { SafeTx } from '../../src/chain/safe-tx.ts';
import type { Hex } from '../../src/crypto/bytes.ts';
import type { Address } from '../../src/crypto/keccak.ts';
import { evaluatePolicy, type PolicyFacts } from '../../src/policy/evaluate.ts';
import { PolicySnapshotSchema, type PolicySnapshot } from '../../src/policy/snapshot.ts';
import {
  acceptedTimelocks,
  checkPlatformTxStatic,
  checkSafeTxStatic,
  StaticRuleViolation,
  systemAddresses,
} from '../../src/policy/static-rules.ts';
import { testSnapshot } from '../helpers/policy.ts';
import { vector } from '../helpers/vectors.ts';

const raw = vector<{ snapshot: Record<string, unknown> }>('policy/policy.json').snapshot;
const system = vector<{ safe: Address; contracts: Record<string, Address> }>('system.json');
const SAFE = system.safe;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const GUARD_V2 = '0x2222222222222222222222222222222222222222' as Address;
const TIMELOCK_V2 = '0x3333333333333333333333333333333333333333' as Address;
const MODULE_GUARD_V2 = '0x4444444444444444444444444444444444444444' as Address;

const plain = PolicySnapshotSchema.parse(raw);
const withSuccessors: PolicySnapshot = PolicySnapshotSchema.parse({
  ...raw,
  successors: { guards: [{ guard: GUARD_V2, rotationTimelock: TIMELOCK_V2 }], moduleGuards: [MODULE_GUARD_V2] },
});

function tx(to: Address, data: Hex): SafeTx {
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

const propose = (timelock: Address, kind: number, oldValue: Address, newValue: Address) =>
  tx(timelock, encodeCall(SELECTORS.propose, wordUint(BigInt(kind)), wordAddress(oldValue), wordAddress(newValue)));

const cancelRelay = (to: Address) => ({
  chainId: 8453,
  purpose: 'CANCEL_RELAY' as const,
  to,
  value: 0n,
  data: encodeCall(
    SELECTORS.cancelWithSignature,
    wordUint(0xabn),
    wordUint(0x40n),
    encodeDynamicBytes(new Uint8Array(65).fill(7)),
  ),
  maxFeePerGas: 1_000_000n,
  maxPriorityFeePerGas: 1_000n,
  gasLimit: 200_000n,
});

describe('snapshot con sucesores', () => {
  it('sin el campo, ningún sucesor; con él, direcciones normalizadas y sin claves extra', () => {
    expect(plain.successors).toEqual({ guards: [], moduleGuards: [] });
    expect(withSuccessors.successors.guards).toEqual([
      { guard: GUARD_V2.toLowerCase(), rotationTimelock: TIMELOCK_V2.toLowerCase() },
    ]);
    expect(() =>
      PolicySnapshotSchema.parse({ ...raw, successors: { guards: [], moduleGuards: [], extra: true } }),
    ).toThrow();
    expect(() =>
      PolicySnapshotSchema.parse({
        ...raw,
        successors: { guards: [{ guard: 'no', rotationTimelock: TIMELOCK_V2 }], moduleGuards: [] },
      }),
    ).toThrow();
  });
});

describe('policy:build con sucesores', () => {
  it('los incluye normalizados (EIP-55) y el schema del signer los acepta; sin sucesores el snapshot no cambia', () => {
    const built = testSnapshot(2, {
      successors: { guards: [{ guard: GUARD_V2, rotationTimelock: TIMELOCK_V2 }], moduleGuards: [MODULE_GUARD_V2] },
    });
    expect(built.successors).toEqual({
      guards: [{ guard: GUARD_V2, rotationTimelock: TIMELOCK_V2 }],
      moduleGuards: [MODULE_GUARD_V2],
    });
    expect(PolicySnapshotSchema.parse(built).successors.guards).toHaveLength(1);
    expect('successors' in testSnapshot(2, { successors: { guards: [], moduleGuards: [] } })).toBe(false);
    expect('successors' in testSnapshot(2)).toBe(false);
  });
});

describe('reglas estáticas con sucesores', () => {
  it('propose al timelock del sucesor es ROTATION_PROPOSE (con su timelock); a otro contrato, SR-06', () => {
    const op = checkSafeTxStatic(withSuccessors, {
      chainId: 8453,
      safe: SAFE,
      safeTx: propose(TIMELOCK_V2, 2, system.contracts.securityGuard!, MODULE_GUARD_V2),
      operationType: 'ROTATION_PROPOSE',
    });
    expect(op).toMatchObject({ type: 'ROTATION_PROPOSE', timelock: TIMELOCK_V2 });
    // El mismo timelock sin sucesores en el snapshot no está en la allowlist.
    let rule: string | null = null;
    try {
      checkSafeTxStatic(plain, {
        chainId: 8453,
        safe: SAFE,
        safeTx: propose(TIMELOCK_V2, 2, system.contracts.securityGuard!, MODULE_GUARD_V2),
        operationType: 'ROTATION_PROPOSE',
      });
    } catch (error) {
      if (error instanceof StaticRuleViolation) rule = error.rule;
    }
    expect(rule).toBe('SR-06');
  });

  it('la cancelación retransmitida va a un timelock aceptado (GT-04)', () => {
    expect(acceptedTimelocks(withSuccessors).map((t) => t.toLowerCase())).toContain(TIMELOCK_V2.toLowerCase());
    expect(checkPlatformTxStatic(withSuccessors, cancelRelay(TIMELOCK_V2))).toMatchObject({ purpose: 'CANCEL_RELAY' });
    expect(() => checkPlatformTxStatic(plain, cancelRelay(TIMELOCK_V2))).toThrow(StaticRuleViolation);
  });

  it('los sucesores son contratos del sistema: nunca destino ni Safe', () => {
    const lower = systemAddresses(withSuccessors).map((a) => a.toLowerCase());
    for (const address of [GUARD_V2, TIMELOCK_V2, MODULE_GUARD_V2]) expect(lower).toContain(address.toLowerCase());
  });
});

describe('policy: el timelock de la Safe', () => {
  const facts = (safeTimelock?: Address): PolicyFacts => ({
    now: 1_700_000_000,
    roles: {
      userKey: '0x1000000000000000000000000000000000000001',
      recoveryKey: '0x1000000000000000000000000000000000000002',
      executor: '0x1000000000000000000000000000000000000003',
    },
    dailyOutflowUsed: 0n,
    newKeyIsSignerKey: true,
    ...(safeTimelock === undefined ? {} : { safeTimelock }),
  });
  const input = (timelock: Address, safeTimelock?: Address) => ({
    safe: SAFE,
    role: 'U' as const,
    scope: 'OPERATIONS' as const,
    declaredType: 'ROTATION_PROPOSE' as const,
    safeTx: propose(
      timelock,
      2,
      '0x1000000000000000000000000000000000000003',
      '0x1000000000000000000000000000000000000009',
    ),
    facts: facts(safeTimelock),
  });

  it('acepta la propuesta al timelock del Guard que gobierna la Safe y rechaza la de otro timelock aceptado', () => {
    expect(evaluatePolicy(withSuccessors, input(TIMELOCK_V2, TIMELOCK_V2))).toMatchObject({ verdict: 'ACCEPT' });
    expect(evaluatePolicy(withSuccessors, input(TIMELOCK_V2, system.contracts.rotationTimelock))).toMatchObject({
      verdict: 'REJECT',
      code: 'ROTATION_INVALID',
      detail: 'timelock',
    });
    // Sin el dato, el del sistema.
    expect(evaluatePolicy(withSuccessors, input(system.contracts.rotationTimelock!))).toMatchObject({
      verdict: 'ACCEPT',
    });
    expect(evaluatePolicy(withSuccessors, input(TIMELOCK_V2))).toMatchObject({ verdict: 'REJECT' });
  });
});

describe('deriva de configuración con sucesores', () => {
  const state = (guard: Address, moduleGuard: Address): SafeState => ({
    block: 1n,
    timestamp: 1,
    registered: true,
    isWallet: true,
    roles: {
      userKey: '0x1000000000000000000000000000000000000001',
      recoveryKey: '0x1000000000000000000000000000000000000002',
      executor: '0x1000000000000000000000000000000000000003',
      initialized: true,
    },
    nonce: 1n,
    threshold: 2n,
    owners: [
      '0x1000000000000000000000000000000000000001',
      '0x1000000000000000000000000000000000000002',
      '0x1000000000000000000000000000000000000003',
    ] as Address[],
    guard,
    moduleGuard,
    fallbackHandler: ZERO,
    modules: [],
    governingGuard: guard,
    timelock: TIMELOCK_V2,
  });

  it('el Guard y el module guard sucesores del snapshot no son deriva; uno ajeno sí', () => {
    expect(safeConfigProblems(state(GUARD_V2, MODULE_GUARD_V2), withSuccessors)).toEqual([]);
    expect(safeConfigProblems(state(GUARD_V2, MODULE_GUARD_V2), plain)).toEqual(['guard', 'moduleGuard']);
    expect(
      safeConfigProblems(state('0x5555555555555555555555555555555555555555', MODULE_GUARD_V2), withSuccessors),
    ).toEqual(['guard']);
  });
});
