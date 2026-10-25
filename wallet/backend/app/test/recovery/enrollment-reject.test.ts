// P17.MAN (N10): la Wallet rechaza un enrollment de R que no pudo confirmar ([F-LNK-02]) — la comparación manual no
// coincidió, el enlace de regreso trae otra R o no lo armó la app Recovery del usuario —. El pedido queda REJECTED con
// el motivo, la R que había enviado Recovery deja de estar viva y, como puede ser una sustitución de R en el camino,
// quedan el evento de auditoría, la notificación in-app, el email de seguridad, el log de alerta y la métrica. Es
// idempotente, un pedido reemplazado (SUPERSEDED) toma el motivo si el aviso llega después (y conserva cuándo se lo
// reemplazó), y la ruta respeta [B-AUTHZ] (otro usuario → 404, sólo en el listener de Wallet, con la PlatformSession
// del pedido).
//
// Revisión de seguridad de ADR-033: el reemplazo de R se rechaza con la sesión OPERATIONS (ONBOARDING → 403) y no se
// rechaza con la rotación hacia su R′ ya en curso (409, auditado y con alerta); la propuesta de esa rotación vuelve a
// exigir el pedido SUBMITTED con lock; si una fila vieja quedó REJECTED con la rotación ejecutada on-chain, la
// sincronización la aplica igual (la cadena manda) en lugar de trabarse (regresión del ALTO 1); el email sale uno por
// ventana y usuario (los demás, en un resumen) y el aviso tardío de un pedido reemplazado hace mucho no alerta.
//
// Sin la cadena: el envío de R de Recovery (que lee el código de R por RPC) se reproduce en la base; el envío real y el
// rechazo después del alta de U están en test/recovery/enrollment.test.ts (fork).
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import type { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { platformTypedData } from '../../src/chain/eip712.ts';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { groupedAddress } from '../../src/email/format.ts';
import { addressToBuffer, bufferToAddress } from '../../src/lib/bytes.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import type { OperationService } from '../../src/operations/service.ts';
import { loadPolicySnapshot } from '../../src/policy/snapshot.ts';
import { ENROLLMENT_TTL_SECONDS, type EnrollmentView } from '../../src/recovery/enrollment.ts';
import { RejectionEmailDigest } from '../../src/recovery/rejection-digest.ts';
import { REJECTION_EMAIL_WINDOW_MS } from '../../src/recovery/rejection-email.ts';
import { RotationService } from '../../src/rotations/service.ts';
import { RotationSync } from '../../src/rotations/sync.ts';
import { SignerKeyService } from '../../src/signer-client/sharding.ts';
import { createVerifiedUser, type TestAccount } from '../helpers/accounts.ts';
import { buildTestListener, testRedis, unreachableRpc, type TestListener } from '../helpers/api.ts';
import type { TestClient } from '../helpers/client.ts';
import { testConfig } from '../helpers/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';
import { startEmailPipeline, type EmailPipeline } from '../helpers/email-pipeline.ts';
import { captureLogger } from '../helpers/logs.ts';
import { waitForMessage } from '../helpers/mailpit.ts';
import {
  critical,
  idempotencyKey,
  KDF_PARAMS,
  newUserKey,
  opaqueRecord,
  stepUp,
  type Session,
} from '../helpers/onboarding.ts';
import { actorFor } from '../helpers/operations.ts';
import { newAuthSecret, newSessionKey, registerOpaque, seedActiveWallet, unlockWallet } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { edKey, vectorSystem, writePolicySnapshot } from '../helpers/signer-shard.ts';

const logs = captureLogger('info');
let db: TestDatabase;
let redis: Redis;
let wallet: TestListener;
let recovery: TestListener;
let pipeline: EmailPipeline;
let snapshotDir: string;
let snapshot: ReturnType<typeof loadPolicySnapshot>;
let rpc: RpcQuorumClient;
let signerKeys: SignerKeyService;

const ZERO32: Hex = `0x${'0'.repeat(64)}`;
const addr = () => getAddress(privateKeyToAccount(generatePrivateKey()).address);

beforeAll(async () => {
  db = await createTestDatabase();
  redis = testRedis(REDIS_DBS.recoveryEnrollmentReject);
  await redis.flushdb();
  // Armar las rutas de wallets no toca la cadena: un RPC inalcanzable y el snapshot de los vectores alcanzan.
  snapshotDir = mkdtempSync(join(tmpdir(), 'mtw-enrollment-reject-'));
  const key = edKey();
  snapshot = loadPolicySnapshot(writePolicySnapshot(snapshotDir, key, vectorSystem()), key.publicKey, 'local');
  const config = testConfig({ RATE_LIMIT_GLOBAL_PER_MINUTE: '100000', PLATFORM_ID: snapshot.platformId });
  const metrics = createMetrics({ defaultMetrics: false });
  rpc = unreachableRpc(logs.logger, metrics);
  signerKeys = new SignerKeyService({
    db: db.app,
    shards: [{ id: 'dev-1', url: 'https://127.0.0.1:9', active: true }],
    clients: new Map(),
  });
  const common = {
    db,
    config,
    redis,
    rpc,
    onchain: { rpc, snapshot: () => snapshot },
    signerKeys,
    logger: logs.logger,
    metrics,
  };
  wallet = await buildTestListener({ ...common, client: 'WALLET' });
  recovery = await buildTestListener({ ...common, client: 'RECOVERY' });
  pipeline = await startEmailPipeline({
    db: db.app,
    redisDb: REDIS_DBS.recoveryEnrollmentReject,
    fieldKey: config.secrets.fieldEncryptionKey,
  });
});

afterAll(async () => {
  await pipeline.stop();
  await wallet.close();
  await recovery.close();
  await rpc.stop();
  await redis.quit();
  await db.close();
  rmSync(snapshotDir, { recursive: true, force: true });
});

interface Onboarding {
  account: TestAccount;
  browser: TestClient;
  recoveryBrowser: TestClient;
  onboarding: Session;
  walletId: string;
}

async function login(listener: TestListener, account: TestAccount): Promise<TestClient> {
  const client = listener.newClient();
  const response = await client.post('/api/v1/auth/login', { email: account.email, password: account.password });
  if (response.statusCode !== 200) throw new Error(`login: ${String(response.statusCode)} ${response.body}`);
  return client;
}

/** Cuenta con la wallet en CREATING y U registrada (lo que hace la Wallet antes de pedir el enrollment). */
async function withUserKey(): Promise<Onboarding> {
  const account = await createVerifiedUser(wallet, db);
  const browser = await login(wallet, account);
  const onboarding = await stepUp(browser, account.email, 'ONBOARDING');
  const created = await critical(browser, onboarding, '/wallets', {}, { idempotencyKey: idempotencyKey() });
  expect(created.statusCode, created.body).toBe(201);
  const walletId = created.json<{ id: string }>().id;
  const userKey = newUserKey();
  const registrationRecord = await opaqueRecord(browser, onboarding, walletId, userKey.authSecretHex);
  const registered = await critical(
    browser,
    onboarding,
    `/wallets/${walletId}/user-key`,
    {
      userKey: userKey.account.address,
      kdfParams: KDF_PARAMS,
      storageFlags: { drive: false, file: true, qr: false, words: true },
      registrationRecord,
    },
    { idempotencyKey: idempotencyKey() },
  );
  expect(registered.statusCode, registered.body).toBe(201);
  return { account, browser, recoveryBrowser: await login(recovery, account), onboarding, walletId };
}

async function requestEnrollment(o: { browser: TestClient; walletId: string }, session: Session): Promise<string> {
  const response = await critical(
    o.browser,
    session,
    `/wallets/${o.walletId}/recovery/enrollments`,
    {},
    { idempotencyKey: idempotencyKey() },
  );
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ enrollmentId: string }>().enrollmentId;
}

