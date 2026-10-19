// SafeTx de Safe v1.5.0 (EIP-712 con el dominio {chainId, verifyingContract: Safe}) en Recovery: armado de las llamadas
// que firma R (siempre CALL, sin valor ni reembolso de gas), hash local y comparación campo por campo con la que
// prepara el backend. R firma sólo el hash que calcula la app; si la SafeTx del backend difiere en algo, no se firma.
import { getAddress, hashTypedData, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem';
import type { PreparedOperation, SafeTxJson } from '../api/recovery-api.ts';

export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
}

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** Typed data de la SafeTx para `eth_signTypedData_v4` (wallet externa) o para el hash local. */
export function safeTxTypedData(chainId: number, safe: Address, tx: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx' as const,
    message: tx,
  };
}

export function safeTxHash(chainId: number, safe: Address, tx: SafeTx): Hex {
  return hashTypedData(safeTxTypedData(chainId, safe, tx));
}

/** La forma de toda SafeTx del camino asistido y del soberano: CALL sin valor, sin gas ni reembolso. */
export function plainCall(to: Address, data: Hex, nonce: bigint): SafeTx {
  return {
    to: getAddress(to),
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce,
  };
}

export class SafeTxMismatchError extends Error {
  override name = 'SafeTxMismatchError';
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(
      `La operación que preparó la plataforma no coincide con la que armó esta app (${fields.join(', ')}): no se firma.`,
    );
    this.fields = fields;
  }
}

const UINT = /^(0|[1-9]\d*)$/;

function uint(value: string, field: string): bigint {
  if (!UINT.test(value)) throw new SafeTxMismatchError([field]);
  return BigInt(value);
}

export function parseSafeTx(json: SafeTxJson): SafeTx {
  // Viene del backend como JSON: el tipo no garantiza el valor.
  const operation: unknown = json.operation;
  if (operation !== 0 && operation !== 1) throw new SafeTxMismatchError(['operation']);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(json.data)) throw new SafeTxMismatchError(['data']);
  return {
    to: getAddress(json.to),
    value: uint(json.value, 'value'),
    data: json.data.toLowerCase() as Hex,
    operation,
    safeTxGas: uint(json.safeTxGas, 'safeTxGas'),
    baseGas: uint(json.baseGas, 'baseGas'),
    gasPrice: uint(json.gasPrice, 'gasPrice'),
    gasToken: getAddress(json.gasToken),
    refundReceiver: getAddress(json.refundReceiver),
    nonce: uint(json.nonce, 'nonce'),
  };
}

export function safeTxDifferences(local: SafeTx, remote: SafeTx): string[] {
  const different: string[] = [];
  if (!isAddressEqual(local.to, remote.to)) different.push('to');
  if (local.value !== remote.value) different.push('value');
  if (local.data.toLowerCase() !== remote.data.toLowerCase()) different.push('data');
  if (local.operation !== remote.operation) different.push('operation');
  if (local.safeTxGas !== remote.safeTxGas) different.push('safeTxGas');
  if (local.baseGas !== remote.baseGas) different.push('baseGas');
  if (local.gasPrice !== remote.gasPrice) different.push('gasPrice');
  if (!isAddressEqual(local.gasToken, remote.gasToken)) different.push('gasToken');
  if (!isAddressEqual(local.refundReceiver, remote.refundReceiver)) different.push('refundReceiver');
  if (local.nonce !== remote.nonce) different.push('nonce');
  return different;
}

/** Cuántos nonces por delante del on-chain acepta la app (la cola del backend nunca va más lejos). */
export const MAX_QUEUED_NONCES = 16n;

export interface VerifiedOperation {
  operation: PreparedOperation;
  safeTx: SafeTx;
  /** Hash calculado por la app: es lo único que firma R. */
  hash: Hex;
}

/**
 * Verifica una operación preparada por el backend contra la que arma la app con su intención: misma cadena y Safe,
 * nonce entre el on-chain (RPC propio) y unos pocos por delante, la SafeTx exacta y el mismo hash.
 */
export function verifyPrepared(
  prepared: PreparedOperation,
  expected: { safe: Address; chainId: number; onchainNonce: bigint; build: (nonce: bigint) => SafeTx },
): VerifiedOperation {
  const problems: string[] = [];
  if (prepared.chainId !== expected.chainId) problems.push('chainId');
  if (!isAddressEqual(prepared.safe, expected.safe)) problems.push('safe');
  const remote = parseSafeTx(prepared.safeTx);
  if (remote.nonce < expected.onchainNonce || remote.nonce >= expected.onchainNonce + MAX_QUEUED_NONCES) {
    problems.push('nonce');
  }
  const local = expected.build(remote.nonce);
  for (const field of safeTxDifferences(local, remote)) if (!problems.includes(field)) problems.push(field);
  const hash = safeTxHash(expected.chainId, expected.safe, local);
  if (hash !== prepared.safeTxHash.toLowerCase()) problems.push('safeTxHash');
  if (problems.length > 0) throw new SafeTxMismatchError(problems);
  return { operation: prepared, safeTx: local, hash };
}
