// P13.TST.j: la policy del backend (P13.T10) contra los vectores compartidos de contracts/test/vectors/policy (copia
// verificada por SHA256SUMS): mismo veredicto y mismo código que exige la especificación — y que el signer obtiene con
// su implementación independiente — en cada caso.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { SafeTx } from '../../src/chain/safe-tx.ts';
import { evaluatePolicy, POLICY_REJECT_CODES, type PolicyFacts, type PolicyInput } from '../../src/policy/evaluate.ts';
import { parsePolicySnapshot, type OperationKind } from '../../src/policy/snapshot.ts';

interface RawSafeTx {
  to: string;
  value: string;
  data: string;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: string;
}

interface Vectors {
  rejectCodes: string[];
  snapshot: unknown;
  cases: {
    name: string;
    input: {
      safe: string;
      role: 'U' | 'R';
      scope: PolicyInput['scope'];
      declaredType: OperationKind;
      safeTx: RawSafeTx;
      facts: Record<string, unknown>;
    };
    expected: { verdict: 'ACCEPT' | 'REJECT'; code?: string };
  }[];
}

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../vectors/policy/policy.json'), 'utf8'),
) as Vectors;
const snapshot = parsePolicySnapshot(vectors.snapshot, `0x${'00'.repeat(32)}`);

function safeTx(raw: RawSafeTx): SafeTx {
  return {
    to: raw.to as Address,
    value: BigInt(raw.value),
    data: raw.data as Hex,
    operation: raw.operation as 0 | 1,
    safeTxGas: BigInt(raw.safeTxGas),
    baseGas: BigInt(raw.baseGas),
    gasPrice: BigInt(raw.gasPrice),
    gasToken: raw.gasToken as Address,
    refundReceiver: raw.refundReceiver as Address,
    nonce: BigInt(raw.nonce),
  };
}

function facts(raw: Record<string, unknown>): PolicyFacts {
  const paired = raw.pairedSwap as { safeTx: RawSafeTx; ownerSignatureValid: boolean } | null | undefined;
  return {
    ...(raw as unknown as PolicyFacts),
    dailyOutflowUsed: BigInt((raw.dailyOutflowUsed as string | undefined) ?? '0'),
    ...(raw.balance === undefined ? {} : { balance: BigInt(raw.balance as string) }),
    ...(raw.allowance === undefined ? {} : { allowance: BigInt(raw.allowance as string) }),
    ...(paired === undefined
      ? {}
      : {
          pairedSwap:
            paired === null ? null : { safeTx: safeTx(paired.safeTx), ownerSignatureValid: paired.ownerSignatureValid },
        }),
  };
}

describe('policy del backend contra los vectores compartidos', () => {
  it('los códigos de rechazo son los mismos', () => {
    expect([...POLICY_REJECT_CODES].sort()).toEqual([...vectors.rejectCodes].sort());
    expect(vectors.cases.length).toBeGreaterThanOrEqual(100);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const verdict = evaluatePolicy(snapshot, {
      safe: c.input.safe as Address,
      role: c.input.role,
      scope: c.input.scope,
      declaredType: c.input.declaredType,
      safeTx: safeTx(c.input.safeTx),
      facts: facts(c.input.facts),
    });
    if (c.expected.verdict === 'ACCEPT') {
      expect(verdict.verdict === 'REJECT' ? verdict.code : 'ACCEPT').toBe('ACCEPT');
    } else {
      expect(verdict).toMatchObject({ verdict: 'REJECT', code: c.expected.code });
    }
  });
});
