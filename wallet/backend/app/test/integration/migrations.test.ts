// P08.T03: migraciones sobre PostgreSQL 18 real (roles de infra/local/postgres/init-db.sh). Verifica idempotencia,
// todas las tablas de [B-DB], FKs ON DELETE RESTRICT de [B-DB-FK], audit_events append-only, índices únicos parciales,
// CHECKs y GRANTs por rol.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest, migrationStatus, pendingMigrations } from '../../src/db/migrator.ts';
import { createTestDatabase, insertUser, type TestDatabase } from '../helpers/db.ts';

const addr = () => randomBytes(20);
const hash = () => randomBytes(32);
const sig = () => randomBytes(65);

async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const ALL_TABLES = [
  'audit_chain_lock',
  'audit_events',
  'chain_transactions',
  'gas_topups',
  'idempotency_keys',
  'integrity_status',
  'notifications',
  'opaque_records',
  'operation_groups',
  'operator_actions',
  'operator_users',
  'outbox_events',
  'platform_sessions',
  'policy_snapshots',
  'recovery_metadata',
  'rotation_requests',
  'security_challenges',
  'sessions',
  'signer_keys',
  'token_transfers',
  'totp_factors',
  'users',
  'wallet_keys_metadata',
  'wallet_operations',
  'wallets',
  'whitelist_requests',
  'whitelisted_destinations',
];

/** [B-DB-FK]: columna → tabla referenciada. */
const FOREIGN_KEYS: [string, string, string][] = [
  ['sessions', 'user_id', 'users'],
  ['platform_sessions', 'account_session_id', 'sessions'],
  ['platform_sessions', 'user_id', 'users'],
  ['platform_sessions', 'wallet_id', 'wallets'],
  ['opaque_records', 'user_id', 'users'],
  ['opaque_records', 'wallet_id', 'wallets'],
  ['totp_factors', 'user_id', 'users'],
  ['wallets', 'user_id', 'users'],
  ['wallet_keys_metadata', 'wallet_id', 'wallets'],
  ['recovery_metadata', 'wallet_id', 'wallets'],
  ['signer_keys', 'wallet_id', 'wallets'],
  ['security_challenges', 'user_id', 'users'],
  ['security_challenges', 'wallet_id', 'wallets'],
  ['whitelist_requests', 'wallet_id', 'wallets'],
  ['whitelist_requests', 'user_id', 'users'],
  ['whitelist_requests', 'challenge_id', 'security_challenges'],
  ['whitelist_requests', 'operation_id', 'wallet_operations'],
  ['whitelisted_destinations', 'wallet_id', 'wallets'],
  ['wallet_operations', 'user_id', 'users'],
  ['wallet_operations', 'wallet_id', 'wallets'],
  ['wallet_operations', 'platform_session_id', 'platform_sessions'],
  ['wallet_operations', 'two_factor_challenge_id', 'security_challenges'],
  ['wallet_operations', 'group_id', 'operation_groups'],
  ['chain_transactions', 'operation_id', 'wallet_operations'],
  ['chain_transactions', 'replaced_by_id', 'chain_transactions'],
  ['rotation_requests', 'wallet_id', 'wallets'],
  ['rotation_requests', 'propose_operation_id', 'wallet_operations'],
  ['rotation_requests', 'execute_operation_id', 'wallet_operations'],
  ['token_transfers', 'safe_address', 'wallets'],
  ['notifications', 'user_id', 'users'],
  ['notifications', 'wallet_id', 'wallets'],
  ['idempotency_keys', 'user_id', 'users'],
  ['gas_topups', 'tx_id', 'chain_transactions'],
  ['operator_actions', 'approver_1', 'operator_users'],
  ['operator_actions', 'approver_2', 'operator_users'],
];

describe('migraciones desde una base vacía', () => {
  let fresh: TestDatabase;
  beforeAll(async () => {
    fresh = await createTestDatabase({ migrated: false });
  });
  afterAll(async () => {
    await fresh.close();
  });

  it('aplica las migraciones en orden y es idempotente; mtw_app ve el estado sin DDL', async () => {
    expect(await pendingMigrations(fresh.app)).toEqual(['0001_initial_schema', '0002_account_preferences']);
    expect(await migrateToLatest(fresh.migrator)).toEqual(['0001_initial_schema', '0002_account_preferences']);
    expect(await migrateToLatest(fresh.migrator)).toEqual([]);
    const status = await migrationStatus(fresh.app);
    expect(status.known.every((m) => m.executedAt instanceof Date)).toBe(true);
    expect(status.newer).toEqual([]);
    expect(await pendingMigrations(fresh.app)).toEqual([]);
  });

  it('mtw_app no puede ejecutar DDL', async () => {
    expect(await sqlStateOf(sql`CREATE TABLE intruso (id int)`.execute(fresh.app))).toBe('42501');
  });
});

