// Credencial de desbloqueo del shard [B-SIG-08]:
// - rotación (`pnpm credential:rotate`): re-cifra cada keystore con la contraseña derivada de la credencial nueva,
//   archivo por archivo y de forma atómica (kdfVersion + 1), reanudable si se corta; recién al final el shard pasa a
//   la credencial nueva y la anterior se retira;
// - custodia offline (`pnpm credential:escrow` / `credential:recover`): dos copias selladas con `age`, una por
//   custodio (destinatarios distintos), y recuperación verificada contra el fingerprint del shard.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { wipe } from '../crypto/bytes.ts';
import type { Secret } from '../config/secret.ts';
import { deriveKeystorePassword, readCredentialFile } from '../keystore/derive-password.ts';
import { atomicWriteFile } from '../keystore/atomic-write.ts';
import { credentialFingerprint } from '../keystore/fingerprint.ts';
import { KeystoreDirectory } from '../keystore/keystore-dir.ts';
import { decryptKeystore, encryptKeystore, KeystoreError } from '../keystore/v3.ts';
import { KeyRegistry } from '../state/key-registry.ts';
import type { SignerDatabase } from '../state/schema.ts';
import { ageDecrypt, ageEncrypt, isAgeRecipient } from './age.ts';
import { LifecycleError } from './shard.ts';

const WITH_FILE = ['ACTIVE', 'RETIRED', 'MIGRATING'] as const;

export interface RotationReport {
  reencrypted: number;
  alreadyRotated: number;
  kdfVersion: number;
  skippedBroken: string[];
}

export async function rotateCredential(input: {
  db: Kysely<SignerDatabase>;
  shardId: string;
  keystoreDir: string;
  oldCredential: Secret<Uint8Array>;
  newCredential: Secret<Uint8Array>;
}): Promise<RotationReport> {
  const registry = new KeyRegistry(input.db, input.shardId);
  const shard = await registry.shard();
  if (shard === undefined) throw new LifecycleError(`el shard ${input.shardId} no existe`);
  const oldFp = credentialFingerprint(input.oldCredential);
  const newFp = credentialFingerprint(input.newCredential);
  if (oldFp === newFp) throw new LifecycleError('la credencial nueva es igual a la vigente');
  if (shard.credentialFingerprint !== oldFp && shard.credentialFingerprint !== newFp) {
    throw new LifecycleError('la credencial vigente no coincide con la del shard');
  }
  const kdfVersion = shard.credentialFingerprint === newFp ? shard.kdfVersion : shard.kdfVersion + 1;
  const directory = new KeystoreDirectory(input.keystoreDir);
  const report: RotationReport = { reencrypted: 0, alreadyRotated: 0, kdfVersion, skippedBroken: [] };
  for (const key of await registry.list(WITH_FILE)) {
    if (key.credentialFingerprint === newFp) {
      report.alreadyRotated++;
      continue;
    }
    const keystore = directory.read(key.address);
    let secret: Uint8Array | undefined;
    let password: Uint8Array | undefined;
    try {
      try {
        password = deriveKeystorePassword(input.oldCredential, key.address);
        secret = decryptKeystore(keystore, password, key.address);
      } catch (error) {
        if (!(error instanceof KeystoreError) || error.problem !== 'MAC') throw error;
        // Corte anterior entre el archivo y la DB: el archivo ya está con la credencial nueva.
        wipe(password);
        password = deriveKeystorePassword(input.newCredential, key.address);
        wipe(decryptKeystore(keystore, password, key.address));
        await registry.recordReencryption(input.db, key.keyRef, kdfVersion, newFp);
        report.reencrypted++;
        continue;
      }
      wipe(password);
      password = deriveKeystorePassword(input.newCredential, key.address);
      directory.write(key.address, encryptKeystore(secret, password), { replace: true });
      await registry.recordReencryption(input.db, key.keyRef, kdfVersion, newFp);
      report.reencrypted++;
    } catch (error) {
      if (error instanceof KeystoreError) {
        report.skippedBroken.push(key.address);
        continue;
      }
      throw error;
    } finally {
      wipe(secret, password);
    }
  }
  if (report.skippedBroken.length > 0) {
    throw new LifecycleError(
      `claves que no se pudieron re-cifrar (restaurar antes): ${report.skippedBroken.join(', ')}`,
    );
  }
  await input.db.transaction().execute((trx) => registry.updateShardCredential(trx, kdfVersion, newFp));
  return report;
}

