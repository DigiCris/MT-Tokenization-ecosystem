// P18 (expand): rotación de S pedida por la plataforma (P18.T09.b; playbooks de P26.T16). El operador deja un borrador
// DRAFT de la rotación de S con el motivo y la S′ ya creada por el signer; la propuesta la firma el usuario y toma ese
// borrador. Columna nullable: las filas existentes ya cumplen los constraints.
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  `ALTER TABLE rotation_requests ADD COLUMN request_reason text
     CHECK (request_reason IN ('SHARD_MIGRATION', 'HSM_MIGRATION', 'KEY_COMPROMISE', 'MAINTENANCE'))`,
  `ALTER TABLE rotation_requests ADD CONSTRAINT rotation_requests_reason_role
     CHECK (request_reason IS NULL OR role = 'S')`,
  // Un solo borrador de S pedido por la plataforma por wallet.
  `CREATE UNIQUE INDEX rotation_requests_s_draft_key ON rotation_requests (wallet_id)
     WHERE role = 'S' AND status = 'DRAFT'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
