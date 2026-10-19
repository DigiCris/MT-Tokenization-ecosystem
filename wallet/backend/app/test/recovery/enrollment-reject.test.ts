// P17.MAN (N10): la Wallet rechaza un enrollment de R que no pudo confirmar ([F-LNK-02]) — la comparación manual no
// coincidió, el enlace de regreso trae otra R o no lo armó la app Recovery del usuario —. El pedido queda REJECTED con
// el motivo, la R que había enviado Recovery deja de estar viva y, como puede ser una sustitución de R en el camino,
// quedan el evento de auditoría, la notificación in-app, el email de seguridad, el log de alerta y la métrica. Es
// idempotente, un pedido reemplazado (SUPERSEDED) toma el motivo si el aviso llega después, y la ruta respeta
// [B-AUTHZ] (otro usuario → 404, sólo en el listener de Wallet, con la PlatformSession del pedido). Sin la cadena: el
// envío de R de Recovery (que lee el código de R por RPC) se reproduce en la base; el envío real y el rechazo después
// del alta de U están en test/recovery/enrollment.test.ts (fork).
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { getAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupedAddress } from '../../src/email/format.ts';
import { addressToBuffer } from '../../src/lib/bytes.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import { loadPolicySnapshot } from '../../src/policy/snapshot.ts';
import type { EnrollmentView } from '../../src/recovery/enrollment.ts';
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
import { newSessionKey } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';
import { edKey, vectorSystem, writePolicySnapshot } from '../helpers/signer-shard.ts';

const logs = captureLogger('info');
let db: TestDatabase;
let redis: Redis;
let wallet: TestListener;
let recovery: TestListener;
let pipeline: EmailPipeline;
let snapshotDir: string;

