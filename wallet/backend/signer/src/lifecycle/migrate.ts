// Migración de wallets entre shards [B-SIG-08] (`pnpm shard:migrate`, offline en el host del signer): copia el keystore
// de cada S al shard destino re-cifrándolo con la credencial destino y la registra MIGRATING; verifica que descifre a la
// misma dirección y la pasa a ACTIVE (fase 1); recién entonces el origen queda MIGRATED (fase 2). Sin cambio on-chain:
// la Safe sigue con la misma S. El backend actualiza su asignación con el resultado (signer:reassign).
import type { Kysely } from 'kysely';
import { wipe } from '../crypto/bytes.ts';
import type { Address } from '../crypto/keccak.ts';
import type { Secret } from '../config/secret.ts';
import { deriveKeystorePassword } from '../keystore/derive-password.ts';
import { credentialFingerprint } from '../keystore/fingerprint.ts';
import { KeystoreDirectory } from '../keystore/keystore-dir.ts';
import { decryptKeystore, encryptKeystore } from '../keystore/v3.ts';
import { KeyRegistry, keyRefOf } from '../state/key-registry.ts';
import type { SignerDatabase } from '../state/schema.ts';
import { LifecycleError } from './shard.ts';

export interface ShardSide {
  db: Kysely<SignerDatabase>;
  shardId: string;
  keystoreDir: string;
  credential: Secret<Uint8Array>;
}

export interface MigratedKey {
  walletId: string;
  address: Address;
  fromShard: string;
  toShard: string;
  keyRef: string;
}

export async function migrateWallets(input: {
  source: ShardSide;
  target: ShardSide;
  walletIds: readonly string[];
}): Promise<MigratedKey[]> {
  const { source, target } = input;
  if (source.shardId === target.shardId) throw new LifecycleError('origen y destino son el mismo shard');
  const from = new KeyRegistry(source.db, source.shardId);
  const to = new KeyRegistry(target.db, target.shardId);
  const [sourceShard, targetShard] = await Promise.all([from.shard(), to.shard()]);
  if (sourceShard === undefined || targetShard === undefined) throw new LifecycleError('ambos shards deben existir');
  if (sourceShard.credentialFingerprint !== credentialFingerprint(source.credential)) {
    throw new LifecycleError('la credencial de origen no corresponde al shard de origen');
  }
  const targetFp = credentialFingerprint(target.credential);
  if (targetShard.credentialFingerprint !== targetFp)
    throw new LifecycleError('la credencial destino no corresponde al shard destino');
  const sourceDir = new KeystoreDirectory(source.keystoreDir);
  const targetDir = new KeystoreDirectory(target.keystoreDir);
  const moved: MigratedKey[] = [];

  // Fase 1: copia re-cifrada, MIGRATING → verificación → ACTIVE en destino.
  for (const walletId of input.walletIds) {
    const keys = (await from.forWallet(walletId)).filter((k) => k.status === 'ACTIVE' && k.purpose === 'EXECUTOR');
    if (keys.length === 0) throw new LifecycleError(`la wallet ${walletId} no tiene una S activa en ${source.shardId}`);
    for (const key of keys) {
      let secret: Uint8Array | undefined;
      let password: Uint8Array | undefined;
      try {
        password = deriveKeystorePassword(source.credential, key.address);
        secret = decryptKeystore(sourceDir.read(key.address), password, key.address);
        wipe(password);
        password = deriveKeystorePassword(target.credential, key.address);
        targetDir.write(key.address, encryptKeystore(secret, password));
      } finally {
        wipe(secret, password);
      }
      const record = await to.insertKey(target.db, {
        address: key.address,
        walletId,
        purpose: 'EXECUTOR',
        kdfVersion: targetShard.kdfVersion,
        credentialFingerprint: targetFp,
        status: 'MIGRATING',
      });
      if (key.attestation !== null) await to.setAttestation(record.keyRef, key.attestation);
      let check: Uint8Array | undefined;
      try {
        check = decryptKeystore(
          targetDir.read(key.address),
          deriveKeystorePassword(target.credential, key.address),
          key.address,
        );
      } finally {
        wipe(check);
      }
      await to.setStatus(record.keyRef, 'ACTIVE', 'KEY_MIGRATED_IN', { fromShard: source.shardId });
      moved.push({
        walletId,
        address: key.address,
        fromShard: source.shardId,
        toShard: target.shardId,
        keyRef: keyRefOf(target.shardId, key.address),
      });
    }
  }
  // Fase 2: el origen deja de firmar.
  for (const key of moved) {
    await from.setStatus(keyRefOf(source.shardId, key.address), 'MIGRATED', 'KEY_MIGRATED_OUT', {
      toShard: target.shardId,
    });
  }
  return moved;
}
