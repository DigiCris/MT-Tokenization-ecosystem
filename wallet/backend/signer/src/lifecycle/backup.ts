// Backup y restore de un shard [B-SIG-08], ADR-031: keystores (ya cifrados) + volcado de la DB del shard en un paquete
// JSON cifrado con `age` hacia las claves públicas de backup. La credencial de desbloqueo NO se incluye: se custodia
// offline aparte (credential.ts). El restore exige DB y directorio vacíos y se completa con `restore-verify`.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { isAddress, type Address } from '../crypto/keccak.ts';
import { atomicWriteFile } from '../keystore/atomic-write.ts';
import { KeystoreDirectory } from '../keystore/keystore-dir.ts';
import { KeyRegistry } from '../state/key-registry.ts';
import { migrateToLatest } from '../state/migrator.ts';
import type { SignerDatabase } from '../state/schema.ts';
import { ageDecrypt, ageEncrypt } from './age.ts';
import { LifecycleError } from './shard.ts';

/** Tablas en orden de inserción (respeta las FKs). */
export const BACKUP_TABLES = [
  'signer_shards',
  'signer_keys',
  'key_events',
  'policy_state',
  'signed_safe_txs',
  'exec_signatures',
  'platform_txs',
] as const;

const BundleSchema = z.object({
  format: z.literal('mtw-signer-shard-backup'),
  version: z.literal(1),
  shardId: z.string(),
  createdAt: z.string(),
  credentialFingerprint: z.string(),
  keystores: z.array(z.object({ address: z.custom<Address>((a) => isAddress(a)), content: z.string() })),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

export async function backupShard(input: {
  db: Kysely<SignerDatabase>;
  shardId: string;
  keystoreDir: string;
  recipients: readonly string[];
  outFile: string;
}): Promise<{ sha256: string; keystores: number }> {
  const registry = new KeyRegistry(input.db, input.shardId);
  const shard = await registry.shard();
  if (shard === undefined) throw new LifecycleError(`el shard ${input.shardId} no existe`);
  const directory = new KeystoreDirectory(input.keystoreDir);
  const { addresses } = directory.index();
  const keystores = addresses.map((address) => ({ address, content: JSON.stringify(directory.read(address)) }));
  const tables: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)} ORDER BY 1`.execute(input.db);
    tables[table] = result.rows;
  }
  const bundle = {
    format: 'mtw-signer-shard-backup',
    version: 1,
    shardId: input.shardId,
    createdAt: new Date().toISOString(),
    credentialFingerprint: shard.credentialFingerprint,
    keystores,
    tables,
  };
  const encrypted = ageEncrypt(Buffer.from(JSON.stringify(bundle), 'utf8'), input.recipients);
  atomicWriteFile(input.outFile, encrypted, { mode: 0o600, replace: true });
  const sha256 = createHash('sha256').update(encrypted).digest('hex');
  await registry.event(input.db, null, 'BACKUP_CREATED', {
    sha256,
    keystores: keystores.length,
    recipients: input.recipients.length,
  });
  return { sha256, keystores: keystores.length };
}

export async function restoreShard(input: {
  db: Kysely<SignerDatabase>;
  shardId: string;
  keystoreDir: string;
  inFile: Buffer;
  identityFile: string;
}): Promise<{ keystores: number; rows: number }> {
  const parsed = BundleSchema.safeParse(
    JSON.parse(ageDecrypt(input.inFile, input.identityFile).toString('utf8')) as unknown,
  );
  if (!parsed.success) throw new LifecycleError('el backup no tiene el formato esperado');
  const bundle = parsed.data;
  if (bundle.shardId !== input.shardId) throw new LifecycleError(`el backup es del shard ${bundle.shardId}`);
  await migrateToLatest(input.db);
  if ((await new KeyRegistry(input.db, input.shardId).shard()) !== undefined) {
    throw new LifecycleError('la DB destino ya tiene el shard: el restore exige una DB vacía');
  }
  mkdirSync(input.keystoreDir, { recursive: true, mode: 0o700 });
  if (readdirSync(input.keystoreDir).length > 0)
    throw new LifecycleError('el directorio de keystores destino no está vacío');
  let rows = 0;
  await input.db.transaction().execute(async (trx) => {
    for (const table of BACKUP_TABLES) {
      const list = bundle.tables[table] ?? [];
      // Las tablas append-only rechazan sólo UPDATE/DELETE: el INSERT del restore está permitido.
      for (const row of list) {
        const columns = Object.keys(row);
        await sql`INSERT INTO ${sql.table(table)} (${sql.join(columns.map((c) => sql.ref(c)))}) VALUES (${sql.join(
          columns.map((c) => {
            const value = row[c];
            return value !== null && typeof value === 'object' && !(value instanceof Date)
              ? JSON.stringify(value)
              : value;
          }),
        )})`.execute(trx);
        rows++;
      }
      if (table === 'key_events' && list.length > 0) {
        await sql`SELECT setval('key_events_id_seq', (SELECT max(id) FROM key_events))`.execute(trx);
      }
    }
    await new KeyRegistry(input.db, input.shardId).event(trx, null, 'RESTORED_FROM_BACKUP', {
      keystores: bundle.keystores.length,
    });
  });
  const directory = new KeystoreDirectory(input.keystoreDir);
  for (const ks of bundle.keystores) {
    atomicWriteFile(directory.pathOf(ks.address), `${ks.content}\n`, { mode: 0o400 });
  }
  return { keystores: bundle.keystores.length, rows };
}
