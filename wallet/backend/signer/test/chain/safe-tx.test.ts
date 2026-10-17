// SafeTx de Safe 1.5.0 [W-01]: typehashes, separador de dominio y safeTxHash de cada operación de
// contracts/test/vectors/safe-tx.json (generados por la Safe real del fork), y recuperación estricta de las firmas.
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../../src/crypto/bytes.ts';
import { recoverStrict, StrictSignatureError } from '../../src/crypto/secp256k1.ts';
import { DOMAIN_TYPEHASH, SAFE_TX_TYPEHASH, safeDomainSeparator, safeTxHash } from '../../src/chain/safe-tx.ts';
import type { Address } from '../../src/crypto/keccak.ts';
import { toSafeTx, vector, type RawSafeTx } from '../helpers/vectors.ts';

interface SafeTxVectors {
  safe: Address;
  chainId: number;
  domainTypehash: string;
  safeTxTypehash: string;
  domainSeparator: string;
  operations: (RawSafeTx & {
    opType: string;
    safeTxHash: string;
    signatureUser: string;
    signatureExecutor: string;
    signatureRecovery: string;
  })[];
}
const v = vector<SafeTxVectors>('safe-tx.json');
const system = vector<{ keys: Record<'user' | 'recovery' | 'executor', { address: string }> }>('system.json');

describe('SafeTx (vectores de la Safe real)', () => {
  it('typehashes y separador de dominio', () => {
    expect(DOMAIN_TYPEHASH).toBe(v.domainTypehash);
    expect(SAFE_TX_TYPEHASH).toBe(v.safeTxTypehash);
    expect(bytesToHex(safeDomainSeparator(v.chainId, v.safe))).toBe(v.domainSeparator);
  });

  it.each(v.operations.map((o) => [o.opType, o] as const))('safeTxHash y firmas de %s', (_name, op) => {
    const hash = safeTxHash(v.chainId, v.safe, toSafeTx(op));
    expect(bytesToHex(hash)).toBe(op.safeTxHash);
    expect(recoverStrict(hash, op.signatureUser)).toBe(system.keys.user.address);
    expect(recoverStrict(hash, op.signatureExecutor)).toBe(system.keys.executor.address);
    expect(recoverStrict(hash, op.signatureRecovery)).toBe(system.keys.recovery.address);
  });

  it('la recuperación estricta rechaza longitud, v, high-s y formatos de Safe que no son ECDSA', () => {
    const op = v.operations[0]!;
    const hash = hexToBytes(op.safeTxHash);
    const sig = op.signatureUser;
    const problem = (signature: string) => {
      try {
        recoverStrict(hash, signature);
        return 'OK';
      } catch (error) {
        return error instanceof StrictSignatureError ? error.problem : 'OTRO';
      }
    };
    expect(problem(sig.slice(0, -2))).toBe('LENGTH');
    expect(problem(`${sig}00`)).toBe('LENGTH');
    // v = 0/1 (firma de contrato o approved hash de Safe) y v > 30 (eth_sign) no son ECDSA estricta.
    for (const v2 of ['00', '01', '1f', '20']) expect(problem(`${sig.slice(0, -2)}${v2}`)).toBe('V');
    // s alto (maleable): s' = n − s con v invertido recupera la misma dirección en ecrecover, acá se rechaza.
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const flippedV = sig.slice(130) === '1b' ? '1c' : '1b';
    expect(problem(`${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${flippedV}`)).toBe('HIGH_S');
    expect(problem(`0x${'00'.repeat(32)}${sig.slice(66)}`)).toBe('RANGE');
  });
});
