// [B-AUD] P08.T12 / P08.SEC: cadena HMAC verificable, detección de manipulación directa en la base (aun con
// privilegios de superusuario), payloads redactados, audit_events inmodificable por mtw_app y `audit:verify`.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter, GENESIS_HASH, verifyAuditChain } from '../../src/audit/audit-writer.ts';
import { Secret } from '../../src/config/secret.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const APP = resolve(import.meta.dirname, '../..');

let db: TestDatabase;
const keyBytes = randomBytes(32);
const key = new Secret(keyBytes);
const metrics = createMetrics({ defaultMetrics: false });
const writer = new AuditWriter(key, metrics);

const append = (eventType: string, payload: Record<string, unknown> = {}) =>
  withTransaction(
    db.app,
    (trx) => writer.append(trx, { actorType: 'USER', eventType, payload, ipPrefix: '203.0.113.0/24' }),
    {
      auditLock: true,
    },
  );

function runVerifyCli(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['src/cli/audit-verify.ts'], {
    cwd: APP,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      APP_ENV: 'local',
      MTW_ENV_FILE: '/dev/null',
      DATABASE_URL: db.appUrl,
      AUDIT_CHAIN_KEY: keyBytes.toString('base64'),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Superusuario con triggers desactivados: simula a alguien que manipula la base por fuera de la aplicación. */
async function tamper(statement: string, params: unknown[] = []): Promise<void> {
  await db.admin.query('BEGIN');
  await db.admin.query('SET LOCAL session_replication_role = replica');
  await db.admin.query(statement, params);
  await db.admin.query('COMMIT');
}

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe('cadena HMAC de auditoría', () => {
  it('encadena desde el génesis y verifica', async () => {
    expect(await verifyAuditChain(db.app, key)).toEqual({ ok: true, count: 0, headId: null, headHash: null });
    const first = await append('AUTH_LOGIN_SUCCEEDED', { method: 'password' });
    await append('PLATFORM_SESSION_ISSUED', { scope: 'OPERATIONS' });
    const last = await append('AUTH_LOGOUT');
    const rows = await db.app
      .selectFrom('audit_events')
      .select(['id', 'prev_hash', 'entry_hash'])
      .orderBy('id')
      .execute();
    expect(rows[0]?.prev_hash.equals(GENESIS_HASH)).toBe(true);
    expect(rows[1]?.prev_hash.equals(rows[0]?.entry_hash ?? Buffer.alloc(0))).toBe(true);
    expect(await verifyAuditChain(db.app, key)).toEqual({
      ok: true,
      count: 3,
      headId: last.id,
      headHash: last.entryHash,
    });
    expect(Number(first.id)).toBeLessThan(Number(last.id));
    const written = await metrics.registry.getSingleMetricAsString('mtw_audit_events_written_total');
    expect(written).toContain('event_type="AUTH_LOGOUT"');
  });

  it('pagina la verificación sin perder eslabones', async () => {
    for (let i = 0; i < 7; i++) await append('TEST_PAGINATION', { i });
    expect(await verifyAuditChain(db.app, key, { batchSize: 3 })).toMatchObject({ ok: true, count: 10 });
  });

  it('guarda el payload redactado y sin U+0000', async () => {
    const result = await append('AUTH_LOGIN_FAILED', {
      email: 'ana.perez@dominio.com',
      password: 'no-debe-guardarse',
      nested: { otp: '12345678' },
      note: 'con\u0000nul',
    });
    const row = await db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(row.payload).toEqual({
      email: 'a***@dominio.com',
      password: '[REDACTED]',
      nested: { otp: '[REDACTED]' },
      note: 'con�nul',
    });
    expect((await verifyAuditChain(db.app, key)).ok).toBe(true);
  });

  it('rechaza event_type fuera de formato', async () => {
    await expect(append('auth-login')).rejects.toThrow('event_type inválido');
  });

  it('audit_events es inmodificable por mtw_app', async () => {
    const state = async (statement: Promise<unknown>) => {
      try {
        await statement;
        return 'ok';
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(await state(sql`UPDATE audit_events SET payload = '{}'::jsonb`.execute(db.app))).toBe('42501');
    expect(await state(sql`DELETE FROM audit_events`.execute(db.app))).toBe('42501');
    expect(await state(sql`TRUNCATE audit_events`.execute(db.app))).toBe('42501');
  });

  it('audit:verify sale con 0 y no imprime contenido', () => {
    const result = runVerifyCli();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^AUDIT CHAIN OK: \d+ eventos, cabeza id \d+ \(0x[0-9a-f]{64}\)\n$/);
  });
});

describe('detección de manipulación', () => {
  it('un payload modificado rompe su eslabón (ENTRY_HASH_MISMATCH)', async () => {
    const target = await append('WHITELIST_REQUESTED', { destination: '0x1111111111111111111111111111111111111111' });
    await append('WHITELIST_CHALLENGE_PASSED');
    await tamper(
      `UPDATE audit_events SET payload = '{"destination":"0x2222222222222222222222222222222222222222"}' WHERE id = $1`,
      [target.id],
    );
    expect(await verifyAuditChain(db.app, key)).toMatchObject({
      ok: false,
      brokenAtId: target.id,
      reason: 'ENTRY_HASH_MISMATCH',
    });
    const cli = runVerifyCli();
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain(`id ${target.id} (ENTRY_HASH_MISMATCH)`);
    expect(cli.stderr + cli.stdout).not.toContain('0x2222');
  });

  it('borrar un evento rompe el eslabón siguiente (PREV_HASH_MISMATCH)', async () => {
    const fresh = await createTestDatabase();
    const local = new AuditWriter(key);
    const write = (eventType: string) =>
      withTransaction(fresh.app, (trx) => local.append(trx, { actorType: 'SYSTEM', eventType }), { auditLock: true });
    await write('ROTATION_PROPOSED');
    const middle = await write('ROTATION_CANCELLED');
    const next = await write('ROTATION_EXECUTED');
    await fresh.admin.query('BEGIN');
    await fresh.admin.query('SET LOCAL session_replication_role = replica');
    await fresh.admin.query('DELETE FROM audit_events WHERE id = $1', [middle.id]);
    await fresh.admin.query('COMMIT');
    expect(await verifyAuditChain(fresh.app, key)).toMatchObject({
      ok: false,
      brokenAtId: next.id,
      reason: 'PREV_HASH_MISMATCH',
    });
    await fresh.close();
  });

  it('otra clave no verifica la cadena', async () => {
    const result = await verifyAuditChain(db.app, new Secret(randomBytes(32)));
    expect(result).toMatchObject({ ok: false, reason: 'ENTRY_HASH_MISMATCH', count: 0 });
  });
});
