// P19: SafeTx de Recovery contra los vectores de contracts/ (hash EIP-712 y firma de R de cada operación), la
// verificación de lo que prepara el backend (bytes distintos → no se firma) y las llamadas de rotación.
import { decodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json' with { type: 'json' };
import type { PreparedOperation } from '../api/recovery-api.ts';
import { signDigest } from '../crypto/secp256k1.ts';
import { iSafeAbi } from './abis/ISafe.ts';
import { rotationTimelockAbi } from './abis/RotationTimelock.ts';
import {
  cancelWithSignatureData,
  executeCall,
  previousOwner,
  proposeCall,
  RotationError,
  SENTINEL_OWNER,
} from './rotations.ts';
import { parseSafeTx, plainCall, safeTxHash, SafeTxMismatchError, verifyPrepared, type SafeTx } from './safe-tx.ts';

const R_KEY = toBytes(keccak256(toBytes('mtw-recovery-key')));
const safe = safeTxVectors.safe as Address;

function fromVector(op: (typeof safeTxVectors.operations)[number]): SafeTx {
  return parseSafeTx({
    to: op.to as Address,
    value: op.value,
    data: op.data as Hex,
    operation: op.operation as 0 | 1,
    safeTxGas: op.safeTxGas,
    baseGas: op.baseGas,
    gasPrice: op.gasPrice,
    gasToken: op.gasToken as Address,
    refundReceiver: op.refundReceiver as Address,
    nonce: String(op.nonce),
  });
}

describe('SafeTx (vectores de contracts/)', () => {
  it.each(safeTxVectors.operations.map((op) => [op.opType, op] as const))(
    '%s: mismo hash y misma firma de R',
    (_, op) => {
      const tx = fromVector(op);
      expect(safeTxHash(8453, safe, tx)).toBe(op.safeTxHash);
      expect(signDigest(op.safeTxHash as Hex, R_KEY)).toBe(op.signatureRecovery);
    },
  );
});

function prepared(tx: SafeTx, overrides: Partial<PreparedOperation> = {}): PreparedOperation {
  return {
    operationId: 'op',
    groupId: null,
    walletId: 'w',
    safe,
    chainId: 8453,
    operationType: 'NOOP_CANCEL',
    safeTx: {
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: tx.nonce.toString(),
    },
    safeTxHash: safeTxHash(8453, safe, tx),
    typedData: {},
    decoded: {},
    requiresTwoFactor: false,
    expiresAt: '2026-10-18T00:00:00Z',
    ...overrides,
  };
}

describe('verificación de lo preparado por el backend', () => {
  const build = (nonce: bigint) => plainCall(safe, '0x', nonce);

  it('la misma SafeTx con un nonce de la cola: se firma el hash local', () => {
    const verified = verifyPrepared(prepared(build(5n)), { safe, chainId: 8453, onchainNonce: 4n, build });
    expect(verified.hash).toBe(safeTxHash(8453, safe, build(5n)));
  });

  it('otros bytes, otra Safe, otra cadena o un nonce fuera de la cola: no se firma y se dice qué difiere', () => {
    const other = plainCall(safe, '0x01', 5n);
    const cases: [PreparedOperation, string][] = [
      [{ ...prepared(build(5n)), safeTx: prepared(other).safeTx }, 'data'],
      [prepared(build(5n), { safe: '0x0000000000000000000000000000000000000001' }), 'safe'],
      [prepared(build(5n), { chainId: 1 }), 'chainId'],
      [prepared(build(40n)), 'nonce'],
      [prepared(build(2n)), 'nonce'],
      [{ ...prepared(build(5n)), safeTx: { ...prepared(build(5n)).safeTx, operation: 1 } }, 'operation'],
    ];
    for (const [operation, field] of cases) {
      expect(() => verifyPrepared(operation, { safe, chainId: 8453, onchainNonce: 4n, build })).toThrow(
        SafeTxMismatchError,
      );
      try {
        verifyPrepared(operation, { safe, chainId: 8453, onchainNonce: 4n, build });
      } catch (error) {
        expect((error as SafeTxMismatchError).fields).toContain(field);
      }
    }
  });
});

describe('rotaciones', () => {
  const owners: Address[] = [
    '0x79406Eb1d6abdA075A9789DBD7d31626FEFE2904',
    '0xc80D387fCc59cB57AEf0eC2b137C77D26474288E',
    '0x7184D30100a188c9F869ccB6883392534ecD6C9d',
  ];

  it('owner anterior en la lista enlazada (el primero tiene al centinela)', () => {
    expect(previousOwner(owners, owners[0] ?? '0x')).toBe(SENTINEL_OWNER);
    expect(previousOwner(owners, owners[2] ?? '0x')).toBe(owners[1]);
    expect(() => previousOwner(owners, '0x0000000000000000000000000000000000000002')).toThrow(RotationError);
  });

  it('propuesta, ejecución con swapOwner o setGuard y cancelWithSignature', () => {
    const timelock: Address = '0xa38D17ef017A314cCD72b8F199C0e108EF7Ca04c';
    const next: Address = '0xd39E49885C432cec12140673AF42Be648de9364b';
    const propose = proposeCall(timelock, 'U', owners[0] ?? '0x', next, 3n);
    expect(propose.to).toBe(timelock);
    expect(decodeFunctionData({ abi: rotationTimelockAbi, data: propose.data }).args).toEqual([0, owners[0], next]);
    const execute = executeCall(safe, { kind: 'U', oldValue: owners[0] ?? '0x', newValue: next }, owners, 4n);
    expect(decodeFunctionData({ abi: iSafeAbi, data: execute.data }).args).toEqual([SENTINEL_OWNER, owners[0], next]);
    const guard = executeCall(safe, { kind: 'GUARD', oldValue: owners[1] ?? '0x', newValue: next }, owners, 4n);
    expect(decodeFunctionData({ abi: iSafeAbi, data: guard.data }).functionName).toBe('setGuard');
    const id: Hex = `0x${'ab'.repeat(32)}`;
    const signature: Hex = `0x${'11'.repeat(65)}`;
    expect(decodeFunctionData({ abi: rotationTimelockAbi, data: cancelWithSignatureData(id, signature) }).args).toEqual(
      [id, signature],
    );
  });
});
