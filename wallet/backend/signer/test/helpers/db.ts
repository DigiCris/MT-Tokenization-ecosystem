// Base propia por archivo de test, clonada del template migrado del global setup, con el rol del signer.
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import { createSignerDb } from '../../src/state/db.ts';
import type { SignerDatabase } from '../../src/state/schema.ts';

export interface TestDatabase {
  db: Kysely<SignerDatabase>;
  url: string;
  name: string;
  /** Consulta como administrador (para inspeccionar volcados completos o simular corrupción). */
  admin: <T extends pg.QueryResultRow>(text: string, values?: unknown[]) => Promise<pg.QueryResult<T>>;
  close: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const info = inject('pg');
  const name = `signer_${randomBytes(6).toString('hex')}`;
  const adminDb = new pg.Client({
    host: info.host,
    port: info.port,
    user: info.adminUser,
    password: info.adminPassword,
    database: 'postgres',
  });
  await adminDb.connect();
  await adminDb.query(`CREATE DATABASE ${name} TEMPLATE mtw_signer_template OWNER mtw_signer`);
  await adminDb.end();
  const url = `postgres://mtw_signer:${info.signerPassword}@${info.host}:${info.port}/${name}`;
  const db = createSignerDb({ connectionString: url, applicationName: 'signer-test' });
  const admin = new pg.Pool({
    host: info.host,
    port: info.port,
    user: info.adminUser,
    password: info.adminPassword,
    database: name,
    max: 2,
  });
  return {
    db,
    url,
    name,
    admin: (text, values) => admin.query(text, values),
    close: async () => {
      await db.destroy();
      await admin.end();
    },
  };
}
