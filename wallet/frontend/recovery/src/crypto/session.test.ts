// P19.T02 [F-KEY-05]: R se descifra sólo para firmar y sus bytes quedan en cero después, aunque la firma falle; los typed
// data de Recovery dan los digests de los vectores (prueba de control, KeyAcceptance y cancelación de rotación).
import { hashTypedData, keccak256, recoverAddress, toBytes, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import cancelVector from '../../test/vectors/cancel-rotation.json' with { type: 'json' };
import eip712Vectors from '../../test/vectors/wire/eip712.json' with { type: 'json' };
import { toBufferSource } from './encoding.ts';
import { sealRecoveryKey } from './envelope.ts';
import type { Argon2 } from './kdf.ts';
import { newPrivateKey, signDigest } from './secp256k1.ts';
import { recoveryAddress, signDigestWithRecovery, signTypedDataWithRecovery, withRecoveryKey } from './session.ts';
import {
  cancelRotation,
  KEY_ACCEPTANCE_TYPES,
  keyAcceptance,
  recoveryProofOfControl,
  ROLE,
  typedDataDigest,
} from './typed-data.ts';

const fastArgon2: Argon2 = async ({ password, salt }) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(new Uint8Array([...password, ...salt]))));
const context = { platformId: 'mtw', walletId: '7d2e3f40-1a2b-4c5d-8e9f-a0b1c2d3e4f5', keyVersion: 1 };

describe('R desbloqueada', () => {
  it('descifra R sólo durante el uso y la deja en cero, también si el uso falla', async () => {
    const key = newPrivateKey();
    const unlocked = await sealRecoveryKey(key, 'pw', context, fastArgon2);
    let seen: Uint8Array | null = null;
    await withRecoveryKey(unlocked, (k) => {
      expect(k).toEqual(key);
      seen = k;
    });
    expect(seen).toEqual(new Uint8Array(32));
    let failed: Uint8Array | null = null;
    await expect(
      withRecoveryKey(unlocked, (k) => {
        failed = k;
        throw new Error('falla la firma');
      }),
    ).rejects.toThrow('falla la firma');
    expect(failed).toEqual(new Uint8Array(32));
  });

  it('firma digests y typed data que recuperan la dirección de R', async () => {
    const unlocked = await sealRecoveryKey(newPrivateKey(), 'pw', context, fastArgon2);
    const digest = '0x8d2b1c8a3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' as Hex;
    expect(await recoverAddress({ hash: digest, signature: await signDigestWithRecovery(unlocked, digest) })).toBe(
      recoveryAddress(unlocked),
    );
    const proof = recoveryProofOfControl('0x1d1499e622D69689cdf9004d05Ec547d650Ff211', {
      userId: '4f1c2d9e-6b7a-4c3d-9e8f-0a1b2c3d4e5f',
      platformId: 'mtw',
      enrollmentId: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
      recoveryKey: recoveryAddress(unlocked),
    });
    const signature = await signTypedDataWithRecovery(unlocked, proof);
    expect(await recoverAddress({ hash: hashTypedData(proof), signature })).toBe(recoveryAddress(unlocked));
  });
});

describe('typed data de Recovery contra los vectores', () => {
  const factory = eip712Vectors.domain.verifyingContract as Address;

  it('RecoveryProofOfControl y KeyAcceptance: mismos digests que contracts/', () => {
    const proof = eip712Vectors.types.find((t) => t.primaryType === 'RecoveryProofOfControl');
    const acceptance = eip712Vectors.types.find((t) => t.primaryType === 'KeyAcceptance');
    if (!proof || !acceptance) throw new Error('faltan vectores EIP-712');
    const message = proof.message as { userId: string; platformId: string; enrollmentId: string; recoveryKey: Address };
    expect(typedDataDigest(recoveryProofOfControl(factory, message))).toBe(proof.digest);
    // El vector de KeyAcceptance es de U′ (rol 1); el de Recovery firma R′ (rol 2) con la misma estructura.
    const accepted = acceptance.message as { walletId: string; role: number; newKey: Address; nonce: Hex };
    expect(
      hashTypedData({
        domain: { ...eip712Vectors.domain, verifyingContract: factory },
        types: KEY_ACCEPTANCE_TYPES,
        primaryType: 'KeyAcceptance',
        message: accepted,
      }),
    ).toBe(acceptance.digest);
    expect(keyAcceptance(factory, accepted).message.role).toBe(ROLE.R);
  });

  it('CancelRotation con el dominio del RotationTimelock; la firma de R es la del vector', () => {
    const v = cancelVector as unknown as {
      domain: { verifyingContract: Address };
      message: { proposalId: Hex; safe: Address };
      digest: Hex;
      signatureRecovery: Hex;
    };
    const digest = typedDataDigest(cancelRotation(v.domain.verifyingContract, v.message));
    expect(digest).toBe(v.digest);
    expect(signDigest(digest, toBytes(keccak256(toBytes('mtw-recovery-key'))))).toBe(v.signatureRecovery);
  });
});