/** KeyAcceptance [W-01] de R′ (rol 2) para su wallet. */
async function keyAcceptance(account: PrivateKeyAccount, walletId: string, nonce: Hex) {
  const typed = platformTypedData(8453, snapshot.contracts.walletFactory, 'KeyAcceptance', {
    walletId,
    role: 2,
    newKey: account.address,
    nonce,
  });
  return { nonce, signature: await account.signTypedData(typed) };
}

/** Lo que deja en la base el envío de Recovery (P12: R con su prueba de control, verificado contra la cadena). */
async function submittedByRecovery(
  walletId: string,
  enrollmentId: string,
  options: { keyVersion?: number; replacement?: PrivateKeyAccount } = {},
): Promise<Address> {
  const r = options.replacement ? getAddress(options.replacement.address) : addr();
  const flags = JSON.stringify({ drive: false, file: true, qr: false, words: false });
  const row = await db.app
    .selectFrom('recovery_metadata')
    .select(['nonce'])
    .where('enrollment_id', '=', enrollmentId)
    .executeTakeFirstOrThrow();
  const acceptance =
    options.replacement && row.nonce !== null
      ? await keyAcceptance(options.replacement, walletId, `0x${row.nonce.toString('hex')}`)
      : null;
  await db.app
    .updateTable('recovery_metadata')
    .set({
      status: 'SUBMITTED',
      r_address: addressToBuffer(r),
      r_type: 'INTERNAL',
      enrollment_key_jwk: JSON.stringify(newSessionKey().jwk),
      enrollment_payload: JSON.stringify({ R: r }),
      enrollment_key_signature: randomBytes(64),
      r_proof_signature: randomBytes(65),
      storage_flags: flags,
      key_acceptance: acceptance === null ? null : JSON.stringify(acceptance),
      submitted_at: new Date(),
    })
    .where('enrollment_id', '=', enrollmentId)
    .execute();
  await db.app
    .insertInto('wallet_keys_metadata')
    .values({
      wallet_id: walletId,
      role: 'R',
      key_address: addressToBuffer(r),
      key_version: options.keyVersion ?? 1,
      status: 'PENDING',
      source: 'INTERNAL',
      storage_flags: flags,
    })
    .execute();
  return r;
}

function reject(o: { browser: TestClient }, session: Session, enrollmentId: string, reason: string) {
  return critical(o.browser, session, `/recovery/enrollments/${enrollmentId}/reject`, { reason });
}

