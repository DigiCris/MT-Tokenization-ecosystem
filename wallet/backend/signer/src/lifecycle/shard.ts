// Alta de un shard [B-SIG-08]/[B-SIG-09] (`pnpm shard:create`): directorio de keystores 0700 vacío, credencial de
// desbloqueo de 32 bytes en OTRO directorio (generada si se pide), migraciones de su DB, fila del shard con el
// fingerprint de la credencial y, para el shard `platform`, la cuenta gas tank.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Kysely } from 'kysely';
import type { Address } from '../crypto/keccak.ts';
import { readCredentialFile } from '../keystore/derive-password.ts';
import { atomicWriteFile } from '../keystore/atomic-write.ts';
import { credentialFingerprint } from '../keystore/fingerprint.ts';
import type { Logger } from '../observability/logger.ts';
import { SelfHostedSoftwareSignerProvider } from '../providers/SelfHostedSoftwareSignerProvider.ts';
import { KeyRegistry } from '../state/key-registry.ts';
import { migrateToLatest } from '../state/migrator.ts';
import type { SignerDatabase } from '../state/schema.ts';

export class LifecycleError extends Error {
  override name = 'LifecycleError';
}

export interface CreateShardInput {
  db: Kysely<SignerDatabase>;
  shardId: string;
  provider: 'development' | 'selfhosted';
  keystoreDir: string;
  credentialFile: string;
  generateCredential: boolean;
  gasTank: boolean;
  logger: Logger;
}

export async function createShard(
  input: CreateShardInput,
): Promise<{ credentialFingerprint: string; gasTank?: Address }> {
  await migrateToLatest(input.db);
  const registry = new KeyRegistry(input.db, input.shardId);
  if ((await registry.shard()) !== undefined) throw new LifecycleError(`el shard ${input.shardId} ya existe`);
  mkdirSync(input.keystoreDir, { recursive: true, mode: 0o700 });
  if (readdirSync(input.keystoreDir).length > 0) throw new LifecycleError('el directorio de keystores no está vacío');
  if (!existsSync(input.credentialFile)) {
    if (!input.generateCredential)
      throw new LifecycleError('falta la credencial de desbloqueo (--generate-credential)');
    mkdirSync(dirname(input.credentialFile), { recursive: true, mode: 0o700 });
    atomicWriteFile(input.credentialFile, randomBytes(32).toString('hex'), { mode: 0o400 });
  }
  const credential = readCredentialFile(input.credentialFile, { keystoreDir: input.keystoreDir });
  const fingerprint = credentialFingerprint(credential);
  await registry.initShard({ provider: input.provider, credentialFingerprint: fingerprint });
  if (!input.gasTank) return { credentialFingerprint: fingerprint };
  const provider = await SelfHostedSoftwareSignerProvider.open({
    shardId: input.shardId,
    keystoreDir: input.keystoreDir,
    credential,
    db: input.db,
    logger: input.logger,
  });
  const created = await provider.createKey(null, 'GAS_TANK');
  return { credentialFingerprint: fingerprint, gasTank: created.address };
}