describe('esquema [B-DB]', () => {
  let db: TestDatabase;
  let userId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    userId = await insertUser(db.app);
  });
  afterAll(async () => {
    await db.close();
  });

  async function insertWallet(status = 'ACTIVE', owner = userId) {
    return db.app
      .insertInto('wallets')
      .values({
        user_id: owner,
        platform_id: 'mt-test',
        chain_id: 8453,
        status: status as 'ACTIVE',
        safe_address: status === 'CREATING' ? null : addr(),
      })
      .returning(['id', 'safe_address'])
      .executeTakeFirstOrThrow();
  }

  async function insertOperation(wallet: { id: string; safe_address: Buffer | null }, nonce: number, status: string) {
    const signed = status !== 'CREATED';
    return db.app
      .insertInto('wallet_operations')
      .values({
        user_id: userId,
        wallet_id: wallet.id,
        safe_address: wallet.safe_address ?? addr(),
        chain_id: 8453,
        safe_nonce: nonce,
        operation_type: 'SEND',
        safe_tx_hash: hash(),
        target: addr(),
        calldata: Buffer.from('a9059cbb', 'hex'),
        canonical_intent: JSON.stringify({ type: 'SEND' }),
        owner_signature: signed ? sig() : null,
        owner_role: signed ? 'U' : null,
        status: status as 'CREATED',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  it('crea todas las tablas del modelo de datos', async () => {
    const rows = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`.execute(
      db.app,
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual(ALL_TABLES);
  });

  it('cada FK de [B-DB-FK] existe con ON DELETE RESTRICT', async () => {
    const rows = await sql<{ table: string; column: string; referenced: string; on_delete: string }>`
      SELECT c.conrelid::regclass::text AS table, a.attname AS column, c.confrelid::regclass::text AS referenced,
             c.confdeltype AS on_delete
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`.execute(db.app);
    for (const [table, column, referenced] of FOREIGN_KEYS) {
      const fk = rows.rows.find((r) => r.table === table && r.column === column);
      expect(fk, `${table}.${column}`).toBeDefined();
      expect(fk?.referenced).toBe(referenced);
      expect(fk?.on_delete, `${table}.${column}`).toBe('r');
    }
    expect(rows.rows.every((r) => r.on_delete === 'r')).toBe(true);
  });

  it('audit_events es inmodificable por mtw_app (GRANT) y por su dueño (trigger)', async () => {
    const prev = Buffer.alloc(32);
    await sql`INSERT INTO audit_events (occurred_at, actor_type, event_type, prev_hash, entry_hash)
              VALUES (now(), 'SYSTEM', 'TEST_EVENT', ${prev}, ${hash()})`.execute(db.app);
    expect(await sqlStateOf(sql`UPDATE audit_events SET event_type = 'X_EVENT'`.execute(db.app))).toBe('42501');
    expect(await sqlStateOf(sql`DELETE FROM audit_events`.execute(db.app))).toBe('42501');
    expect(await sqlStateOf(sql`TRUNCATE audit_events`.execute(db.app))).toBe('42501');
    expect(await sqlStateOf(sql`UPDATE audit_events SET event_type = 'X_EVENT'`.execute(db.migrator))).toBe('42501');
    expect(await sqlStateOf(sql`DELETE FROM audit_events`.execute(db.migrator))).toBe('42501');
    expect(await sqlStateOf(sql`TRUNCATE audit_events`.execute(db.migrator))).toBe('42501');
    const count = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_events`.execute(db.app);
    expect(count.rows[0]?.n).toBe(1);
  });

  it('operator_actions es append-only y exige dos aprobadores distintos', async () => {
    const op = async () =>
      (
        await db.app
          .insertInto('operator_users')
          .values({
            email: `op${randomBytes(3).toString('hex')}@mtw.test`,
            display_name: 'Operador',
            totp_secret_ciphertext: randomBytes(32),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const [a, b] = [await op(), await op()];
    expect(
      await sqlStateOf(
        db.app
          .insertInto('operator_actions')
          .values({ action_type: 'MIGRATION_CASE_APPROVED', approver_1: a, approver_2: a })
          .execute(),
      ),
    ).toBe('23514');
    await db.app
      .insertInto('operator_actions')
      .values({ action_type: 'MIGRATION_CASE_APPROVED', approver_1: a, approver_2: b })
      .execute();
    expect(await sqlStateOf(sql`UPDATE operator_actions SET action_type = 'OTHER_ACTION'`.execute(db.app))).toBe(
      '42501',
    );
    expect(await sqlStateOf(sql`DELETE FROM operator_actions`.execute(db.migrator))).toBe('42501');
  });

  it('el índice parcial impide dos operaciones activas con el mismo nonce de la misma Safe', async () => {
    const wallet = await insertWallet('ACTIVE', await insertUser(db.app));
    await insertOperation(wallet, 7, 'USER_SIGNED');
    expect(await sqlStateOf(insertOperation(wallet, 7, 'QUEUED'))).toBe('23505');
    // Fuera del índice: CREATED (sin firmar) y estados terminales sin nonce consumido.
    await insertOperation(wallet, 7, 'CREATED');
    await insertOperation(wallet, 7, 'CANCELLED');
    await insertOperation(wallet, 8, 'QUEUED');
  });

  it('una operación firmada exige firma y rol; la firma tiene 65 bytes', async () => {
    const wallet = await insertWallet('ACTIVE', await insertUser(db.app));
    expect(
      await sqlStateOf(
        db.app
          .insertInto('wallet_operations')
          .values({
            user_id: userId,
            wallet_id: wallet.id,
            safe_address: wallet.safe_address ?? addr(),
            chain_id: 8453,
            safe_nonce: 1,
            operation_type: 'SEND',
            safe_tx_hash: hash(),
            target: addr(),
            calldata: Buffer.alloc(0),
            canonical_intent: '{}',
            status: 'QUEUED',
          })
          .execute(),
      ),
    ).toBe('23514');
    expect(
      await sqlStateOf(
        db.app
          .insertInto('wallet_operations')
          .values({
            user_id: userId,
            wallet_id: wallet.id,
            safe_address: wallet.safe_address ?? addr(),
            chain_id: 8453,
            safe_nonce: 1,
            operation_type: 'SEND',
            safe_tx_hash: hash(),
            target: addr(),
            calldata: Buffer.alloc(0),
            canonical_intent: '{}',
            owner_signature: randomBytes(64),
            owner_role: 'U',
            status: 'USER_SIGNED',
          })
          .execute(),
      ),
    ).toBe('23514');
  });

  it('wallet_keys_metadata impide claves duplicadas', async () => {
    const w1 = await insertWallet('ACTIVE', await insertUser(db.app));
    const w2 = await insertWallet('ACTIVE', await insertUser(db.app));
    const key = addr();
    const insertKey = (walletId: string, keyAddress: Buffer, status: string, role = 'U') =>
      db.app
        .insertInto('wallet_keys_metadata')
        .values({
          wallet_id: walletId,
          role: role as 'U',
          key_address: keyAddress,
          key_version: 1,
          status: status as 'ACTIVE',
          source: role === 'S' ? 'SIGNER_SHARD' : 'INTERNAL',
        })
        .execute();
    await insertKey(w1.id, key, 'ACTIVE');
    // La misma clave viva en otra wallet o en otro rol.
    expect(await sqlStateOf(insertKey(w2.id, key, 'ACTIVE'))).toBe('23505');
    expect(await sqlStateOf(insertKey(w2.id, key, 'PENDING', 'R'))).toBe('23505');
    // Dos U activas para la misma wallet.
    expect(await sqlStateOf(insertKey(w1.id, addr(), 'ACTIVE'))).toBe('23505');
    // Una clave rotada puede reaparecer y S siempre viene del signer.
    await insertKey(w2.id, addr(), 'ACTIVE', 'R');
    expect(await sqlStateOf(insertKey(w2.id, addr(), 'ACTIVE', 'S'))).toBeUndefined();
    expect(
      await sqlStateOf(
        db.app
          .insertInto('wallet_keys_metadata')
          .values({
            wallet_id: w2.id,
            role: 'U',
            key_address: addr(),
            key_version: 1,
            status: 'PENDING',
            source: 'SIGNER_SHARD',
          })
          .execute(),
      ),
    ).toBe('23514');
  });

  it('V1: una sola wallet viva por usuario', async () => {
    const owner = await insertUser(db.app);
    await insertWallet('CREATING', owner);
    expect(await sqlStateOf(insertWallet('CREATING', owner))).toBe('23505');
    await sql`UPDATE wallets SET status = 'FAILED' WHERE user_id = ${owner}`.execute(db.app);
    await insertWallet('CREATING', owner);
  });

  it('token_transfers admite el mismo log para dos Safes y lo rechaza duplicado para una', async () => {
    const a = await insertWallet('ACTIVE', await insertUser(db.app));
    const b = await insertWallet('ACTIVE', await insertUser(db.app));
    const txHash = hash();
    const transfer = (safe: Buffer, direction: 'IN' | 'OUT', counterparty: Buffer) =>
      db.app
        .insertInto('token_transfers')
        .values({
          chain_id: 8453,
          safe_address: safe,
          token: addr(),
          direction,
          counterparty,
          amount: '1000000',
          tx_hash: txHash,
          log_index: 3,
          block_number: 52_700_001,
          block_hash: hash(),
          status: 'MINED',
        })
        .execute();
    const safeA = a.safe_address ?? addr();
    const safeB = b.safe_address ?? addr();
    await transfer(safeA, 'OUT', safeB);
    await transfer(safeB, 'IN', safeA);
    expect(await sqlStateOf(transfer(safeA, 'OUT', safeB))).toBe('23505');
    // FK compuesta hacia wallets(chain_id, safe_address).
    expect(await sqlStateOf(transfer(addr(), 'IN', safeA))).toBe('23503');
  });

  it('PlatformSession: OPERATIONS sólo por OPAQUE y vida máxima de 15 minutos', async () => {
    const owner = await insertUser(db.app);
    const session = await db.app
      .insertInto('sessions')
      .values({
        user_id: owner,
        client: 'WALLET',
        token_hash: hash(),
        idle_expires_at: new Date(Date.now() + 30 * 60_000),
        absolute_expires_at: new Date(Date.now() + 12 * 3600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const insert = (scope: string, method: string, minutes: number) =>
      db.app
        .insertInto('platform_sessions')
        .values({
          account_session_id: session.id,
          user_id: owner,
          scope: scope as 'OPERATIONS',
          auth_method: method as 'OPAQUE_U',
          session_public_key_jwk: JSON.stringify({ kty: 'EC', crv: 'P-256' }),
          issued_at: new Date(),
          expires_at: new Date(Date.now() + minutes * 60_000),
        })
        .execute();
    expect(await sqlStateOf(insert('OPERATIONS', 'STEP_UP', 15))).toBe('23514');
    expect(await sqlStateOf(insert('ONBOARDING', 'STEP_UP', 16))).toBe('23514');
    expect(await sqlStateOf(insert('OPERATIONS', 'OPAQUE_U', 15))).toBeUndefined();
  });

  it('ON DELETE RESTRICT: no se borra un usuario con wallet', async () => {
    const owner = await insertUser(db.app);
    await insertWallet('CREATING', owner);
    // RESTRICT (no NO ACTION): restrict_violation, inmediato aunque la FK fuera diferible.
    expect(await sqlStateOf(sql`DELETE FROM users WHERE id = ${owner}`.execute(db.app))).toBe('23001');
  });

  it('updated_at se actualiza en cada UPDATE', async () => {
    const wallet = await insertWallet('CREATING', await insertUser(db.app));
    const before = await db.app
      .selectFrom('wallets')
      .select('updated_at')
      .where('id', '=', wallet.id)
      .executeTakeFirstOrThrow();
    await new Promise((r) => setTimeout(r, 20));
    await db.app.updateTable('wallets').set({ status: 'DEPLOYING' }).where('id', '=', wallet.id).execute();
    const after = await db.app
      .selectFrom('wallets')
      .select('updated_at')
      .where('id', '=', wallet.id)
      .executeTakeFirstOrThrow();
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('0002: preferencias de la cuenta con defaults y CHECK, editables por mtw_app y visibles para mtw_readonly', async () => {
    const id = await insertUser(db.app);
    const row = await db.app
      .selectFrom('users')
      .select(['locale', 'time_zone', 'last_failed_login_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ locale: 'es-AR', time_zone: 'UTC', last_failed_login_at: null });
    await db.app
      .updateTable('users')
      .set({ locale: 'en', time_zone: 'America/Buenos_Aires' })
      .where('id', '=', id)
      .execute();
    for (const locale of ['español', 'es_AR', 'ES-ar', '']) {
      expect(await sqlStateOf(db.app.updateTable('users').set({ locale }).where('id', '=', id).execute()), locale).toBe(
        '23514',
      );
    }
    expect(
      await sqlStateOf(
        db.app
          .updateTable('users')
          .set({ time_zone: 'x'.repeat(65) })
          .where('id', '=', id)
          .execute(),
      ),
    ).toBe('23514');
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE mtw_readonly');
      await db.admin.query('SELECT locale, time_zone, last_failed_login_at FROM users');
    } finally {
      await db.admin.query('ROLLBACK');
    }
  });

  it('mtw_readonly lee todo salvo hashes y secretos cifrados, y no escribe', async () => {
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE mtw_readonly');
      await db.admin.query('SELECT id, email, status FROM users');
      await db.admin.query('SELECT * FROM wallet_operations');
      await expect(db.admin.query('SAVEPOINT s1; SELECT password_hash FROM users')).rejects.toMatchObject({
        code: '42501',
      });
      await db.admin.query('ROLLBACK TO SAVEPOINT s1');
      await expect(db.admin.query('SAVEPOINT s2; SELECT * FROM totp_factors')).rejects.toMatchObject({ code: '42501' });
      await db.admin.query('ROLLBACK TO SAVEPOINT s2');
      await expect(db.admin.query('SAVEPOINT s3; DELETE FROM notifications')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.admin.query('ROLLBACK');
    }
  });
});
