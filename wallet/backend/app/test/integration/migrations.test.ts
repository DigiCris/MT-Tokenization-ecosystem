// P08.T03: migraciones sobre PostgreSQL 18 real (roles de infra/local/postgres/init-db.sh). Verifica idempotencia,
// todas las tablas de [B-DB], FKs ON DELETE RESTRICT de [B-DB-FK], audit_events append-only, índices únicos parciales,
// CHECKs y GRANTs por rol.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateToLatest, migrationStatus, pendingMigrations } from '../../src/db/migrator.ts';
import {
  createTestDatabase,
  insertPlatformSession,
  insertUser,
  signedEnvelopeColumns,
  type TestDatabase,
} from '../helpers/db.ts';

const addr = () => randomBytes(20);
const ALL_MIGRATIONS = [
  '0001_initial_schema',
  '0002_account_preferences',
  '0003_signer_key_attestation',
  '0004_wallet_onboarding',
  '0005_operation_pipeline',
];
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
  'chain_cursors',
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
  'safe_executions',
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
  ['wallet_operations', 'cancels_operation_id', 'wallet_operations'],
  ['safe_executions', 'operation_id', 'wallet_operations'],
  ['safe_executions', 'safe_address', 'wallets'],
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
    expect(await pendingMigrations(fresh.app)).toEqual(ALL_MIGRATIONS);
    expect(await migrateToLatest(fresh.migrator)).toEqual(ALL_MIGRATIONS);
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
    const signed = !['CREATED', 'EXPIRED', 'CANCELLED'].includes(status);
    const envelope = signed ? signedEnvelopeColumns(await insertPlatformSession(db.app, userId)) : {};
    return db.app
      .insertInto('wallet_operations')
      .values({
        ...envelope,
        expires_at: status === 'CREATED' ? new Date(Date.now() + 15 * 60_000) : null,
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
    // 0005: una firma aceptada sin el envelope verificado (firma de la session key, token y sesión) se rechaza.
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
            owner_signature: sig(),
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

  it('0003: atestación de la S en signer_keys (JWS compacto o null), visible para mtw_readonly', async () => {
    const wallet = await insertWallet('ACTIVE', await insertUser(db.app));
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const attestation = [
      part({ alg: 'EdDSA' }),
      part({ shardId: 'dev-1' }),
      randomBytes(64).toString('base64url'),
    ].join('.');
    const insertKey = (value: string | null) =>
      db.app
        .insertInto('signer_keys')
        .values({
          wallet_id: wallet.id,
          shard_id: 'dev-1',
          key_ref: randomBytes(8).toString('hex'),
          address: addr(),
          provider: 'selfhosted',
          status: 'PENDING',
          attestation: value,
        })
        .execute();
    expect(await sqlStateOf(insertKey(attestation))).toBeUndefined();
    expect(await sqlStateOf(insertKey(null))).toBeUndefined();
    for (const invalid of ['', 'a.b', 'a.b.c.d', 'a..c', 'a.b.c=', 'a.b.c d']) {
      expect(await sqlStateOf(insertKey(invalid)), invalid).toBe('23514');
    }
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE mtw_readonly');
      await db.admin.query('SELECT shard_id, address, attestation FROM signer_keys');
    } finally {
      await db.admin.query('ROLLBACK');
    }
  });

  it('0004: Safe esperada única por cadena; enrollment completo por estado y uno vivo por wallet y por R', async () => {
    const expected = addr();
    const w1 = await insertWallet('CREATING', await insertUser(db.app));
    const w2 = await insertWallet('CREATING', await insertUser(db.app));
    await db.app.updateTable('wallets').set({ expected_safe: expected }).where('id', '=', w1.id).execute();
    expect(
      await sqlStateOf(
        db.app.updateTable('wallets').set({ expected_safe: expected }).where('id', '=', w2.id).execute(),
      ),
    ).toBe('23505');
    expect(
      await sqlStateOf(
        db.app
          .updateTable('wallets')
          .set({ failure_reason: 'x'.repeat(201) })
          .where('id', '=', w1.id)
          .execute(),
      ),
    ).toBe('23514');

    const enrollment = (walletId: string, values: Record<string, unknown>) =>
      db.app
        .insertInto('recovery_metadata')
        .values({
          wallet_id: walletId,
          enrollment_id: randomUUID(),
          status: 'REQUESTED',
          expires_at: new Date(Date.now() + 60_000),
          nonce: hash(),
          ...values,
        })
        .execute();
    const r = addr();
    const submitted = {
      status: 'SUBMITTED',
      r_address: r,
      r_type: 'INTERNAL',
      enrollment_key_jwk: JSON.stringify({ kty: 'EC' }),
      enrollment_payload: JSON.stringify({}),
      enrollment_key_signature: randomBytes(64),
      r_proof_signature: sig(),
      submitted_at: new Date(),
    };
    // SUBMITTED sin la prueba de control, CONFIRMED sin la firma de U y EXTERNAL sin conector se rechazan.
    expect(await sqlStateOf(enrollment(w1.id, { ...submitted, r_proof_signature: null }))).toBe('23514');
    expect(await sqlStateOf(enrollment(w1.id, { ...submitted, status: 'CONFIRMED' }))).toBe('23514');
    expect(await sqlStateOf(enrollment(w1.id, { ...submitted, r_type: 'EXTERNAL' }))).toBe('23514');
    expect(await sqlStateOf(enrollment(w1.id, submitted))).toBeUndefined();
    // Otra inscripción viva para la misma wallet o la misma R en otra wallet: no.
    expect(await sqlStateOf(enrollment(w1.id, { ...submitted, r_address: addr() }))).toBe('23505');
    expect(await sqlStateOf(enrollment(w2.id, submitted))).toBe('23505');
    // Las REQUESTED no cuentan como vivas.
    expect(await sqlStateOf(enrollment(w1.id, {}))).toBeUndefined();
  });

  it('0005: vencimiento de CREATED, envelope completo, bloqueo por nonce, NoOp, deriva y ejecuciones indexadas', async () => {
    const owner = await insertUser(db.app);
    const wallet = await insertWallet('ACTIVE', owner);
    const base = {
      user_id: owner,
      wallet_id: wallet.id,
      safe_address: wallet.safe_address ?? addr(),
      chain_id: 8453,
      operation_type: 'SEND' as const,
      target: addr(),
      calldata: Buffer.alloc(0),
      canonical_intent: '{}',
    };
    const insert = (values: Record<string, unknown>) =>
      db.app
        .insertInto('wallet_operations')
        .values({ ...base, safe_nonce: 1, safe_tx_hash: hash(), status: 'CREATED', ...values })
        .returning('id')
        .executeTakeFirstOrThrow();
    // CREATED sin vencimiento.
    expect(await sqlStateOf(insert({ expires_at: null }))).toBe('23514');
    const created = await insert({ expires_at: new Date(Date.now() + 60_000) });
    // Sólo una NOOP_CANCEL nombra la operación que cancela.
    expect(await sqlStateOf(insert({ expires_at: new Date(), cancels_operation_id: created.id }))).toBe('23514');
    expect(
      await sqlStateOf(
        insert({ expires_at: new Date(), operation_type: 'NOOP_CANCEL', cancels_operation_id: created.id }),
      ),
    ).toBeUndefined();
    const envelope = signedEnvelopeColumns(await insertPlatformSession(db.app, owner, { walletId: wallet.id }));
    const signed = { ...envelope, owner_signature: sig(), owner_role: 'U' };
    // Firma del envelope: P-256 r‖s (64 bytes, base64url sin padding).
    expect(
      await sqlStateOf(insert({ ...signed, status: 'QUEUED', submission_envelope_signature: 'x'.repeat(85) })),
    ).toBe('23514');
    expect(await sqlStateOf(insert({ ...signed, status: 'QUEUED', platform_session_token: 'no-es-un-jws' }))).toBe(
      '23514',
    );
    // WAITING_LOWER_NONCE sólo mientras espera turno (QUEUED o FAILED_RETRYABLE).
    expect(
      await sqlStateOf(insert({ ...signed, safe_nonce: 2, status: 'READY', blocked_reason: 'WAITING_LOWER_NONCE' })),
    ).toBe('23514');
    expect(
      await sqlStateOf(insert({ ...signed, safe_nonce: 3, status: 'QUEUED', blocked_reason: 'WAITING_LOWER_NONCE' })),
    ).toBeUndefined();
    // SOVEREIGN_MODIFIED exige los ítems que difieren y cuándo se detectó.
    expect(
      await sqlStateOf(
        db.app.updateTable('wallets').set({ status: 'SOVEREIGN_MODIFIED' }).where('id', '=', wallet.id).execute(),
      ),
    ).toBe('23514');
    await db.app
      .updateTable('wallets')
      .set({ status: 'SOVEREIGN_MODIFIED', config_drift: JSON.stringify(['GUARD']), config_drift_at: new Date() })
      .where('id', '=', wallet.id)
      .execute();

    const execution = (values: Record<string, unknown>) =>
      db.app
        .insertInto('safe_executions')
        .values({
          chain_id: 8453,
          safe_address: wallet.safe_address ?? addr(),
          safe_nonce: 0,
          safe_tx_hash: hash(),
          success: true,
          origin: 'SOVEREIGN',
          target: addr(),
          value: 0,
          data: Buffer.alloc(0),
          operation: 0,
          sender: addr(),
          tx_hash: hash(),
          log_index: 0,
          block_number: 1,
          block_hash: hash(),
          status: 'MINED',
          ...values,
        })
        .execute();
    expect(await sqlStateOf(execution({}))).toBeUndefined();
    // Una ejecución de la plataforma siempre apunta a su operación; la Safe tiene que ser una wallet registrada.
    expect(await sqlStateOf(execution({ origin: 'PLATFORM' }))).toBe('23514');
    expect(await sqlStateOf(execution({ origin: 'PLATFORM', operation_id: created.id }))).toBeUndefined();
    expect(await sqlStateOf(execution({ safe_address: addr() }))).toBe('23503');
    const txHash = hash();
    await execution({ tx_hash: txHash, log_index: 4 });
    expect(await sqlStateOf(execution({ tx_hash: txHash, log_index: 4 }))).toBe('23505');

    // La misma SafeTx se puede volver a preparar si la anterior venció; dos vivas con el mismo hash, no.
    const sameHash = hash();
    expect(await sqlStateOf(insert({ safe_nonce: 9, safe_tx_hash: sameHash, status: 'EXPIRED' }))).toBeUndefined();
    expect(
      await sqlStateOf(insert({ safe_nonce: 9, safe_tx_hash: sameHash, expires_at: new Date(Date.now() + 60_000) })),
    ).toBeUndefined();
    expect(
      await sqlStateOf(insert({ safe_nonce: 9, safe_tx_hash: sameHash, expires_at: new Date(Date.now() + 60_000) })),
    ).toBe('23505');

    const cursor = (name: string) =>
      db.app.insertInto('chain_cursors').values({ name, block_number: 1, block_hash: hash() }).execute();
    expect(await sqlStateOf(cursor('safe-events'))).toBeUndefined();
    expect(await sqlStateOf(cursor('Safe Events'))).toBe('23514');
  });

  it('mtw_readonly lee todo salvo hashes y secretos cifrados, y no escribe', async () => {
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE mtw_readonly');
      await db.admin.query('SELECT id, email, status FROM users');
      await db.admin.query(
        'SELECT id, status, safe_nonce, owner_signature, submission_envelope FROM wallet_operations',
      );
      // El token de la PlatformSession y la atestación del challenge que acompañan a una firma no.
      await expect(
        db.admin.query('SAVEPOINT s0; SELECT platform_session_token FROM wallet_operations'),
      ).rejects.toMatchObject({ code: '42501' });
      await db.admin.query('ROLLBACK TO SAVEPOINT s0');
      await expect(
        db.admin.query('SAVEPOINT s0b; SELECT challenge_attestation FROM wallet_operations'),
      ).rejects.toMatchObject({ code: '42501' });
      await db.admin.query('ROLLBACK TO SAVEPOINT s0b');
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
