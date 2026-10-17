// Política de acceso por rol [B-DB-ROLES], convergente: cada migración que crea tablas la vuelve a aplicar sobre todo
// el esquema, así el resultado no depende de los default privileges de la base (que sólo existen en local).
//
// - mtw_app: DML en todas las tablas; sólo SELECT/INSERT en las append-only (audit_events, operator_actions).
// - mtw_readonly: SELECT, excepto columnas con hashes de password o secretos cifrados.
// - Tablas del migrador (schema mtw_meta): sólo lectura, para que /health/ready verifique migraciones al día.
import { sql, type Kysely } from 'kysely';

export interface AccessPolicy {
  appendOnly: readonly string[];
  readonlyExcludedColumns: Readonly<Record<string, readonly string[]>>;
}

const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`identificador inválido: ${name}`);
  return `"${name}"`;
};

export async function grantStandardAccess(db: Kysely<unknown>, policy: AccessPolicy): Promise<void> {
  const exec = (statement: string) => sql.raw(statement).execute(db);
  const tables = (
    await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`.execute(db)
  ).rows.map((r) => r.table_name);

  await exec('GRANT USAGE ON SCHEMA public TO mtw_app, mtw_readonly');
  await exec('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mtw_app, mtw_readonly');
  await exec('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mtw_app, mtw_readonly');
  for (const table of tables) {
    const privileges = policy.appendOnly.includes(table) ? 'SELECT, INSERT' : 'SELECT, INSERT, UPDATE, DELETE';
    await exec(`GRANT ${privileges} ON ${ident(table)} TO mtw_app`);
    const excluded = policy.readonlyExcludedColumns[table];
    if (!excluded) {
      await exec(`GRANT SELECT ON ${ident(table)} TO mtw_readonly`);
      continue;
    }
    const columns = (
      await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
        ORDER BY ordinal_position`.execute(db)
    ).rows
      .map((r) => r.column_name)
      .filter((c) => !excluded.includes(c));
    if (columns.length > 0)
      await exec(`GRANT SELECT (${columns.map(ident).join(', ')}) ON ${ident(table)} TO mtw_readonly`);
  }
  await exec('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mtw_app');
  await exec('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO mtw_readonly');

  const meta = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'mtw_meta'`.execute(db);
  if ((meta.rows[0]?.n ?? 0) > 0) {
    await exec('GRANT USAGE ON SCHEMA mtw_meta TO mtw_app, mtw_readonly');
    await exec('GRANT SELECT ON ALL TABLES IN SCHEMA mtw_meta TO mtw_app, mtw_readonly');
  }
}
