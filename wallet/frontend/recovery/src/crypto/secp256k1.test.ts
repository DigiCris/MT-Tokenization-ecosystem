// P19.T02 [F-KEY-01]: R en secp256k1 contra los vectores copiados de contracts/ (misma clave de etiqueta, misma
// dirección, misma firma determinística RFC 6979 que firmó el vector de la prueba de control).
import { hashTypedData, keccak256, recoverAddress, toBytes, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import eip712Vectors from '../../test/vectors/wire/eip712.json' with { type: 'json' };
import { hexToBytes } from './encoding.ts';
import { addressOfKey, isValidPrivateKey, KeyError, newPrivateKey, signDigest } from './secp256k1.ts';
import { RECOVERY_PROOF_TYPES } from './typed-data.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));
const R_ADDRESS: Address = '0x7184D30100a188c9F869ccB6883392534ecD6C9d';

function scalar(value: bigint): Uint8Array {
  return hexToBytes(`0x${value.toString(16).padStart(64, '0')}`, 32);
}

describe('clave R', () => {
  it('la clave de la etiqueta del vector deriva la dirección R del vector', () => {
    expect(addressOfKey(R_KEY)).toBe(R_ADDRESS);
  });

  it('escalares fuera de [1, n) se descartan y se borran hasta obtener uno válido', () => {
    const zero = new Uint8Array(32);
    const order = scalar(N);
    const candidates = [zero, order, scalar(N - 1n)];
    const key = newPrivateKey(() => candidates.shift() ?? new Uint8Array(32));
    expect(key).toEqual(scalar(N - 1n));
    expect(order).toEqual(new Uint8Array(32));
    expect(isValidPrivateKey(scalar(1n))).toBe(true);
    expect(isValidPrivateKey(new Uint8Array(31))).toBe(false);
    expect(() => addressOfKey(zero)).toThrow(KeyError);
  });

  it('claves nuevas del CSPRNG: válidas y distintas', () => {
    const a = newPrivateKey();
    const b = newPrivateKey();
    expect(isValidPrivateKey(a)).toBe(true);
    expect(a).not.toEqual(b);
  });
});

describe('firma de digests', () => {
  const proof = eip712Vectors.types.find((t) => t.primaryType === 'RecoveryProofOfControl');

  it('la prueba de control del vector: mismo digest y la misma firma (RFC 6979) que recupera R', async () => {
    expect(proof).toBeDefined();
    if (!proof) return;
    const digest = hashTypedData({
      domain: { ...eip712Vectors.domain, verifyingContract: eip712Vectors.domain.verifyingContract as Address },
      types: RECOVERY_PROOF_TYPES,
      primaryType: 'RecoveryProofOfControl',
      message: { ...proof.message, recoveryKey: proof.message.recoveryKey as Address } as {
        userId: string;
        platformId: string;
        enrollmentId: string;
        recoveryKey: Address;
      },
    });
    expect(digest).toBe(proof.digest);
    const signature = signDigest(digest, R_KEY);
    expect(signature).toBe(proof.signature);
    expect(await recoverAddress({ hash: digest, signature })).toBe(R_ADDRESS);
  });

  it('formato estricto: 65 bytes, s en la mitad baja y v ∈ {27, 28}', async () => {
    for (let i = 0; i < 16; i++) {
      const digest = keccak256(toBytes(`digest ${String(i)}`));
      const signature = signDigest(hexToBytes(digest), R_KEY);
      const bytes = hexToBytes(signature, 65);
      const s = BigInt(`0x${signature.slice(66, 130)}`);
      expect(s <= N / 2n).toBe(true);
      expect([27, 28]).toContain(bytes[64]);
      expect(await recoverAddress({ hash: digest, signature })).toBe(R_ADDRESS);
    }
  });

  it('rechaza digests que no son de 32 bytes y claves inválidas', () => {
    expect(() => signDigest('0x1234', R_KEY)).toThrow('32 bytes');
    expect(() => signDigest(new Uint8Array(31), R_KEY)).toThrow('32 bytes');
    expect(() => signDigest(keccak256('0x00'), new Uint8Array(32))).toThrow(KeyError);
  });
});
