// Lectura de la copia local de los vectores de contracts/test/vectors (SHA-256 verificado por artifacts-sync.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hex } from '../../src/crypto/bytes.ts';
import type { Address } from '../../src/crypto/keccak.ts';
import type { SafeTx } from '../../src/chain/safe-tx.ts';
import { PolicySnapshotSchema, type PolicySnapshot } from '../../src/policy/snapshot.ts';

// Fixtures JSON: el tipo lo declara quien lee cada vector.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function vector<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '../vectors', path), 'utf8')) as T;
}

export interface RawSafeTx {
  to: string;
  value: string;
  data: string;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: string | number;
}

export function toSafeTx(raw: RawSafeTx): SafeTx {
  return {
    to: raw.to as Address,
    value: BigInt(raw.value),
    data: raw.data as Hex,
    operation: raw.operation,
    safeTxGas: BigInt(raw.safeTxGas),
    baseGas: BigInt(raw.baseGas),
    gasPrice: BigInt(raw.gasPrice),
    gasToken: raw.gasToken as Address,
    refundReceiver: raw.refundReceiver as Address,
    nonce: BigInt(raw.nonce),
  };
}

/** Snapshot de los vectores de policy (mismo formato que config/policy/<env>/policy-snapshot.json). */
export function vectorSnapshot(): PolicySnapshot {
  return PolicySnapshotSchema.parse(vector<{ snapshot: unknown }>('policy/policy.json').snapshot);
}
