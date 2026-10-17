// P11.T03 [B-POL-04]: la policy propia del signer contra contracts/test/vectors/policy/policy.json (mismo veredicto que
// la del backend en cada caso, P13.TST.j). Cada caso: SafeTx + rol + scope + tipo declarado + hechos → veredicto.
import { describe, expect, it } from 'vitest';
import type { Address } from '../../src/crypto/keccak.ts';
import { evaluatePolicy, POLICY_REJECT_CODES, type PolicyFacts } from '../../src/policy/evaluate.ts';
import type { OperationType, OwnerRole, PlatformScope } from '../../src/policy/operations.ts';
import { toSafeTx, vector, vectorSnapshot, type RawSafeTx } from '../helpers/vectors.ts';

interface RawCase {
  name: string;
  input: {
    safe: Address;
    role: OwnerRole;
    scope: PlatformScope;
    declaredType: OperationType;
    safeTx: RawSafeTx;
    facts: Record<string, unknown> & { now: number; roles: PolicyFacts['roles']; dailyOutflowUsed: string };
  };
  expected: { verdict: 'ACCEPT' } | { verdict: 'REJECT'; code: string };
}
const file = vector<{ rejectCodes: string[]; cases: RawCase[] }>('policy/policy.json');
const snapshot = vectorSnapshot();

function facts(raw: RawCase['input']['facts']): PolicyFacts {
  const out: Record<string, unknown> = { ...raw, dailyOutflowUsed: BigInt(raw.dailyOutflowUsed) };
  for (const key of ['balance', 'allowance'] as const) {
    if (typeof raw[key] === 'string') out[key] = BigInt(raw[key]);
  }
  const paired = raw.pairedSwap as { safeTx: RawSafeTx; ownerSignatureValid: boolean } | null | undefined;
  if (paired !== undefined) {
    out.pairedSwap =
      paired === null ? null : { safeTx: toSafeTx(paired.safeTx), ownerSignatureValid: paired.ownerSignatureValid };
  }
  return out as unknown as PolicyFacts;
}

describe('policy del signer contra los vectores compartidos', () => {
  it('los códigos de rechazo de los vectores existen en la implementación', () => {
    for (const code of file.rejectCodes) expect(POLICY_REJECT_CODES).toContain(code);
  });

  it.each(file.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const verdict = evaluatePolicy(snapshot, {
      safe: c.input.safe,
      role: c.input.role,
      scope: c.input.scope,
      declaredType: c.input.declaredType,
      safeTx: toSafeTx(c.input.safeTx),
      facts: facts(c.input.facts),
    });
    if (c.expected.verdict === 'ACCEPT') expect(verdict).toMatchObject({ verdict: 'ACCEPT' });
    else expect(verdict).toMatchObject({ verdict: 'REJECT', code: c.expected.code });
  });
});