export interface EscrowCustodian {
  name: string;
  recipient: string;
}

/** Dos copias selladas de la credencial, cada una cifrada para un custodio distinto. */
export async function escrowCredential(input: {
  db: Kysely<SignerDatabase>;
  shardId: string;
  credentialFile: string;
  keystoreDir: string;
  custodians: readonly EscrowCustodian[];
  outDir: string;
}): Promise<{ files: string[]; manifest: string }> {
  if (input.custodians.length !== 2) throw new LifecycleError('la custodia exige exactamente dos custodios');
  const [a, b] = input.custodians as [EscrowCustodian, EscrowCustodian];
  if (a.name === b.name || a.recipient === b.recipient) throw new LifecycleError('los custodios deben ser distintos');
  if (!isAgeRecipient(a.recipient) || !isAgeRecipient(b.recipient))
    throw new LifecycleError('destinatario age inválido');
  if (!/^[a-z0-9-]{1,32}$/.test(a.name) || !/^[a-z0-9-]{1,32}$/.test(b.name)) {
    throw new LifecycleError('nombre de custodio inválido ([a-z0-9-])');
  }
  const credential = readCredentialFile(input.credentialFile, { keystoreDir: input.keystoreDir });
  const registry = new KeyRegistry(input.db, input.shardId);
  const shard = await registry.shard();
  const fingerprint = credentialFingerprint(credential);
  if (shard === undefined || shard.credentialFingerprint !== fingerprint) {
    throw new LifecycleError('la credencial no corresponde al shard');
  }
  const plaintext = readFileSync(input.credentialFile);
  const files: string[] = [];
  for (const custodian of [a, b]) {
    const file = join(input.outDir, `${input.shardId}-unlock-credential.${custodian.name}.age`);
    atomicWriteFile(file, ageEncrypt(plaintext, [custodian.recipient]), { mode: 0o400 });
    files.push(file);
  }
  plaintext.fill(0);
  const manifest = join(input.outDir, `${input.shardId}-unlock-credential.manifest.json`);
  atomicWriteFile(
    manifest,
    `${JSON.stringify(
      {
        shardId: input.shardId,
        credentialFingerprint: fingerprint,
        kdfVersion: shard.kdfVersion,
        createdAt: new Date().toISOString(),
        custodians: [a, b].map((c, i) => ({ name: c.name, recipient: c.recipient, file: files[i] })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o400 },
  );
  await registry.event(input.db, null, 'CREDENTIAL_ESCROWED', {
    custodians: [a.name, b.name],
    kdfVersion: shard.kdfVersion,
  });
  return { files, manifest };
}

/** Recupera la credencial desde la copia de un custodio y la verifica contra el fingerprint del shard. */
export async function recoverCredential(input: {
  db: Kysely<SignerDatabase>;
  shardId: string;
  sealedFile: string;
  identityFile: string;
  outFile: string;
}): Promise<void> {
  const plaintext = ageDecrypt(readFileSync(input.sealedFile), input.identityFile);
  const text = plaintext.toString('utf8').replace(/\r?\n$/, '');
  if (!/^[0-9a-f]{64}$/.test(text)) throw new LifecycleError('la copia sellada no contiene una credencial válida');
  const { Secret } = await import('../config/secret.ts');
  const fingerprint = credentialFingerprint(new Secret(Uint8Array.from(Buffer.from(text, 'hex'))));
  const shard = await new KeyRegistry(input.db, input.shardId).shard();
  if (shard === undefined || shard.credentialFingerprint !== fingerprint) {
    throw new LifecycleError('la credencial recuperada no corresponde al shard');
  }
  atomicWriteFile(input.outFile, text, { mode: 0o400 });
  plaintext.fill(0);
}
