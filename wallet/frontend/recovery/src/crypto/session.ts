// R desbloqueada en memoria ([F-KEY-05]): sólo el sobre y K_R (CryptoKey no exportable). Para cada firma se descifra R,
// se firma el digest y los bytes se sobrescriben con ceros; nada de R queda en el estado de la app ni en storages.
import type { Address, Hex, TypedDataDefinition } from 'viem';
import { decryptRecoveryKey, type OpenedEnvelope } from './envelope.ts';
import { wipe } from './encoding.ts';
import { signDigest } from './secp256k1.ts';
import { typedDataDigest } from './typed-data.ts';

export type UnlockedRecovery = OpenedEnvelope;

/** Usa R descifrada durante `action` y la borra al terminar (también si `action` falla). */
export async function withRecoveryKey<T>(
  unlocked: UnlockedRecovery,
  action: (key: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const key = await decryptRecoveryKey(unlocked.envelope, unlocked.encryptionKey);
  try {
    return await action(key);
  } finally {
    wipe(key);
  }
}

/** Firma con R un digest de 32 bytes (SafeTx, typed data) calculado por la app. */
export function signDigestWithRecovery(unlocked: UnlockedRecovery, digest: Hex): Promise<Hex> {
  return withRecoveryKey(unlocked, (key) => signDigest(digest, key));
}

export function signTypedDataWithRecovery(unlocked: UnlockedRecovery, definition: TypedDataDefinition): Promise<Hex> {
  return signDigestWithRecovery(unlocked, typedDataDigest(definition));
}

export function recoveryAddress(unlocked: UnlockedRecovery): Address {
  return unlocked.address;
}
