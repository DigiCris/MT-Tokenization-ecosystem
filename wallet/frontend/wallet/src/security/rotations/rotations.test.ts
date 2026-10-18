// P18.T09: la cancelación EIP-712 que firma U reproduce el vector de contracts/ (cancel-rotation.json: dominio del
// timelock fijado, digest y firma de U); las SafeTx de propuesta, ejecución (swapOwner con el owner anterior de la lista
// on-chain) y upgrade del Guard son las del vector; las pendientes se leen de la cadena para los cinco tipos.
import { hashTypedData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import cancelVector from '../../../test/vectors/cancel-rotation.json';
import safeTxVectors from '../../../test/vectors/safe-tx.json';
import systemVector from '../../../test/vectors/system.json';
import type { CancelRotationTypedData } from '../../api/wallet-api.ts';
import { safeTxHash } from '../../chain/safe-tx.ts';
import { toBase64Url } from '../../crypto/bytes.ts';
import { sealKey } from '../../crypto/envelope.ts';
import { defaultKdfParams } from '../../crypto/kdf.ts';
import { addressOf } from '../../crypto/keys.ts';
import {
  assertCancelTypedData,
  cancelRotationTypedData,
  executeCall,
  previousOwner,
  proposeCall,
  readPendingProposals,
  RotationCheckError,
  SENTINEL_OWNER,
  signCancellation,
} from './rotations.ts';

const cancel = cancelVector as unknown as {
  domain: { verifyingContract: Address };
  message: { proposalId: Hex; safe: Address };
  proposal: { kind: number; oldValue: Address; newValue: Address; createdAt: number; executableAt: number };
  digest: Hex;
  signatureUser: Hex;
};
const vectors = safeTxVectors as unknown as {
  safe: Address;
  operations: { opType: string; to: Address; data: Hex; nonce: number; safeTxHash: Hex }[];
};
const system = systemVector as unknown as {
  keys: Record<'user' | 'recovery' | 'executor', { label: string; address: Address }>;
  contracts: Record<string, Address>;
};
const op = (type: string) => {
  const found = vectors.operations.find((o) => o.opType === type);
  if (!found) throw new Error(type);
  return found;
};

describe('cancelación de una rotación', () => {
  it('typed data propio = vector (digest) y U firma igual que en el vector', async () => {
    const typed = cancelRotationTypedData(
      cancel.domain.verifyingContract,
      cancel.message.proposalId,
      cancel.message.safe,
    );
    expect(hashTypedData(typed)).toBe(cancel.digest);
    const key = toBytes(keccak256(toBytes(system.keys.user.label)));
    const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const envelope = await sealKey(
      key.slice(),
      encryptionKey,
      { platformId: 'p', chainId: 8453, walletId: 'w', role: 'U', keyAddress: addressOf(key), keyVersion: 1 },
      defaultKdfParams(toBase64Url(new Uint8Array(16))),
    );
    expect(await signCancellation({ envelope, encryptionKey }, typed)).toBe(cancel.signatureUser);
  });

  it('el typed data del backend tiene que ser el de esta propuesta', () => {
    const own = cancelRotationTypedData(
      cancel.domain.verifyingContract,
      cancel.message.proposalId,
      cancel.message.safe,
    );
    const remote = (
      patch: Partial<CancelRotationTypedData['domain']> = {},
      message: Partial<CancelRotationTypedData['message']> = {},
    ) =>
      ({
        domain: { ...own.domain, ...patch },
        types: {},
        primaryType: 'CancelRotation',
        message: { ...own.message, ...message },
      }) as CancelRotationTypedData;
    expect(() => {
      assertCancelTypedData(null, own);
      assertCancelTypedData(remote(), own);
    }).not.toThrow();
    expect(() => {
      assertCancelTypedData(remote({ verifyingContract: system.keys.user.address }), own);
    }).toThrow(RotationCheckError);
    expect(() => {
      assertCancelTypedData(remote({}, { proposalId: `0x${'00'.repeat(32)}` }), own);
    }).toThrow(RotationCheckError);
    expect(() => {
      assertCancelTypedData(remote({ chainId: 1 }), own);
    }).toThrow(RotationCheckError);
  });
});

describe('propuesta y ejecución', () => {
  const timelock = system.contracts.rotationTimelock ?? '0x';
  const owners = [system.keys.user.address, system.keys.recovery.address, system.keys.executor.address];

  it('propuesta de rotación de S: la SafeTx del vector', () => {
    const vector = op('ROTATION_PROPOSE');
    const tx = proposeCall(timelock, 'S', cancel.proposal.oldValue, cancel.proposal.newValue, BigInt(vector.nonce));
    expect(tx.data).toBe(vector.data);
    expect(safeTxHash(8453, vectors.safe, tx)).toBe(vector.safeTxHash);
  });

  it('ejecución: swapOwner con el owner anterior de la lista y upgrade del Guard', () => {
    expect(previousOwner(owners, system.keys.user.address)).toBe(SENTINEL_OWNER);
    expect(previousOwner(owners, system.keys.executor.address)).toBe(system.keys.recovery.address);
    expect(() => previousOwner(owners, cancel.proposal.newValue)).toThrow(RotationCheckError);
    const vector = op('ROTATION_EXECUTE');
    const prevAddress = `0x${vector.data.slice(34, 74)}`.toLowerCase();
    const oldAddress: Address = `0x${vector.data.slice(98, 138)}`;
    const newAddress: Address = `0x${vector.data.slice(162, 202)}`;
    const ownersForVector =
      prevAddress === SENTINEL_OWNER.toLowerCase() ? [oldAddress] : [prevAddress as Address, oldAddress];
    const tx = executeCall(
      vectors.safe,
      { role: 'S', oldValue: oldAddress, newValue: newAddress },
      ownersForVector,
      BigInt(vector.nonce),
    );
    expect(safeTxHash(8453, vectors.safe, tx)).toBe(vector.safeTxHash);
    const guard = op('GUARD_UPGRADE');
    const newGuard: Address = `0x${guard.data.slice(34, 74)}`;
    const upgrade = executeCall(
      vectors.safe,
      { role: 'GUARD', oldValue: newGuard, newValue: newGuard },
      owners,
      BigInt(guard.nonce),
    );
    expect(safeTxHash(8453, vectors.safe, upgrade)).toBe(guard.safeTxHash);
  });

  it('pendientes leídas de la cadena para los cinco tipos', async () => {
    const id = cancel.message.proposalId;
    const reader = {
      readContract: ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName === 'activeProposal') return Promise.resolve(args[1] === 2 ? id : `0x${'00'.repeat(32)}`);
        return Promise.resolve({
          safe: vectors.safe,
          kind: 2,
          oldValue: cancel.proposal.oldValue,
          newValue: cancel.proposal.newValue,
          createdAt: BigInt(cancel.proposal.createdAt),
          executableAt: BigInt(cancel.proposal.executableAt),
          status: 1,
        });
      },
    } as never;
    expect(await readPendingProposals(reader, timelock, vectors.safe)).toEqual([
      {
        id,
        role: 'S',
        oldValue: cancel.proposal.oldValue,
        newValue: cancel.proposal.newValue,
        createdAt: new Date(cancel.proposal.createdAt * 1000),
        executableAt: new Date(cancel.proposal.executableAt * 1000),
      },
    ]);
  });
});
