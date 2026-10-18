// Intención canónica de una operación (columna `canonical_intent`) y vistas de la API [B-API-SCH]. La SafeTx se guarda
// campo por campo (uint256 en decimal) y el worker la reconstruye desde acá para recalcular el SafeTxHash (paso 3 de
// [B-Q-02]); `decoded` es sólo para mostrar (la policy siempre decodifica desde los bytes).
import { getAddress, type Address, type Hex } from 'viem';
import type { DecodedCall } from '../chain/decoders/safe-call.ts';
import { SAFE_TX_TYPES, type SafeTx } from '../chain/safe-tx.ts';
import type { OperationStatus } from '../db/schema.ts';
import type { OperationKind } from '../policy/snapshot.ts';

export interface SafeTxJson {
  to: Address;
  value: string;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: string;
}

export interface DecodedView {
  token?: 'USDC' | 'USDT';
  amount?: string;
  destination?: Address;
  tokenIn?: 'USDC' | 'USDT';
  tokenOut?: 'USDC' | 'USDT';
  minAmountOut?: string;
  deadline?: string;
  role?: 'U' | 'R' | 'S' | 'GUARD' | 'MODULE_GUARD';
  oldKey?: Address;
  newKey?: Address;
}

export interface CanonicalIntent {
  version: 1;
  chainId: number;
  safe: Address;
  operationType: OperationKind;
  ownerRole: 'U' | 'R';
  safeTx: SafeTxJson;
  decoded: DecodedView;
}

export function safeTxToJson(tx: SafeTx): SafeTxJson {
  return {
    to: getAddress(tx.to),
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: getAddress(tx.gasToken),
    refundReceiver: getAddress(tx.refundReceiver),
    nonce: tx.nonce.toString(),
  };
}

export function safeTxFromJson(json: SafeTxJson): SafeTx {
  return {
    to: getAddress(json.to),
    value: BigInt(json.value),
    data: json.data,
    operation: json.operation,
    safeTxGas: BigInt(json.safeTxGas),
    baseGas: BigInt(json.baseGas),
    gasPrice: BigInt(json.gasPrice),
    gasToken: getAddress(json.gasToken),
    refundReceiver: getAddress(json.refundReceiver),
    nonce: BigInt(json.nonce),
  };
}

const ROLE_OF_KIND = ['U', 'R', 'S', 'GUARD', 'MODULE_GUARD'] as const;

export function decodedView(call: DecodedCall): DecodedView {
  switch (call.kind) {
    case 'ERC20_TRANSFER':
      return { token: call.token, amount: call.amount.toString(), destination: call.recipient };
    case 'ERC20_APPROVE':
      return { token: call.token, amount: call.amount.toString() };
    case 'SWAP':
      return {
        tokenIn: call.tokenIn,
        tokenOut: call.tokenOut,
        amount: call.amountIn.toString(),
        minAmountOut: call.minAmountOut.toString(),
        deadline: call.deadline.toString(),
      };
    case 'WHITELIST_ADD':
    case 'WHITELIST_REMOVE':
      return { destination: call.destination };
    case 'ROTATION_PROPOSE':
      return { role: ROLE_OF_KIND[call.rotationKind], oldKey: call.oldValue, newKey: call.newValue };
    case 'SWAP_OWNER':
      return { oldKey: call.oldOwner, newKey: call.newOwner };
    case 'SET_GUARD':
      return { role: 'GUARD', newKey: call.guard };
    case 'SET_MODULE_GUARD':
      return { role: 'MODULE_GUARD', newKey: call.moduleGuard };
    case 'NOOP':
    case 'ROTATION_CANCEL':
      return {};
  }
}

/** Typed data EIP-712 de la SafeTx tal como lo firma U o R (eth_signTypedData_v4, uint256 en decimal). */
export function safeTxTypedDataJson(chainId: number, safe: Address, tx: SafeTxJson) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: {
      EIP712Domain: [
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...SAFE_TX_TYPES,
    },
    primaryType: 'SafeTx' as const,
    message: tx,
  };
}

export interface PreparedOperation {
  operationId: string;
  groupId: string | null;
  walletId: string;
  safe: Address;
  chainId: number;
  operationType: OperationKind;
  safeTx: SafeTxJson;
  safeTxHash: Hex;
  typedData: ReturnType<typeof safeTxTypedDataJson>;
  decoded: DecodedView;
  requiresTwoFactor: boolean;
  expiresAt: string;
}

export interface OperationView {
  id: string;
  walletId: string;
  status: OperationStatus;
  operationType: OperationKind;
  safeNonce: string;
  safeTxHash: Hex;
  txHash: Hex | null;
  blockNumber: string | null;
  blockHash: Hex | null;
  confirmations: { safe: boolean; finalized: boolean };
  failureReason: string | null;
  lastErrorCode: string | null;
  blockedReason: 'WAITING_LOWER_NONCE' | null;
  requiresTwoFactor: boolean;
  expiresAt: string | null;
  cancelsOperationId: string | null;
  createdAt: string;
  history: { status: OperationStatus; at: string }[];
}
