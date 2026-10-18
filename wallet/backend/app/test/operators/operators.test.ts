// Operadores y casos de migración excepcional en proceso (P15.T06, ADR-026), contra PostgreSQL real: alta con TOTP
// cifrado, autenticación con anti-replay, operador deshabilitado, apertura del caso, doble aprobación obligatoria
// (operator_actions append-only), MIGRATING, cancelación (antes y después de aprobar, con la Safe nueva en CREATING o
// ya desplegándose) y la auditoría de cada paso. El flujo completo con la CLI real y el fork lo prueba
// test/integration/migration.test.ts.
import { randomBytes } from 'node:crypto';
import { URI } from 'otpauth';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter } from '../../src/audit/audit-writer.ts';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import { EmailOutbox } from '../../src/email/email-outbox.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { OperatorError, OperatorService } from '../../src/operators/service.ts';
import { MigrationCases } from '../../src/recovery/migration.ts';
import { createVerifiedUser } from '../helpers/accounts.ts';
import { buildTestListener, type TestListener } from '../helpers/api.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

let db: TestDatabase;
let listener: TestListener;
let operators: OperatorService;
let cases: MigrationCases;
const metrics = createMetrics({ defaultMetrics: false });
// Reloj virtual del servicio de operadores: cada código de prueba avanza un paso TOTP (30 s), así el anti-replay es
// determinístico aunque las acciones ocurran en el mismo segundo.
let clock = Date.now();

beforeAll(async () => {
  db = await createTestDatabase();
  listener = await buildTestListener({ db, client: 'WALLET' });
  const config = listener.config;
  const audit = new AuditWriter(config.secrets.auditChainKey, metrics);
  operators = new OperatorService({
    db: db.app,
    fieldKey: config.secrets.fieldEncryptionKey,
    audit,
    now: () => clock,
  });
  cases = new MigrationCases({
    db: db.app,
    operators,
    audit,
    emails: new EmailOutbox(new OutboxRepository(db.app), config.secrets.fieldEncryptionKey),
    metrics,
  });
});

afterAll(async () => {
  await listener.close();
  await db.close();
});

interface Op {
  id: string;
  email: string;
  /** Código del paso siguiente del reloj virtual (cada acción, un paso nuevo). */
  next: () => string;
}

async function operator(label: string): Promise<Op> {
  const email = `${label}-${randomBytes(4).toString('hex')}@operators.test.invalid`;
  const added = await operators.add({ email, displayName: label });
  const totp = URI.parse(added.otpauthUri);
  return {
    id: added.operator.id,
    email,
    next: () => {
      clock += 30_000;
      return totp.generate({ timestamp: clock });
    },
  };
}