async function auditEvents(enrollmentId: string, type = 'RECOVERY_ENROLLMENT_REJECTED') {
  return db.app
    .selectFrom('audit_events')
    .select(['event_type', 'payload'])
    .where('target_id', '=', enrollmentId)
    .where('event_type', '=', type)
    .execute();
}

async function notifications(userId: string) {
  return db.app
    .selectFrom('notifications')
    .select(['type', 'payload'])
    .where('user_id', '=', userId)
    .where('type', '=', 'RECOVERY_ENROLLMENT_REJECTED')
    .execute();
}

/** Emails pedidos al outbox para un destinatario y una plantilla (los parámetros van cifrados; el resto, no). */
async function emailRequests(to: string, template: string): Promise<number> {
  const rows = await db.app
    .selectFrom('outbox_events')
    .select('id')
    .where('event_type', '=', 'EMAIL_REQUESTED')
    .where(sql<boolean>`payload->>'to' = ${to}`)
    .where(sql<boolean>`payload->>'template' = ${template}`)
    .execute();
  return rows.length;
}

async function enrollmentRow(enrollmentId: string) {
  return db.app
    .selectFrom('recovery_metadata')
    .selectAll()
    .where('enrollment_id', '=', enrollmentId)
    .executeTakeFirstOrThrow();
}

async function rKeys(walletId: string) {
  return db.app
    .selectFrom('wallet_keys_metadata')
    .select(['id', 'key_address', 'status', 'deactivated_at'])
    .where('wallet_id', '=', walletId)
    .where('role', '=', 'R')
    .orderBy('key_version')
    .execute();
}

const alerts = (name: string, enrollmentId: string) =>
  logs.lines().filter((l) => l.alert === name && l.enrollmentId === enrollmentId);

const rejectionMetric = () =>
  wallet.metrics.registry.getSingleMetricAsString('mtw_recovery_enrollment_rejections_total');

