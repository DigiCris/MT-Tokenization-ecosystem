// P11 (expand): la SignerKeyAttestation que devuelve el shard al crear S [B-SIG-07] se guarda junto a la clave (la
// Wallet la verifica antes de que U firme la autorización de creación, P12.T03). Columna nullable: una versión
// anterior de la aplicación sigue funcionando.
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  `ALTER TABLE signer_keys
     ADD COLUMN attestation text CHECK (attestation IS NULL OR attestation ~ '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$')`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