beforeAll(async () => {
  db = await createTestDatabase();
  redis = testRedis(REDIS_DBS.recoveryEnrollmentReject);
  await redis.flushdb();
  // Armar las rutas de wallets no toca la cadena: un RPC inalcanzable y el snapshot de los vectores alcanzan.
  snapshotDir = mkdtempSync(join(tmpdir(), 'mtw-enrollment-reject-'));
  const key = edKey();
  const snapshot = loadPolicySnapshot(writePolicySnapshot(snapshotDir, key, vectorSystem()), key.publicKey, 'local');
  const config = testConfig({ RATE_LIMIT_GLOBAL_PER_MINUTE: '100000', PLATFORM_ID: snapshot.platformId });
  const metrics = createMetrics({ defaultMetrics: false });
  const rpc = unreachableRpc(logs.logger, metrics);
  const signerKeys = new SignerKeyService({
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

async function requestEnrollment(o: Onboarding): Promise<string> {
  const response = await critical(
    o.browser,
    o.onboarding,
    `/wallets/${o.walletId}/recovery/enrollments`,
    {},
    { idempotencyKey: idempotencyKey() },
  );
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ enrollmentId: string }>().enrollmentId;
}

/** Lo que deja en la base el envío de Recovery (P12: R con su prueba de control, verificado contra la cadena). */
async function submittedByRecovery(o: Onboarding, enrollmentId: string): Promise<Address> {
  const r = getAddress(privateKeyToAccount(generatePrivateKey()).address);
  const flags = JSON.stringify({ drive: false, file: true, qr: false, words: false });
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
      submitted_at: new Date(),
    })
    .where('enrollment_id', '=', enrollmentId)
    .execute();
  await db.app
    .insertInto('wallet_keys_metadata')
    .values({
      wallet_id: o.walletId,
      role: 'R',
      key_address: addressToBuffer(r),
      key_version: 1,
      status: 'PENDING',
      source: 'INTERNAL',
      storage_flags: flags,
    })
    .execute();
  return r;
}

function reject(o: Onboarding, enrollmentId: string, reason: string, session: Session = o.onboarding) {
  return critical(o.browser, session, `/recovery/enrollments/${enrollmentId}/reject`, { reason });
}

async function auditEvents(enrollmentId: string) {
  return db.app
    .selectFrom('audit_events')
    .select(['event_type', 'payload'])
    .where('target_id', '=', enrollmentId)
    .where('event_type', '=', 'RECOVERY_ENROLLMENT_REJECTED')
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

describe('rechazo de un enrollment de R por la Wallet', () => {
  it('con R enviada: REJECTED con el motivo, R revocada, auditoría, aviso, email y alerta; repetirlo no duplica nada', async () => {
    const o = await withUserKey();
    const enrollmentId = await requestEnrollment(o);
    const r = await submittedByRecovery(o, enrollmentId);

    const response = await reject(o, enrollmentId, 'RETURN_LINK_KEY_MISMATCH');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<EnrollmentView>()).toMatchObject({
      id: enrollmentId,
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_KEY_MISMATCH',
      recoveryKey: r,
    });
    const row = await db.app
      .selectFrom('recovery_metadata')
      .select(['status', 'rejection_reason', 'rejected_at'])
      .where('enrollment_id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'REJECTED', rejection_reason: 'RETURN_LINK_KEY_MISMATCH' });
    expect(row.rejected_at).toBeInstanceOf(Date);
    // La R que había enviado Recovery ya no está viva: no se puede incorporar ni reusar como pendiente.
    const key = await db.app
      .selectFrom('wallet_keys_metadata')
      .select(['status', 'deactivated_at'])
      .where('wallet_id', '=', o.walletId)
      .where('role', '=', 'R')
      .executeTakeFirstOrThrow();
    expect(key.status).toBe('REVOKED');
    expect(key.deactivated_at).toBeInstanceOf(Date);

    const audit = await auditEvents(enrollmentId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      reason: 'RETURN_LINK_KEY_MISMATCH',
      purpose: 'ONBOARDING',
      previousStatus: 'SUBMITTED',
      recoveryKey: r,
    });
    const inbox = await notifications(o.account.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.payload).toMatchObject({ enrollmentId, reason: 'RETURN_LINK_KEY_MISMATCH', recoveryKey: r });
    const email = await waitForMessage(o.account.email, (m) => m.subject.includes('Posible sustitución de tu clave R'));
    expect(email.text).toContain('traía una dirección de clave R distinta de la que recibió la plataforma');
    expect(email.text).toContain(`Dirección que recibió la plataforma: ${groupedAddress(r)}`);
    expect(email.text).not.toMatch(/^Safe: /m);
    expect(await wallet.metrics.registry.getSingleMetricAsString('mtw_recovery_enrollment_rejections_total')).toContain(
      'mtw_recovery_enrollment_rejections_total{reason="RETURN_LINK_KEY_MISMATCH",purpose="ONBOARDING"} 1',
    );
    expect(
      logs.lines().filter((l) => l.alert === 'RECOVERY_KEY_SUBSTITUTION_SUSPECTED' && l.enrollmentId === enrollmentId),
    ).toHaveLength(1);

    // Idempotente: otro aviso (aunque traiga otro motivo) devuelve el mismo estado sin repetir nada.
    const again = await reject(o, enrollmentId, 'MANUAL_COMPARISON_FAILED');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_KEY_MISMATCH',
    });
    expect(await auditEvents(enrollmentId)).toHaveLength(1);
    expect(await notifications(o.account.id)).toHaveLength(1);
    expect(
      logs.lines().filter((l) => l.alert === 'RECOVERY_KEY_SUBSTITUTION_SUSPECTED' && l.enrollmentId === enrollmentId),
    ).toHaveLength(1);

    // Las dos apps ven el motivo; un pedido nuevo funciona y el rechazado conserva el suyo.
    for (const browser of [o.browser, o.recoveryBrowser]) {
      const view = await browser.get(`/api/v1/recovery/enrollments/${enrollmentId}`);
      expect(view.json<EnrollmentView>()).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'RETURN_LINK_KEY_MISMATCH',
      });
    }
    const next = await requestEnrollment(o);
    expect((await o.browser.get(`/api/v1/recovery/enrollments/${next}`)).json<EnrollmentView>()).toMatchObject({
      status: 'REQUESTED',
      rejectionReason: null,
    });
    expect(
      (await o.browser.get(`/api/v1/recovery/enrollments/${enrollmentId}`)).json<EnrollmentView>().rejectionReason,
    ).toBe('RETURN_LINK_KEY_MISMATCH');
  });

  it('sin R enviada también se rechaza; uno reemplazado queda SUPERSEDED y toma el motivo si el aviso llega después', async () => {
    const o = await withUserKey();
    const first = await requestEnrollment(o);
    const second = await requestEnrollment(o);
    // Pedir otro reemplaza al anterior.
    expect((await o.browser.get(`/api/v1/recovery/enrollments/${first}`)).json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'SUPERSEDED',
    });
    expect(await auditEvents(first)).toHaveLength(0);

    // El aviso del aborto del primero llega después de pedir el segundo: el motivo y la alerta no se pierden.
    const late = await reject(o, first, 'RETURN_LINK_UNVERIFIED');
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'RETURN_LINK_UNVERIFIED',
    });
    expect(await auditEvents(first)).toHaveLength(1);
    expect((await auditEvents(first))[0]?.payload).toMatchObject({ previousStatus: 'REJECTED', recoveryKey: null });

    // El segundo, todavía sin R: la comparación manual no se puede hacer, pero el aborto vale igual.
    const manual = await reject(o, second, 'MANUAL_COMPARISON_FAILED');
    expect(manual.statusCode, manual.body).toBe(200);
    expect(manual.json<EnrollmentView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'MANUAL_COMPARISON_FAILED',
      recoveryKey: null,
    });
    expect(await notifications(o.account.id)).toHaveLength(2);
    const email = await waitForMessage(
      o.account.email,
      (m) =>
        m.subject.includes('Posible sustitución de tu clave R') &&
        m.text.includes('Motivo: la dirección copiada de la app Recovery no coincidió'),
    );
    expect(email.text).not.toContain('Dirección que recibió la plataforma');
  });

  it('[B-AUTHZ]: otro usuario → 404; Recovery no la expone; sin PlatformSession → 403; motivo inválido → 400; CONFIRMED → 409', async () => {
    const o = await withUserKey();
    const enrollmentId = await requestEnrollment(o);

    // Otro usuario, con su propia sesión ONBOARDING: el pedido de A no existe para él.
    const other = await withUserKey();
    const foreign = await critical(other.browser, other.onboarding, `/recovery/enrollments/${enrollmentId}/reject`, {
      reason: 'MANUAL_COMPARISON_FAILED',
    });
    expect(foreign.statusCode).toBe(404);
    expect((await reject(o, crypto.randomUUID(), 'MANUAL_COMPARISON_FAILED')).statusCode).toBe(404);
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
    expect((await reject(o, enrollmentId, 'OTRO')).statusCode).toBe(400);
    expect((await reject(o, enrollmentId, 'SUPERSEDED')).statusCode).toBe(400);
    expect(await auditEvents(enrollmentId)).toHaveLength(0);

    // Un pedido que U ya incorporó no se rechaza.
    await submittedByRecovery(o, enrollmentId);
    await db.app
      .updateTable('recovery_metadata')
      .set({ status: 'CONFIRMED', u_incorporation_signature: randomBytes(65), confirmed_at: new Date() })
      .where('enrollment_id', '=', enrollmentId)
      .execute();
    const confirmed = await reject(o, enrollmentId, 'MANUAL_COMPARISON_FAILED');
    expect(confirmed.statusCode).toBe(409);
    expect(await auditEvents(enrollmentId)).toHaveLength(0);
  });
});