async function activeWallet(): Promise<{ walletId: string; userId: string }> {
  const user = await createVerifiedUser(listener, db);
  const row = await db.app
    .insertInto('wallets')
    .values({
      user_id: user.id,
      platform_id: listener.config.platformId,
      chain_id: 8453,
      status: 'ACTIVE',
      safe_address: randomBytes(20),
      activated_at: sql`now()`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { walletId: row.id, userId: user.id };
}

async function walletStatus(walletId: string): Promise<string> {
  return (await db.app.selectFrom('wallets').select('status').where('id', '=', walletId).executeTakeFirstOrThrow())
    .status;
}

describe('operadores', () => {
  it('alta con el secreto TOTP cifrado (nunca en claro) y sin duplicados; la URI es otpauth', async () => {
    const op = await operator('alta');
    const row = await db.app
      .selectFrom('operator_users')
      .select(['totp_secret_ciphertext', 'status'])
      .where('id', '=', op.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ACTIVE');
    expect(row.totp_secret_ciphertext.length).toBeGreaterThan(20);
    await expect(operators.add({ email: op.email.toUpperCase(), displayName: 'otro' })).rejects.toMatchObject({
      code: 'OPERATOR_EXISTS',
    });
  });

  it('autenticación: código válido una sola vez (anti-replay), inválido y desconocido se rechazan y se auditan', async () => {
    const op = await operator('auth');
    const code = op.next();
    expect((await operators.verify({ email: op.email, totp: code })).id).toBe(op.id);
    // El mismo código en el mismo paso: reutilizado.
    await expect(operators.verify({ email: op.email, totp: code })).rejects.toMatchObject({ code: 'TOTP_REPLAY' });
    await expect(operators.verify({ email: op.email, totp: '000000' })).rejects.toBeInstanceOf(OperatorError);
    await expect(operators.verify({ email: 'nadie@operators.test.invalid', totp: '123456' })).rejects.toMatchObject({
      code: 'OPERATOR_UNKNOWN',
    });
    const failures = await db.app
      .selectFrom('audit_events')
      .select('payload')
      .where('event_type', '=', 'OPERATOR_AUTH_FAILED')
      .where('actor_id', '=', op.id)
      .execute();
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it('un operador deshabilitado no actúa', async () => {
    const op = await operator('baja');
    await operators.disable(op.email);
    await expect(operators.verify({ email: op.email, totp: op.next() })).rejects.toMatchObject({
      code: 'OPERATOR_DISABLED',
    });
    await expect(operators.disable('nadie@operators.test.invalid')).rejects.toMatchObject({ code: 'OPERATOR_UNKNOWN' });
  });
});

describe('casos de migración', () => {
  it('doble aprobación obligatoria: el mismo operador no aprueba; otro sí → operator_actions, MIGRATING y aviso', async () => {
    const a = await operator('a');
    const b = await operator('b');
    const { walletId, userId } = await activeWallet();
    await expect(
      cases.request({ walletId, healthyRole: 'R', reason: 'corto', operator: { email: a.email, totp: a.next() } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const requested = await cases.request({
      walletId,
      healthyRole: 'R',
      reason: 'U comprometida: cancela cada rotación (ticket 42)',
      operator: { email: a.email, totp: a.next() },
    });
    expect(requested).toMatchObject({ status: 'REQUESTED', healthyRole: 'R', requestedBy: a.id, userId });
    await expect(
      cases.request({
        walletId,
        healthyRole: 'U',
        reason: 'segundo caso para la misma wallet',
        operator: { email: b.email, totp: b.next() },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      cases.approve({ caseId: requested.id, operator: { email: a.email, totp: a.next() } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await walletStatus(walletId)).toBe('ACTIVE');
    const approved = await cases.approve({ caseId: requested.id, operator: { email: b.email, totp: b.next() } });
    expect(approved.status).toBe('APPROVED');
    expect(await walletStatus(walletId)).toBe('MIGRATING');
    const action = await db.app
      .selectFrom('operator_actions')
      .selectAll()
      .where('id', '=', approved.approvalActionId ?? '')
      .executeTakeFirstOrThrow();
    expect(action).toMatchObject({ action_type: 'EXCEPTIONAL_MIGRATION', approver_1: a.id, approver_2: b.id });
    // operator_actions es append-only.
    await expect(
      db.app.updateTable('operator_actions').set({ action_type: 'OTHER' }).where('id', '=', action.id).execute(),
    ).rejects.toThrow();
    const notification = await db.app
      .selectFrom('notifications')
      .select('type')
      .where('wallet_id', '=', walletId)
      .where('type', '=', 'MIGRATION_APPROVED')
      .execute();
    expect(notification).toHaveLength(1);
    expect((await cases.view(requested.id)).status).toBe('APPROVED');
    const audit = await db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('wallet_id', '=', walletId)
      .orderBy('id')
      .execute();
    expect(audit.map((e) => e.event_type)).toEqual([
      'MIGRATION_CASE_REQUESTED',
      'OPERATOR_ACTION_RECORDED',
      'MIGRATION_CASE_APPROVED',
    ]);
    await expect(
      cases.approve({ caseId: requested.id, operator: { email: b.email, totp: b.next() } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('cancelación: antes de aprobar; aprobado sin Safe nueva → la vieja vuelve a ACTIVE; con la nueva en CREATING → ABANDONED', async () => {
    const a = await operator('c1');
    const b = await operator('c2');
    const first = await activeWallet();
    const requested = await cases.request({
      walletId: first.walletId,
      healthyRole: 'U',
      reason: 'R comprometida: cancela cada rotación',
      operator: { email: a.email, totp: a.next() },
    });
    expect((await cases.cancel({ caseId: requested.id, operator: { email: b.email, totp: b.next() } })).status).toBe(
      'CANCELLED',
    );
    expect(await walletStatus(first.walletId)).toBe('ACTIVE');
    await expect(
      cases.cancel({ caseId: requested.id, operator: { email: b.email, totp: b.next() } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const second = await activeWallet();
    const opened = await cases.request({
      walletId: second.walletId,
      healthyRole: 'U',
      reason: 'R comprometida: cancela cada rotación',
      operator: { email: a.email, totp: a.next() },
    });
    await cases.approve({ caseId: opened.id, operator: { email: b.email, totp: b.next() } });
    const fresh = await db.app
      .insertInto('wallets')
      .values({
        user_id: second.userId,
        platform_id: listener.config.platformId,
        chain_id: 8453,
        status: 'CREATING',
        migrated_from_wallet_id: second.walletId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.app.updateTable('migration_cases').set({ new_wallet_id: fresh.id }).where('id', '=', opened.id).execute();
    expect((await cases.cancel({ caseId: opened.id, operator: { email: a.email, totp: a.next() } })).status).toBe(
      'CANCELLED',
    );
    expect(await walletStatus(second.walletId)).toBe('ACTIVE');
    expect(await walletStatus(fresh.id)).toBe('ABANDONED');
  });

  it('con la Safe nueva ya desplegándose no se cancela; caso o wallet inexistentes → 404', async () => {
    const a = await operator('d1');
    const b = await operator('d2');
    const wallet = await activeWallet();
    const opened = await cases.request({
      walletId: wallet.walletId,
      healthyRole: 'R',
      reason: 'U comprometida: cancela cada rotación',
      operator: { email: a.email, totp: a.next() },
    });
    await cases.approve({ caseId: opened.id, operator: { email: b.email, totp: b.next() } });
    const fresh = await db.app
      .insertInto('wallets')
      .values({
        user_id: wallet.userId,
        platform_id: listener.config.platformId,
        chain_id: 8453,
        status: 'DEPLOYING',
        migrated_from_wallet_id: wallet.walletId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.app.updateTable('migration_cases').set({ new_wallet_id: fresh.id }).where('id', '=', opened.id).execute();
    await expect(
      cases.cancel({ caseId: opened.id, operator: { email: a.email, totp: a.next() } }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(cases.view(crypto.randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cases.view('no-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      cases.request({
        walletId: crypto.randomUUID(),
        healthyRole: 'U',
        reason: 'wallet inexistente para el caso',
        operator: { email: a.email, totp: a.next() },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