describe('rechazo de un enrollment de R por la Wallet', () => {
  it('con R enviada: REJECTED con el motivo, R revocada, auditoría, aviso, email y alerta; repetirlo no duplica nada', async () => {
    const o = await withUserKey();
    const enrollmentId = await requestEnrollment(o, o.onboarding);
    const r = await submittedByRecovery(o.walletId, enrollmentId);

    const response = await reject(o, o.onboarding, enrollmentId, 'RETURN_LINK_KEY_MISMATCH');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<EnrollmentView>()).toMatchObject({
      id: enrollmentId,
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_KEY_MISMATCH',
      recoveryKey: r,
    });
    const row = await enrollmentRow(enrollmentId);
    expect(row).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'RETURN_LINK_KEY_MISMATCH',
      rejection_email: 'SENT',
    });
    expect(row.rejected_at).toBeInstanceOf(Date);
    expect(row.rejection_reported_at).toEqual(row.rejected_at);
    expect(row.rejection_emailed_at).toEqual(row.rejected_at);
    // La R que había enviado Recovery ya no está viva: no se puede incorporar ni reusar como pendiente.
    const [key] = await rKeys(o.walletId);
    expect(key?.status).toBe('REVOKED');
    expect(key?.deactivated_at).toBeInstanceOf(Date);

    const audit = await auditEvents(enrollmentId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      reason: 'RETURN_LINK_KEY_MISMATCH',
      purpose: 'ONBOARDING',
      previousStatus: 'SUBMITTED',
      recoveryKey: r,
      alerted: true,
      email: 'SENT',
    });
    const inbox = await notifications(o.account.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.payload).toMatchObject({ enrollmentId, reason: 'RETURN_LINK_KEY_MISMATCH', recoveryKey: r });
    const email = await waitForMessage(o.account.email, (m) => m.subject.includes('Posible sustitución de tu clave R'));
    expect(email.text).toContain('traía una dirección de clave R distinta de la que recibió la plataforma');
    expect(email.text).toContain(`Dirección que recibió la plataforma: ${groupedAddress(r)}`);
    expect(email.text).toContain('no va a usar para crear tu Safe ninguna dirección que haya llegado por él');
    expect(email.text).not.toMatch(/^Safe: /m);
    expect(await rejectionMetric()).toContain(
      'mtw_recovery_enrollment_rejections_total{reason="RETURN_LINK_KEY_MISMATCH",purpose="ONBOARDING",alerted="true"} 1',
    );
    expect(alerts('RECOVERY_KEY_SUBSTITUTION_SUSPECTED', enrollmentId)).toHaveLength(1);

    // Idempotente: otro aviso (aunque traiga otro motivo) devuelve el mismo estado sin repetir nada.
    const again = await reject(o, o.onboarding, enrollmentId, 'MANUAL_COMPARISON_FAILED');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_KEY_MISMATCH',
    });
    expect(await auditEvents(enrollmentId)).toHaveLength(1);
    expect(await notifications(o.account.id)).toHaveLength(1);
    expect(await emailRequests(o.account.email, 'recovery-enrollment-rejected')).toBe(1);
    expect(alerts('RECOVERY_KEY_SUBSTITUTION_SUSPECTED', enrollmentId)).toHaveLength(1);

    // Las dos apps ven el motivo; un pedido nuevo funciona y el rechazado conserva el suyo.
    for (const browser of [o.browser, o.recoveryBrowser]) {
      const current = await browser.get(`/api/v1/recovery/enrollments/${enrollmentId}`);
      expect(current.json<EnrollmentView>()).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'RETURN_LINK_KEY_MISMATCH',
      });
    }
    const next = await requestEnrollment(o, o.onboarding);
    expect((await o.browser.get(`/api/v1/recovery/enrollments/${next}`)).json<EnrollmentView>()).toMatchObject({
      status: 'REQUESTED',
      rejectionReason: null,
    });
    expect(
      (await o.browser.get(`/api/v1/recovery/enrollments/${enrollmentId}`)).json<EnrollmentView>().rejectionReason,
    ).toBe('RETURN_LINK_KEY_MISMATCH');
  });

  it('uno reemplazado toma el motivo del aviso tardío y conserva cuándo se lo reemplazó; un email por ventana y el resto en el resumen', async () => {
    const o = await withUserKey();
    const first = await requestEnrollment(o, o.onboarding);
    const second = await requestEnrollment(o, o.onboarding);
    // Pedir otro reemplaza al anterior.
    expect((await o.browser.get(`/api/v1/recovery/enrollments/${first}`)).json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'SUPERSEDED',
    });
    const superseded = await enrollmentRow(first);
    expect(superseded.rejected_at).toBeInstanceOf(Date);
    expect(superseded.rejection_reported_at).toBeNull();
    expect(await auditEvents(first)).toHaveLength(0);

    // El aviso del aborto del primero llega después de pedir el segundo: el motivo y la alerta no se pierden, y el
    // momento del reemplazo se conserva (el del aviso queda aparte).
    const late = await reject(o, o.onboarding, first, 'RETURN_LINK_UNVERIFIED');
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_UNVERIFIED',
    });
    const reported = await enrollmentRow(first);
    expect(reported.rejected_at).toEqual(superseded.rejected_at);
    expect(reported.rejection_reported_at?.getTime()).toBeGreaterThanOrEqual(superseded.rejected_at?.getTime() ?? 0);
    expect(reported.rejection_email).toBe('SENT');
    expect((await auditEvents(first))[0]?.payload).toMatchObject({ previousStatus: 'REJECTED', recoveryKey: null });
    expect(alerts('RECOVERY_KEY_SUBSTITUTION_SUSPECTED', first)).toHaveLength(1);
    await waitForMessage(
      o.account.email,
      (m) =>
        m.subject.includes('Posible sustitución de tu clave R') &&
        m.text.includes('Motivo: enlace de regreso que no armó tu app Recovery'),
    );

    // El segundo, todavía sin R: el aborto vale igual, con su aviso in-app y su alerta, pero el email queda para el
    // resumen de la ventana (ya salió uno en esta hora).
    const manual = await reject(o, o.onboarding, second, 'MANUAL_COMPARISON_FAILED');
    expect(manual.statusCode, manual.body).toBe(200);
    expect(manual.json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'MANUAL_COMPARISON_FAILED',
      recoveryKey: null,
    });
    expect(await notifications(o.account.id)).toHaveLength(2);
    expect(alerts('RECOVERY_KEY_SUBSTITUTION_SUSPECTED', second)).toHaveLength(1);
    expect((await enrollmentRow(second)).rejection_email).toBe('HELD');
    expect((await auditEvents(second))[0]?.payload).toMatchObject({ alerted: true, email: 'HELD' });
    expect(await emailRequests(o.account.email, 'recovery-enrollment-rejected')).toBe(1);
    expect(await wallet.metrics.registry.getSingleMetricAsString('mtw_emails_skipped_total')).toContain(
      'mtw_emails_skipped_total{template="recovery-enrollment-rejected",reason="held_for_summary"}',
    );

    // Con la ventana abierta el resumen no sale; al cerrarse, uno solo con lo retenido, y abre una ventana nueva.
    const digest = (offsetMs: number) =>
      new RejectionEmailDigest({
        db: db.app,
        emails: wallet.services.emails,
        logger: logs.logger,
        now: () => Date.now() + offsetMs,
      });
    expect(await digest(0).runOnce()).toBe(0);
    expect((await enrollmentRow(second)).rejection_email).toBe('HELD');
    expect(await digest(REJECTION_EMAIL_WINDOW_MS + 60_000).runOnce()).toBe(1);
    const summarized = await enrollmentRow(second);
    expect(summarized.rejection_email).toBe('SUMMARIZED');
    expect(summarized.rejection_emailed_at).toBeInstanceOf(Date);
    const summary = await waitForMessage(o.account.email, (m) =>
      m.subject.includes('Más pedidos de tu clave R cancelados'),
    );
    expect(summary.text).toContain('Pedidos cancelados: 1');
    expect(summary.text).toContain('Motivos: la dirección copiada de la app Recovery no coincidió');
    expect(summary.text).not.toMatch(/^Safe: /m);
    expect(await digest(REJECTION_EMAIL_WINDOW_MS + 60_000).runOnce()).toBe(0);
    expect(await emailRequests(o.account.email, 'recovery-enrollment-rejections-summary')).toBe(1);
  });

  it('aviso tardío de un pedido reemplazado hace más que su vigencia, o rechazado antes de 0009: auditoría y métrica, sin aviso ni alerta', async () => {
    const o = await withUserKey();
    const old = await requestEnrollment(o, o.onboarding);
    const legacy = await requestEnrollment(o, o.onboarding);
    await requestEnrollment(o, o.onboarding);
    // Reemplazado hace más de 15 minutos.
    const supersededAt = new Date(Date.now() - (ENROLLMENT_TTL_SECONDS + 60) * 1000);
    await db.app
      .updateTable('recovery_metadata')
      .set({ rejected_at: supersededAt })
      .where('enrollment_id', '=', old)
      .execute();
    // Una fila REJECTED de antes de 0009: sin motivo ni momento.
    await db.app
      .updateTable('recovery_metadata')
      .set({ rejection_reason: null, rejected_at: null })
      .where('enrollment_id', '=', legacy)
      .execute();

    for (const [enrollmentId, reason] of [
      [old, 'RETURN_LINK_UNVERIFIED'],
      [legacy, 'MANUAL_COMPARISON_FAILED'],
    ] as const) {
      const response = await reject(o, o.onboarding, enrollmentId, reason);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<EnrollmentView>()).toMatchObject({ status: 'REJECTED', rejectionReason: reason });
      expect((await auditEvents(enrollmentId))[0]?.payload).toMatchObject({ reason, alerted: false, email: 'NONE' });
      expect(alerts('RECOVERY_KEY_SUBSTITUTION_SUSPECTED', enrollmentId)).toHaveLength(0);
      // Idempotente también acá.
      expect((await reject(o, o.onboarding, enrollmentId, reason)).statusCode).toBe(200);
      expect(await auditEvents(enrollmentId)).toHaveLength(1);
    }
    expect((await enrollmentRow(old)).rejected_at).toEqual(supersededAt);
    expect((await enrollmentRow(legacy)).rejected_at).toBeNull();
    expect(await notifications(o.account.id)).toHaveLength(0);
    expect(await emailRequests(o.account.email, 'recovery-enrollment-rejected')).toBe(0);
    const metric = await rejectionMetric();
    expect(metric).toContain('{reason="RETURN_LINK_UNVERIFIED",purpose="ONBOARDING",alerted="false"} 1');
    expect(metric).toContain('{reason="MANUAL_COMPARISON_FAILED",purpose="ONBOARDING",alerted="false"} 1');
  });

  it('el aviso tardío de un pedido reemplazado no toca el pedido vivo (su R pendiente y la Safe esperada)', async () => {
    const o = await withUserKey();
    const a = await requestEnrollment(o, o.onboarding);
    await submittedByRecovery(o.walletId, a);
    const b = await requestEnrollment(o, o.onboarding);
    // Pedir B revocó la R de A; B recibe la suya y la wallet ya tiene la Safe esperada calculada con ella.
    const rB = await submittedByRecovery(o.walletId, b);
    const expectedSafe = randomBytes(20);
    await db.app
      .updateTable('wallets')
      .set({ expected_safe: expectedSafe, config_hash: randomBytes(32), salt_nonce: '7' })
      .where('id', '=', o.walletId)
      .execute();

    const late = await reject(o, o.onboarding, a, 'RETURN_LINK_KEY_MISMATCH');
    expect(late.statusCode, late.body).toBe(200);
    expect((await enrollmentRow(b)).status).toBe('SUBMITTED');
    const keys = await rKeys(o.walletId);
    expect(keys.find((k) => bufferToAddress(k.key_address) === rB)?.status).toBe('PENDING');
    const walletRow = await db.app
      .selectFrom('wallets')
      .select(['expected_safe', 'config_hash'])
      .where('id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    expect(walletRow.expected_safe).toEqual(expectedSafe);
    expect(walletRow.config_hash).not.toBeNull();
  });

  it('rechazado después de asignar S (POST /wallets/{id}/executor): la Safe esperada se descarta e incorporate da 409', async () => {
    const o = await withUserKey();
    const enrollmentId = await requestEnrollment(o, o.onboarding);
    const r = await submittedByRecovery(o.walletId, enrollmentId);
    // Lo que deja la asignación de S: la Safe esperada y su config hash, calculados con esta R.
    await db.app
      .updateTable('wallets')
      .set({ expected_safe: randomBytes(20), config_hash: randomBytes(32), salt_nonce: '11' })
      .where('id', '=', o.walletId)
      .execute();

    expect((await reject(o, o.onboarding, enrollmentId, 'MANUAL_COMPARISON_FAILED')).statusCode).toBe(200);
    const walletRow = await db.app
      .selectFrom('wallets')
      .select(['expected_safe', 'config_hash'])
      .where('id', '=', o.walletId)
      .executeTakeFirstOrThrow();
    expect(walletRow).toEqual({ expected_safe: null, config_hash: null });
    const incorporate = await critical(o.browser, o.onboarding, `/recovery/enrollments/${enrollmentId}/incorporate`, {
      authorization: {
        userId: o.account.id,
        platformId: snapshot.platformId,
        walletId: o.walletId,
        userKey: addr(),
        recoveryKey: r,
        executor: addr(),
        saltNonce: '11',
        expectedSafe: addr(),
        enrollmentNonce: ZERO32,
      },
      signature: `0x${'11'.repeat(65)}`,
    });
    expect(incorporate.statusCode, incorporate.body).toBe(409);
  });

  it('un pedido vencido sin R también se rechaza (estado previo EXPIRED)', async () => {
    const o = await withUserKey();
    const enrollmentId = await requestEnrollment(o, o.onboarding);
    await db.app
      .updateTable('recovery_metadata')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('enrollment_id', '=', enrollmentId)
      .execute();
    expect((await o.browser.get(`/api/v1/recovery/enrollments/${enrollmentId}`)).json<EnrollmentView>().status).toBe(
      'EXPIRED',
    );
    const response = await reject(o, o.onboarding, enrollmentId, 'RETURN_LINK_UNVERIFIED');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_UNVERIFIED',
    });
    expect((await auditEvents(enrollmentId))[0]?.payload).toMatchObject({ previousStatus: 'EXPIRED', alerted: true });
  });

  it('[B-AUTHZ]: otro usuario → 404; Recovery no la expone; sin PlatformSession → 403; motivo inválido → 400; CONFIRMED y RETIRED → 409', async () => {
    const o = await withUserKey();
    const enrollmentId = await requestEnrollment(o, o.onboarding);

    // Otro usuario, con su propia sesión ONBOARDING: el pedido de A no existe para él.
    const other = await withUserKey();
    const foreign = await critical(other.browser, other.onboarding, `/recovery/enrollments/${enrollmentId}/reject`, {
      reason: 'MANUAL_COMPARISON_FAILED',
    });
    expect(foreign.statusCode).toBe(404);
    expect((await reject(o, o.onboarding, randomUUID(), 'MANUAL_COMPARISON_FAILED')).statusCode).toBe(404);
    // Sólo el listener de Wallet: en el de Recovery la ruta no existe.
    const fromRecovery = await o.recoveryBrowser.post(`/api/v1/recovery/enrollments/${enrollmentId}/reject`, {
      reason: 'MANUAL_COMPARISON_FAILED',
    });
    expect(fromRecovery.statusCode).toBe(404);
    // Sin la PlatformSession del pedido (request crítico sin firmar).
    const unsigned = await o.browser.post(`/api/v1/recovery/enrollments/${enrollmentId}/reject`, {
      reason: 'MANUAL_COMPARISON_FAILED',
    });
    expect(unsigned.statusCode).toBe(403);
    expect((await reject(o, o.onboarding, enrollmentId, 'OTRO')).statusCode).toBe(400);
    expect((await reject(o, o.onboarding, enrollmentId, 'SUPERSEDED')).statusCode).toBe(400);
    expect(await auditEvents(enrollmentId)).toHaveLength(0);

    // Un pedido que U ya incorporó no se rechaza, ni uno ya retirado.
    await submittedByRecovery(o.walletId, enrollmentId);
    await db.app
      .updateTable('recovery_metadata')
      .set({ status: 'CONFIRMED', u_incorporation_signature: randomBytes(65), confirmed_at: new Date() })
      .where('enrollment_id', '=', enrollmentId)
      .execute();
    expect((await reject(o, o.onboarding, enrollmentId, 'MANUAL_COMPARISON_FAILED')).statusCode).toBe(409);
    await db.app
      .updateTable('recovery_metadata')
      .set({ status: 'RETIRED', retired_at: new Date() })
      .where('enrollment_id', '=', enrollmentId)
      .execute();
    expect((await reject(o, o.onboarding, enrollmentId, 'RETURN_LINK_UNVERIFIED')).statusCode).toBe(409);
    expect(await auditEvents(enrollmentId)).toHaveLength(0);
  });
});

