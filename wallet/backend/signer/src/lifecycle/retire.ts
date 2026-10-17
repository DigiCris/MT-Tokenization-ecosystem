// Retiro y destrucción de claves S [B-SIG-08]: tras ejecutarse la rotación on-chain, la S vieja queda RETIRED (ya no
// firma) y su keystore se destruye a los 30 días si no quedan SafeTx activas firmadas por ella.
import { sql, type Kysely } from 'kysely';
import type { Address } from '../crypto/keccak.ts';
import { KeystoreDirectory } from '../keystore/keystore-dir.ts';
import { KeyRegistry } from '../state/key-registry.ts';
import type { SignerDatabase } from '../state/schema.ts';

export const RETENTION_DAYS = 30;

export async function retireKey(registry: KeyRegistry, keyRef: string, now = new Date()): Promise<Date> {
  const destroyAfter = new Date(now.getTime() + RETENTION_DAYS * 24 * 3600 * 1000);
  await registry.setStatus(
    keyRef,
    'RETIRED',
    'KEY_RETIRED',
    { destroyAfter: destroyAfter.toISOString() },
    { retiredAt: now, destroyAfter },
  );
  return destroyAfter;
}

export interface DestroyReport {
  destroyed: Address[];
  pending: { address: Address; reason: string }[];
}

export async function destroyRetired(input: {
  db: Kysely<SignerDatabase>;
  shardId: string;
  keystoreDir: string;
  now?: Date;
}): Promise<DestroyReport> {
  const now = input.now ?? new Date();
  const registry = new KeyRegistry(input.db, input.shardId);
  const directory = new KeystoreDirectory(input.keystoreDir);
  const report: DestroyReport = { destroyed: [], pending: [] };
  for (const key of await registry.list(['RETIRED'])) {
    if (key.destroyAfter === null || key.destroyAfter > now) {
      report.pending.push({ address: key.address, reason: 'retención de 30 días en curso' });
      continue;
    }
    const active = await input.db
      .selectFrom('signed_safe_txs')
      .select(sql<string>`count(*)`.as('n'))
      .where('executor', '=', key.address.toLowerCase())
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();
    if (Number(active.n) > 0) {
      report.pending.push({ address: key.address, reason: 'SafeTx activas firmadas por esta S' });
      continue;
    }
    if (directory.exists(key.address)) directory.remove(key.address);
    await registry.setStatus(key.keyRef, 'DESTROYED', 'KEY_DESTROYED', {}, { destroyedAt: now });
    report.destroyed.push(key.address);
  }
  return report;
}
