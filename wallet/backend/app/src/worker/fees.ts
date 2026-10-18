// Fees EIP-1559 de las tx de S (P13.T05, [B-NONCE-05]): sugeridos por el nodo (`2·baseFee + priority`), acotados por
// los topes del snapshot de policy (el signer aplica los mismos topes y rechaza lo que los supere), y reemplazo por fee
// bump: la tx nueva usa el mismo nonce de cuenta y sube maxFeePerGas y maxPriorityFeePerGas al menos un 12,5 % sobre la
// anterior (regla de reemplazo de los nodos; se redondea hacia arriba).
import type { RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Aumento mínimo de un reemplazo: 12,5 % (1/8), redondeado hacia arriba. */
export function bumped(value: bigint): bigint {
  return value + (value + 7n) / 8n;
}

export class FeeCapExceededError extends Error {
  override name = 'FeeCapExceededError';
}

export function capped(fees: Fees, snapshot: BackendPolicySnapshot): Fees {
  const maxFee = fees.maxFeePerGas < snapshot.gas.maxFeePerGasWei ? fees.maxFeePerGas : snapshot.gas.maxFeePerGasWei;
  const priorityCap = snapshot.gas.maxPriorityFeePerGasWei;
  let priority = fees.maxPriorityFeePerGas < priorityCap ? fees.maxPriorityFeePerGas : priorityCap;
  if (priority > maxFee) priority = maxFee;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

/**
 * Fees para una tx nueva o para reemplazar `previous` (mismo nonce de cuenta). Un reemplazo que no entra en los topes
 * de la policy no se puede hacer: FeeCapExceededError (queda la tx en vuelo y se alerta).
 */
export async function executionFees(
  rpc: RpcQuorumClient,
  snapshot: BackendPolicySnapshot,
  previous?: Fees,
): Promise<Fees> {
  const suggested = await rpc.feeData();
  if (previous === undefined) return capped(suggested, snapshot);
  const wanted: Fees = {
    maxFeePerGas: max(suggested.maxFeePerGas, bumped(previous.maxFeePerGas)),
    maxPriorityFeePerGas: max(suggested.maxPriorityFeePerGas, bumped(previous.maxPriorityFeePerGas)),
  };
  if (wanted.maxPriorityFeePerGas > wanted.maxFeePerGas) wanted.maxFeePerGas = wanted.maxPriorityFeePerGas;
  const result = capped(wanted, snapshot);
  if (
    result.maxFeePerGas < bumped(previous.maxFeePerGas) ||
    result.maxPriorityFeePerGas < bumped(previous.maxPriorityFeePerGas)
  ) {
    throw new FeeCapExceededError('el reemplazo supera los topes de fees del snapshot de policy');
  }
  return result;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
