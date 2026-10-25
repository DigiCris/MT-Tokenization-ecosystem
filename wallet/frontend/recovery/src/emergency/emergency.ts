// Emergencia con R + S (P19.T10, `/emergency`): las SafeTx que arma la app para compararlas con las del backend antes de
// que R firme —baja inmediata de un destino de la whitelist, NoOp con el nonce de la operación que anula y
// approve(SwapExecutor, 0) de USDC o USDT— y qué operaciones se pueden anular ([B-NONCE-06]).
import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import type { OperationStatus } from '../api/recovery-api.ts';
import { destinationWhitelistAbi } from '../chain/abis/DestinationWhitelist.ts';
import { plainCall, SafeTxMismatchError, type SafeTx } from '../chain/safe-tx.ts';

/** Sin firmar se cancela sin NoOp; firmada (o con una NoOp anterior vencida), con una NoOp del mismo nonce. */
export const CANCELLABLE_STATES: readonly OperationStatus['status'][] = [
  'CREATED',
  'USER_SIGNED',
  'QUEUED',
  'READY',
  'SUBMITTED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'CANCEL_REQUESTED',
];

/** Las operaciones pendientes que se ofrecen para anular (una NoOp no se anula con otra NoOp). */
export function cancellableOperations(items: readonly OperationStatus[]): OperationStatus[] {
  return items.filter((op) => CANCELLABLE_STATES.includes(op.status) && op.operationType !== 'NOOP_CANCEL');
}

/**
 * El nonce de la operación a anular, sólo si el backend lo informa como un número (uint256 en decimal): si no, no se
 * muestra ni se arma una NoOp con él (y su texto nunca llega a la pantalla).
 */
export function targetNonce(op: Pick<OperationStatus, 'safeNonce'>): bigint | null {
  return /^\d{1,78}$/.test(op.safeNonce) ? BigInt(op.safeNonce) : null;
}

export function removeDestinationCall(whitelist: Address, destination: Address, nonce: bigint): SafeTx {
  return plainCall(
    whitelist,
    encodeFunctionData({ abi: destinationWhitelistAbi, functionName: 'removeDestination', args: [destination] }),
    nonce,
  );
}

/** La NoOp anula la operación sólo si ocupa su mismo nonce: con otro nonce no se firma. */
export function noopCall(safe: Address, targetNonce: bigint, nonce: bigint): SafeTx {
  if (nonce !== targetNonce) throw new SafeTxMismatchError(['nonce']);
  return plainCall(safe, '0x', nonce);
}

export function revokeApprovalCall(token: Address, spender: Address, nonce: bigint): SafeTx {
  return plainCall(token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }), nonce);
}
