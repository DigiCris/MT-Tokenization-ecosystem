// P09 (expand): preferencias no sensibles de la cuenta que usan los emails [B-MAIL-02] (hora local del usuario además
// de UTC) y que el usuario puede editar con PATCH /users/me. Columnas con default: una versión anterior de la
// aplicación sigue funcionando.
import { sql, type Kysely } from 'kysely';
import { ACCESS_POLICY, grantStandardAccess } from './grants.ts';

const STATEMENTS = [
  `ALTER TABLE users
     ADD COLUMN locale text NOT NULL DEFAULT 'es-AR' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
     ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64)`,
  // Último intento de login fallido (soporte y auditoría; los contadores de [B-AUTH-08] viven en Valkey).
  `ALTER TABLE users ADD COLUMN last_failed_login_at timestamptz`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
  await grantStandardAccess(db, ACCESS_POLICY);
}