/** Wallet ACTIVE con su Safe, desbloqueada (OPERATIONS) y con una sesión ONBOARDING de cuando estaba en creación. */
interface ActiveOwner {
  account: TestAccount;
  browser: TestClient;
  walletId: string;
  safe: Address;
  onboarding: Session;
  operations: Session;
  unlocked: Awaited<ReturnType<typeof unlockWallet>>;
}

async function activeOwner(): Promise<ActiveOwner> {
  const account = await createVerifiedUser(wallet, db);
  const browser = await login(wallet, account);
  // La sesión ONBOARDING se emite mientras la wallet no está activa; queda viva cuando la wallet ya lo está.
  const onboarding = await stepUp(browser, account.email, 'ONBOARDING');
  const { walletId, safe } = await seedActiveWallet(db, { userId: account.id, platformId: snapshot.platformId });
  if (safe === null) throw new Error('wallet sin Safe');
  const authSecretHex = newAuthSecret();
  await registerOpaque(wallet, db, { userId: account.id, walletId, authSecretHex });
  const unlocked = await unlockWallet(browser, authSecretHex);
  const operations: Session = {
    token: unlocked.token,
    sessionId: unlocked.sessionId,
    key: unlocked.key,
    walletId: unlocked.session.walletId,
  };
  return { account, browser, walletId, safe, onboarding, operations, unlocked };
}

