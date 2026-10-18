// SafeTx de Safe 1.5.0 armada y hasheada por la app (P18.SEC: ningún dato de la SafeTx se toma del backend sin
// reconstrucción local). Para cada intención la app arma su propia SafeTx con las direcciones fijadas en el build, la
// compara campo por campo con la que preparó el backend y U firma el hash EIP-712 calculado acá; cualquier diferencia
// (destino, datos, nonce fuera de rango, gas o refund no nulos, otra Safe u otra cadena) bloquea la firma.
import { hashTypedData, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem';
import type { PreparedOperation, SafeTxJson } from '../api/wallet-api.ts';

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

/** Cuántas operaciones en cola por delante del nonce on-chain acepta la app en una SafeTx preparada. */
export const MAX_QUEUED_NONCES = 16n;

export function safeTxHash(chainId: number, safe: Address, tx: SafeTx): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: tx,
  });
}

/** Llamada del camino asistido: sin valor, CALL, sin gas ni refund (lo único que aceptan el Guard y el signer). */
export function assistedCall(to: Address, data: Hex, nonce: bigint): SafeTx {
  return {
    to,
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

function uint(value: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new SafeTxMismatchError([field]);
  return BigInt(value);
}

/** SafeTx del JSON del backend (los uint256 vienen en decimal). */
export function parseSafeTx(json: SafeTxJson): SafeTx {
  return {
    to: json.to,
    value: uint(json.value, 'value'),
    data: json.data,
    operation: json.operation,
    safeTxGas: uint(json.safeTxGas, 'safeTxGas'),
    baseGas: uint(json.baseGas, 'baseGas'),
    gasPrice: uint(json.gasPrice, 'gasPrice'),
    gasToken: json.gasToken,
    refundReceiver: json.refundReceiver,
    nonce: uint(json.nonce, 'nonce'),
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

/** Campos en los que difieren dos SafeTx (vacío = iguales). */
export function safeTxDifferences(local: SafeTx, remote: SafeTx): string[] {
  const out: string[] = [];
  if (!isAddressEqual(local.to, remote.to)) out.push('to');
  if (local.value !== remote.value) out.push('value');
  if (local.data.toLowerCase() !== remote.data.toLowerCase()) out.push('data');
  if (local.operation !== remote.operation) out.push('operation');
  if (local.safeTxGas !== remote.safeTxGas) out.push('safeTxGas');
  if (local.baseGas !== remote.baseGas) out.push('baseGas');
  if (local.gasPrice !== remote.gasPrice) out.push('gasPrice');
  if (!isAddressEqual(local.gasToken, remote.gasToken)) out.push('gasToken');
  if (!isAddressEqual(local.refundReceiver, remote.refundReceiver)) out.push('refundReceiver');
  if (local.nonce !== remote.nonce) out.push('nonce');
  return out;
}

export interface VerifiedOperation {
  operation: PreparedOperation;
  safeTx: SafeTx;
  /** Hash calculado por la app (igual al del backend): es lo que firma U. */
  hash: Hex;
}

/**
 * Verifica una operación preparada por el backend contra la que armó la app con su propia intención: misma Safe y
 * cadena, la SafeTx exacta (con el nonce que asigna la cola, que tiene que estar entre el nonce on-chain leído por el
 * RPC propio y unos pocos por delante) y el mismo hash. Devuelve el hash local, que es el único que se firma.
 */
export function verifyPrepared(
  prepared: PreparedOperation,
  expected: { safe: Address; chainId: number; build: (nonce: bigint) => SafeTx; onchainNonce: bigint },
): VerifiedOperation {
  const problems: string[] = [];
  if (prepared.chainId !== expected.chainId) problems.push('chainId');
  if (!isAddressEqual(prepared.safe, expected.safe)) problems.push('safe');
  const remote = parseSafeTx(prepared.safeTx);
  if (remote.nonce < expected.onchainNonce || remote.nonce >= expected.onchainNonce + MAX_QUEUED_NONCES) {
    problems.push('nonce');
  }
  const local = expected.build(remote.nonce);
  problems.push(...safeTxDifferences(local, remote).filter((f) => !problems.includes(f)));
  const hash = safeTxHash(expected.chainId, expected.safe, local);
  if (hash !== prepared.safeTxHash.toLowerCase()) problems.push('safeTxHash');
  if (problems.length > 0) throw new SafeTxMismatchError(problems);
  return { operation: prepared, safeTx: local, hash };
}
