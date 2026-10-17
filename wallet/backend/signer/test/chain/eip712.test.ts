// Digests EIP-712 de la plataforma [W-01] contra los vectores: KeyAcceptance (dominio "MTW Wallet") y CancelRotation
// (dominio "MTW RotationTimelock"), con las firmas de los vectores recuperadas a sus firmantes.
import { describe, expect, it } from 'vitest';
import { bytesToHex, type Hex } from '../../src/crypto/bytes.ts';
import type { Address } from '../../src/crypto/keccak.ts';
import { recoverStrict } from '../../src/crypto/secp256k1.ts';
import { cancelRotationDigest, KEY_ACCEPTANCE_TYPEHASH, keyAcceptanceDigest } from '../../src/chain/eip712.ts';
import { vector } from '../helpers/vectors.ts';

interface Eip712Vectors {
  domain: { chainId: number; verifyingContract: Address };
  types: {
    primaryType: string;
    typehash: string;
    digest: string;
    signer: string;
    signature: string;
    message: Record<string, unknown>;
  }[];
}
interface CancelVectors {
  domain: { chainId: number; verifyingContract: Address };
  primaryType: string;
  message: { proposalId: Hex; safe: Address };
  digest: string;
  signatureUser: string;
  signatureRecovery: string;
}
const eip712 = vector<Eip712Vectors>('wire/eip712.json');
const cancel = vector<CancelVectors>('cancel-rotation.json');
const system = vector<{ keys: Record<'user' | 'recovery', { address: string }> }>('system.json');

describe('EIP-712 de la plataforma', () => {
  it('KeyAcceptance: typehash, digest y firma de la nueva clave', () => {
    const ka = eip712.types.find((t) => t.primaryType === 'KeyAcceptance')!;
    expect(KEY_ACCEPTANCE_TYPEHASH).toBe(ka.typehash);
    const m = ka.message as { walletId: string; role: number; newKey: Address; nonce: Hex };
    const digest = keyAcceptanceDigest(eip712.domain.chainId, eip712.domain.verifyingContract, m);
    expect(bytesToHex(digest)).toBe(ka.digest);
    expect(recoverStrict(digest, ka.signature)).toBe(ka.signer);
    expect(ka.signer).toBe(m.newKey);
  });

  it('CancelRotation: digest y firmas de U y R', () => {
    expect(cancel.primaryType).toBe('CancelRotation(bytes32 proposalId,address safe)');
    const digest = cancelRotationDigest(
      cancel.domain.chainId,
      cancel.domain.verifyingContract,
      cancel.message.proposalId,
      cancel.message.safe,
    );
    expect(bytesToHex(digest)).toBe(cancel.digest);
    expect(recoverStrict(digest, cancel.signatureUser)).toBe(system.keys.user.address);
    expect(recoverStrict(digest, cancel.signatureRecovery)).toBe(system.keys.recovery.address);
  });
});