/** La rotación de R que armó la plataforma con este pedido, propuesta on-chain (PENDING_TIMELOCK). */
async function proposedRotation(owner: ActiveOwner, enrollmentId: string, newKey: Address, oldKey = addr()) {
  const enrollment = await enrollmentRow(enrollmentId);
  const proposalId = randomBytes(32);
  const row = await db.app
    .insertInto('rotation_requests')
    .values({
      wallet_id: owner.walletId,
      role: 'R',
      old_key: addressToBuffer(oldKey),
      new_key: addressToBuffer(newKey),
      initiated_by: 'U',
      status: 'PENDING_TIMELOCK',
      proposal_id: proposalId,
      executable_at: new Date(Date.now() + 48 * 3600_000),
      enrollment_id: enrollment.id,
      key_acceptance: enrollment.key_acceptance === null ? null : JSON.stringify(enrollment.key_acceptance),
      timelock: addressToBuffer(snapshot.contracts.rotationTimelock),
      proposed_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { rotationId: row.id, proposalId };
}

describe('rechazo del reemplazo de R (perdí R)', () => {
  it('con la sesión OPERATIONS: REJECTED, R′ revocada, email con la Safe; con la sesión ONBOARDING → 403', async () => {
    const owner = await activeOwner();
    const enrollmentId = await requestEnrollment(owner, owner.operations);
    expect((await enrollmentRow(enrollmentId)).purpose).toBe('REPLACEMENT');
    const rPrime = await submittedByRecovery(owner.walletId, enrollmentId, {
      replacement: privateKeyToAccount(generatePrivateKey()),
    });

    const withOnboarding = await reject(owner, owner.onboarding, enrollmentId, 'MANUAL_COMPARISON_FAILED');
    expect(withOnboarding.statusCode, withOnboarding.body).toBe(403);
    expect((await enrollmentRow(enrollmentId)).status).toBe('SUBMITTED');

    const response = await reject(owner, owner.operations, enrollmentId, 'MANUAL_COMPARISON_FAILED');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      purpose: 'REPLACEMENT',
      rejectionReason: 'MANUAL_COMPARISON_FAILED',
      recoveryKey: rPrime,
    });
    expect((await rKeys(owner.walletId)).map((k) => k.status)).toEqual(['REVOKED']);
    expect((await auditEvents(enrollmentId))[0]?.payload).toMatchObject({
      purpose: 'REPLACEMENT',
      previousStatus: 'SUBMITTED',
      recoveryKey: rPrime,
    });
    const email = await waitForMessage(owner.account.email, (m) =>
      m.subject.includes('Posible sustitución de tu clave R'),
    );
    expect(email.text).toContain('Acción: Cancelación del reemplazo de tu clave de recuperación (R)');
    expect(email.text).toContain(`Safe: ${groupedAddress(owner.safe)}`);
    expect(email.text).toContain('Si te llega un aviso de una rotación de tu clave R que no esperabas, cancelala');
    expect(await rejectionMetric()).toContain(
      '{reason="MANUAL_COMPARISON_FAILED",purpose="REPLACEMENT",alerted="true"} 1',
    );
  });

  it('con la rotación hacia R′ en curso no se rechaza (409, auditado y con alerta); si una fila vieja quedó REJECTED, la ejecución on-chain se aplica igual', async () => {
    const owner = await activeOwner();
    const enrollmentId = await requestEnrollment(owner, owner.operations);
    const rPrime = await submittedByRecovery(owner.walletId, enrollmentId, {
      replacement: privateKeyToAccount(generatePrivateKey()),
    });
    const { rotationId, proposalId } = await proposedRotation(owner, enrollmentId, rPrime);

    const refused = await reject(owner, owner.operations, enrollmentId, 'RETURN_LINK_KEY_MISMATCH');
    expect(refused.statusCode, refused.body).toBe(409);
    expect((await enrollmentRow(enrollmentId)).status).toBe('SUBMITTED');
    expect((await rKeys(owner.walletId)).map((k) => k.status)).toEqual(['PENDING']);
    expect(await auditEvents(enrollmentId)).toHaveLength(0);
    expect((await auditEvents(enrollmentId, 'RECOVERY_ENROLLMENT_REJECTION_REFUSED'))[0]?.payload).toMatchObject({
      reason: 'RETURN_LINK_KEY_MISMATCH',
      rotationId,
      rotationStatus: 'PENDING_TIMELOCK',
      recoveryKey: rPrime,
    });
    expect(
      logs.lines().filter((l) => l.alert === 'RECOVERY_KEY_SUBSTITUTION_SUSPECTED' && l.rotationId === rotationId),
    ).toHaveLength(1);

    // Regresión del ALTO 1: una fila que quedó REJECTED con la rotación ya propuesta (antes de esta corrección, o una
    // carrera) y la R′ revocada. A las 48 h la rotación se ejecuta on-chain: la sincronización la aplica igual (la
    // cadena manda: el pedido queda CONFIRMED sin el motivo y R′ vuelve a estar viva), con la alerta, y no se traba.
    await db.app
      .updateTable('recovery_metadata')
      .set({ status: 'REJECTED', rejection_reason: 'RETURN_LINK_KEY_MISMATCH', rejected_at: new Date() })
      .where('enrollment_id', '=', enrollmentId)
      .execute();
    await db.app
      .updateTable('wallet_keys_metadata')
      .set({ status: 'REVOKED', deactivated_at: new Date() })
      .where('wallet_id', '=', owner.walletId)
      .where('role', '=', 'R')
      .execute();
    const [revoked] = await rKeys(owner.walletId);
    await db.app
      .insertInto('rotation_events')
      .values({
        chain_id: 8453,
        safe_address: addressToBuffer(owner.safe),
        timelock: addressToBuffer(snapshot.contracts.rotationTimelock),
        proposal_id: proposalId,
        kind: 'EXECUTED',
        tx_hash: randomBytes(32),
        log_index: 0,
        block_number: 9_000_000,
        block_hash: randomBytes(32),
        status: 'CONFIRMED',
      })
      .execute();
    const sync = new RotationSync({
      db: db.app,
      rpc,
      audit: wallet.services.audit,
      emails: null,
      snapshot: () => snapshot,
      logger: logs.logger,
      metrics: wallet.metrics,
    });
    const result = await sync.runOnce();
    expect(result).toMatchObject({ applied: 1, quarantined: 0 });
    const rotation = await db.app
      .selectFrom('rotation_requests')
      .select(['status'])
      .where('id', '=', rotationId)
      .executeTakeFirstOrThrow();
    expect(rotation.status).toBe('EXECUTED');
    expect(await enrollmentRow(enrollmentId)).toMatchObject({
      status: 'CONFIRMED',
      rejection_reason: null,
      rejected_at: null,
    });
    const keys = await rKeys(owner.walletId);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: revoked?.id, status: 'ACTIVE', deactivated_at: null });
    expect(
      logs.lines().filter((l) => l.alert === 'RECOVERY_REJECTED_KEY_EXECUTED' && l.rotationId === rotationId),
    ).toHaveLength(1);
    expect(logs.lines().filter((l) => l.alert === 'ROTATION_EVENT_QUARANTINED')).toHaveLength(0);
  });

  it('la propuesta de la rotación revalida con lock que el pedido siga SUBMITTED: un rechazo en el medio la frena', async () => {
    const owner = await activeOwner();
    const enrollmentId = await requestEnrollment(owner, owner.operations);
    const rPrime = await submittedByRecovery(owner.walletId, enrollmentId, {
      replacement: privateKeyToAccount(generatePrivateKey()),
    });
    // Contexto on-chain fijo (sin la cadena): la Safe con su R actual y sin propuestas pendientes.
    const context = {
      state: {
        roles: { userKey: addr(), recoveryKey: addr(), executor: addr() },
        timelock: snapshot.contracts.rotationTimelock,
        guard: snapshot.contracts.securityGuard,
        moduleGuard: snapshot.contracts.securityGuard,
      },
      active: ZERO32,
      successor: null,
    };
    const chain = { readSensitive: () => Promise.resolve({ value: context }) } as unknown as RpcQuorumClient;
    // El aviso del aborto entra justo después de que la propuesta leyó R′ y antes de su transacción.
    const operations = {
      prepare: async (_actor: unknown, input: Parameters<OperationService['prepare']>[1]) => {
        const rejected = await reject(owner, owner.operations, enrollmentId, 'RETURN_LINK_KEY_MISMATCH');
        expect(rejected.statusCode, rejected.body).toBe(200);
        await withTransaction(
          db.app,
          async (trx) => {
            await input.afterInsert?.(trx, {
              operationId: randomUUID(),
              walletId: owner.walletId,
              safe: owner.safe,
              nonce: 0n,
              safeTxHash: ZERO32,
            });
          },
          { auditLock: true },
        );
        throw new Error('la propuesta no debía seguir');
      },
    } as unknown as OperationService;
    const service = new RotationService({
      db: db.app,
      operations,
      signerKeys,
      rpc: chain,
      snapshot: () => snapshot,
      audit: wallet.services.audit,
      outbox: new OutboxRepository(db.app),
      logger: logs.logger,
    });
    const actor = actorFor(owner.account.id, owner.unlocked);
    const error = await service.propose(actor, owner.walletId, { role: 'R' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as ApiError).detail).toContain('el pedido de la clave R nueva cambió');
    const rotations = await db.app
      .selectFrom('rotation_requests')
      .select('id')
      .where('wallet_id', '=', owner.walletId)
      .execute();
    expect(rotations).toEqual([]);
    expect((await enrollmentRow(enrollmentId)).status).toBe('REJECTED');
    expect(rPrime).toBe(bufferToAddress((await enrollmentRow(enrollmentId)).r_address ?? Buffer.alloc(20)));
  });
});
