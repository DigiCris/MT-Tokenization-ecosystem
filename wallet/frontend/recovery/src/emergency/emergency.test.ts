// P19.T10: las SafeTx de emergencia que arma Recovery son las de los vectores de contracts/ (baja de whitelist, NoOp y
// revocación del permiso del SwapExecutor) y una NoOp con otro nonce que el de la operación que anula no se firma.
import { getAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json' with { type: 'json' };
import systemVector from '../../test/vectors/system.json' with { type: 'json' };
import type { OperationStatus } from '../api/recovery-api.ts';
import { safeTxHash, SafeTxMismatchError, type SafeTx } from '../chain/safe-tx.ts';
import { cancellableOperations, noopCall, removeDestinationCall, revokeApprovalCall } from './emergency.ts';

const safe = safeTxVectors.safe as Address;
const vector = (opType: string) => {
  const op = safeTxVectors.operations.find((o) => o.opType === opType);
  if (!op) throw new Error(`falta el vector ${opType}`);
  return op;
};

function expectVector(tx: SafeTx, opType: string): void {
  const op = vector(opType);
  expect(tx.to).toBe(getAddress(op.to));
  expect(tx.data).toBe(op.data);
  expect(tx.nonce).toBe(BigInt(op.nonce));
  expect(safeTxHash(8453, safe, tx)).toBe(op.safeTxHash);
}

describe('SafeTx de emergencia', () => {
  it('baja de un destino de la whitelist', () => {
    const op = vector('WHITELIST_REMOVE');
    const destination = getAddress(`0x${op.data.slice(-40)}`);
    expectVector(
      removeDestinationCall(systemVector.contracts.destinationWhitelist as Address, destination, 1n),
      'WHITELIST_REMOVE',
    );
  });

  it('NoOp con el nonce de la operación que anula', () => {
    expectVector(noopCall(safe, 1n, 1n), 'NOOP');
  });

  it('una NoOp con otro nonce no anula nada: no se arma', () => {
    expect(() => noopCall(safe, 2n, 1n)).toThrow(SafeTxMismatchError);
  });

  it('approve(SwapExecutor, 0) de USDC', () => {
    expectVector(
      revokeApprovalCall(systemVector.contracts.usdc as Address, systemVector.contracts.swapExecutor as Address, 1n),
      'APPROVE_REVOKE',
    );
  });
});

describe('operaciones que se ofrecen para anular', () => {
  const op = (
    status: OperationStatus['status'],
    operationType: OperationStatus['operationType'] = 'SEND',
  ): OperationStatus => ({
    id: `${status}-${operationType}`,
    walletId: 'w',
    status,
    operationType,
    groupId: null,
    safeNonce: '3',
    safeTxHash: `0x${'1'.repeat(64)}`,
    txHash: null,
    blockNumber: null,
    failureReason: null,
    lastErrorCode: null,
    blockedReason: null,
    createdAt: '2026-10-18T00:00:00Z',
  });

  it('las pendientes y las canceladas a medias sí; las minadas, finales y las NoOp no', () => {
    const items = [
      op('CREATED'),
      op('USER_SIGNED'),
      op('QUEUED'),
      op('READY'),
      op('SUBMITTED'),
      op('FAILED_RETRYABLE'),
      op('FAILED_FINAL'),
      op('CANCEL_REQUESTED'),
      op('VALIDATING'),
      op('MINED'),
      op('CONFIRMED'),
      op('FINALIZED'),
      op('CANCELLED'),
      op('EXPIRED'),
      op('USER_SIGNED', 'NOOP_CANCEL'),
    ];
    expect(cancellableOperations(items).map((o) => o.status)).toEqual([
      'CREATED',
      'USER_SIGNED',
      'QUEUED',
      'READY',
      'SUBMITTED',
      'FAILED_RETRYABLE',
      'FAILED_FINAL',
      'CANCEL_REQUESTED',
    ]);
  });
});
