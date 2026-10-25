// P17.MAN ([F-LNK-04], ESC-41): la app Recovery rechaza el borrador del reemplazo de U cuando la U′ que informa la
// plataforma no coincide con la que el usuario copió de la app Wallet. El borrador queda REJECTED con el motivo, su U′
// deja de estar viva (metadato REVOKED y registro OPAQUE de la Password U′ retirado) y, como puede ser una sustitución
// de U′ en el camino, quedan el evento de auditoría, la notificación in-app, el email de seguridad (uno por ventana y
// usuario; el resto en el resumen), el log de alerta y la métrica. Es idempotente, exige la U′ que comparó Recovery (si
// la Wallet registró otra en el mismo borrador, 409) y respeta [B-AUTHZ]: sólo en el listener de Recovery, con la
// PlatformSession RECOVERY de la propuesta, y una rotación de otro usuario, de otra wallet o que no es de U → 404.
// Un borrador rechazado no se propone (409, también si el rechazo llega en medio de la propuesta) y la Wallet puede
// registrar otra U′: es un borrador nuevo, con su propia comparación.
//
// Sin la cadena: el registro de U′ va por la API real de la Wallet sobre una wallet activa sembrada en la base, y la
// propuesta se arma con el contexto on-chain fijo (el flujo completo en el fork está en
// test/integration/recovery-flows.test.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import { rotationTimelockAbi } from '../../src/chain/abis/index.ts';
import { platformTypedData } from '../../src/chain/eip712.ts';
import type { RpcQuorumClient } from '../../src/chain/rpc-quorum.ts';
import { OutboxRepository } from '../../src/db/repositories/outbox-repository.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { groupedAddress } from '../../src/email/format.ts';
import { addressToBuffer, bufferToAddress } from '../../src/lib/bytes.ts';
import { createMetrics } from '../../src/observability/metrics.ts';
import type { OperationService } from '../../src/operations/service.ts';
import { loadPolicySnapshot } from '../../src/policy/snapshot.ts';
import { RejectionEmailDigest } from '../../src/recovery/rejection-digest.ts';
import { REJECTION_EMAIL_WINDOW_MS } from '../../src/recovery/rejection-email.ts';
import { RotationService, type RotationView } from '../../src/rotations/service.ts';
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
import { seedActiveWallet } from '../helpers/platform.ts';
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
  redis = testRedis(REDIS_DBS.uReplacementReject);
  await redis.flushdb();
  // Armar las rutas no toca la cadena: un RPC inalcanzable y el snapshot de los vectores alcanzan.
  snapshotDir = mkdtempSync(join(tmpdir(), 'mtw-u-replacement-reject-'));
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
    redisDb: REDIS_DBS.uReplacementReject,
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

/** Wallet activa con su U vigente, la sesión U_REPLACEMENT de la Wallet y la RECOVERY de Recovery. */
interface Owner {
  account: TestAccount;
  browser: TestClient;
  recoveryBrowser: TestClient;
  walletId: string;
  safe: Address;
  oldKey: Address;
  replacement: Session;
  recoverySession: Session;
}

async function login(listener: TestListener, account: TestAccount): Promise<TestClient> {
  const client = listener.newClient();
  const response = await client.post('/api/v1/auth/login', { email: account.email, password: account.password });
  if (response.statusCode !== 200) throw new Error(`login: ${String(response.statusCode)} ${response.body}`);
  return client;
}

async function owner(): Promise<Owner> {
  const account = await createVerifiedUser(wallet, db);
  const browser = await login(wallet, account);
  const recoveryBrowser = await login(recovery, account);
  const { walletId, safe } = await seedActiveWallet(db, { userId: account.id, platformId: snapshot.platformId });
  if (safe === null) throw new Error('wallet sin Safe');
  const current = await db.app
    .selectFrom('wallet_keys_metadata')
    .select('key_address')
    .where('wallet_id', '=', walletId)
    .where('role', '=', 'U')
    .where('status', '=', 'ACTIVE')
    .executeTakeFirstOrThrow();
  return {
    account,
    browser,
    recoveryBrowser,
    walletId,
    safe,
    oldKey: bufferToAddress(current.key_address),
    replacement: await stepUp(browser, account.email, 'U_REPLACEMENT'),
    recoverySession: await stepUp(recoveryBrowser, account.email, 'RECOVERY'),
  };
}

/** KeyAcceptance [W-01] de U′ (rol 1) para su wallet. */
async function keyAcceptance(account: PrivateKeyAccount, walletId: string) {
  const nonce: Hex = `0x${randomBytes(32).toString('hex')}`;
  const typed = platformTypedData(8453, snapshot.contracts.walletFactory, 'KeyAcceptance', {
    walletId,
    role: 1,
    newKey: account.address,
    nonce,
  });
  return { nonce, signature: await account.signTypedData(typed) };
}

/** "Perdí mi Password U" de la Wallet por la API: U′ nueva con su registro OPAQUE y su KeyAcceptance → borrador. */
async function registerReplacement(o: Owner): Promise<{ rotationId: string; newKey: Address }> {
  const replacement = newUserKey();
  const registrationRecord = await opaqueRecord(o.browser, o.replacement, o.walletId, replacement.authSecretHex);
  const response = await critical(
    o.browser,
    o.replacement,
    '/recovery/u-replacement',
    {
      userKey: replacement.account.address,
      kdfParams: KDF_PARAMS,
      storageFlags: { drive: false, file: true, qr: false, words: true },
      registrationRecord,
      keyAcceptance: await keyAcceptance(replacement.account, o.walletId),
    },
    { idempotencyKey: idempotencyKey() },
  );
  expect(response.statusCode, response.body).toBe(201);
  return {
    rotationId: response.json<{ rotationId: string }>().rotationId,
    newKey: getAddress(replacement.account.address),
  };
}

const manual = (newKey: string) => ({ reason: 'MANUAL_COMPARISON_FAILED', newKey });

/** El rechazo desde Recovery con la sesión RECOVERY (crítico e idempotente). */
function reject(o: Owner, rotationId: string, body: unknown, key = idempotencyKey()) {
  return critical(o.recoveryBrowser, o.recoverySession, `/recovery/u-replacement/${rotationId}/reject`, body, {
    idempotencyKey: key,
  });
}

async function rotationRow(rotationId: string) {
  return db.app.selectFrom('rotation_requests').selectAll().where('id', '=', rotationId).executeTakeFirstOrThrow();
}

async function uKeys(walletId: string) {
  return db.app
    .selectFrom('wallet_keys_metadata')
    .select(['key_address', 'status', 'deactivated_at'])
    .where('wallet_id', '=', walletId)
    .where('role', '=', 'U')
    .execute();
}

const keyStatus = (keys: Awaited<ReturnType<typeof uKeys>>, address: Address) =>
  keys.find((k) => bufferToAddress(k.key_address) === address)?.status;

async function auditEvents(rotationId: string, type = 'U_REPLACEMENT_REJECTED') {
  return db.app
    .selectFrom('audit_events')
    .select(['event_type', 'payload'])
    .where('target_id', '=', rotationId)
    .where('event_type', '=', type)
    .execute();
}

async function notifications(userId: string) {
  return db.app
    .selectFrom('notifications')
    .select(['type', 'payload'])
    .where('user_id', '=', userId)
    .where('type', '=', 'U_REPLACEMENT_REJECTED')
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

const alerts = (rotationId: string) =>
  logs.lines().filter((l) => l.alert === 'USER_KEY_SUBSTITUTION_SUSPECTED' && l.rotationId === rotationId);

/** El valor de un contador con sus labels (las métricas son del proceso: se comparan antes y después). */
async function counter(name: string, labels: string): Promise<number> {
  const text = await wallet.metrics.registry.getSingleMetricAsString(name);
  const line = text.split('\n').find((l) => l.startsWith(`${name}{${labels}} `));
  return Number(line?.split(' ').at(-1) ?? 0);
}
const rejections = () => counter('mtw_u_replacement_rejections_total', 'reason="MANUAL_COMPARISON_FAILED"');
const heldEmails = () =>
  counter('mtw_emails_skipped_total', 'template="u-replacement-rejected",reason="held_for_summary"');

/** La propuesta de R (POST /wallets/{id}/rotations) con el contexto on-chain fijo y la operación simulada. */
function proposals(o: Owner, prepare: OperationService['prepare']) {
  const context = {
    state: {
      roles: { userKey: o.oldKey, recoveryKey: addr(), executor: addr() },
      timelock: snapshot.contracts.rotationTimelock,
      guard: snapshot.contracts.securityGuard,
      moduleGuard: snapshot.contracts.securityGuard,
    },
    active: ZERO32,
    successor: null,
  };
  const chain = { readSensitive: () => Promise.resolve({ value: context }) } as unknown as RpcQuorumClient;
  const service = new RotationService({
    db: db.app,
    operations: { prepare } as unknown as OperationService,
    signerKeys,
    rpc: chain,
    snapshot: () => snapshot,
    audit: wallet.services.audit,
    outbox: new OutboxRepository(db.app),
    logger: logs.logger,
  });
  return () => service.propose(actorFor(o.account.id, o.recoverySession), o.walletId, { role: 'U' });
}

describe('rechazo del borrador del reemplazo de U desde Recovery', () => {
  it('REJECTED con el motivo, U′ revocada y su registro OPAQUE retirado, auditoría, aviso, email y alerta; repetirlo no duplica nada', async () => {
    const o = await owner();
    const { rotationId, newKey } = await registerReplacement(o);
    const draft = await rotationRow(rotationId);
    expect(draft).toMatchObject({ role: 'U', status: 'DRAFT', rejection_reason: null, rejection_email: null });
    const before = await rejections();

    const response = await reject(o, rotationId, manual(newKey));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<RotationView>()).toMatchObject({
      id: rotationId,
      walletId: o.walletId,
      role: 'U',
      status: 'REJECTED',
      rejectionReason: 'MANUAL_COMPARISON_FAILED',
      oldKey: o.oldKey,
      newKey,
      cancelTypedData: null,
    });
    const row = await rotationRow(rotationId);
    expect(row).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'MANUAL_COMPARISON_FAILED',
      rejection_email: 'SENT',
    });
    expect(row.rejected_at).toBeInstanceOf(Date);
    expect(row.rejection_emailed_at).toEqual(row.rejected_at);
    // U′ deja de estar viva; la U vigente sigue igual.
    const keys = await uKeys(o.walletId);
    expect(keyStatus(keys, newKey)).toBe('REVOKED');
    expect(keys.find((k) => bufferToAddress(k.key_address) === newKey)?.deactivated_at).toBeInstanceOf(Date);
    expect(keyStatus(keys, o.oldKey)).toBe('ACTIVE');
    const opaque = await db.app
      .selectFrom('opaque_records')
      .select('status')
      .where('id', '=', draft.opaque_record_id ?? randomUUID())
      .executeTakeFirstOrThrow();
    expect(opaque.status).toBe('RETIRED');

    const audit = await auditEvents(rotationId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      client: 'RECOVERY',
      platformSessionId: o.recoverySession.sessionId,
      reason: 'MANUAL_COMPARISON_FAILED',
      oldKey: o.oldKey,
      newKey,
      email: 'SENT',
    });
    const inbox = await notifications(o.account.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.payload).toMatchObject({ rotationId, reason: 'MANUAL_COMPARISON_FAILED', newKey, safe: o.safe });
    const email = await waitForMessage(o.account.email, (m) =>
      m.subject.includes('Posible sustitución de tu clave U nueva'),
    );
    expect(email.text).toContain('la app Recovery canceló el pedido y no va a firmar el reemplazo hacia esa dirección');
    expect(email.text).toContain(`Dirección que recibió la plataforma: ${groupedAddress(newKey)}`);
    expect(email.text).toContain(`Safe: ${groupedAddress(o.safe)}`);
    expect(email.text).toContain('— MT Wallet Recovery.');
    expect(await rejections()).toBe(before + 1);
    expect(alerts(rotationId)).toHaveLength(1);
    expect(alerts(rotationId)[0]).toMatchObject({ walletId: o.walletId, newKey, email: 'SENT' });

    // Idempotente: otro aviso devuelve el mismo estado sin repetir nada; la misma Idempotency-Key, la misma respuesta.
    const again = await reject(o, rotationId, manual(newKey));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<RotationView>()).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'MANUAL_COMPARISON_FAILED',
    });
    const key = idempotencyKey();
    const first = await reject(o, rotationId, manual(newKey), key);
    const replay = await reject(o, rotationId, manual(newKey), key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(await auditEvents(rotationId)).toHaveLength(1);
    expect(await notifications(o.account.id)).toHaveLength(1);
    expect(await emailRequests(o.account.email, 'u-replacement-rejected')).toBe(1);
    expect(alerts(rotationId)).toHaveLength(1);
    expect(await rejections()).toBe(before + 1);

    // Las dos apps ven el borrador rechazado con su motivo.
    for (const browser of [o.browser, o.recoveryBrowser]) {
      const list = await browser.get(`/api/v1/wallets/${o.walletId}/rotations`);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json<{ items: RotationView[] }>().items.find((r) => r.id === rotationId)).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'MANUAL_COMPARISON_FAILED',
        newKey,
      });
    }
  });

  it('la propuesta de R no toma un borrador rechazado (409) y la Wallet puede registrar otra U′: borrador nuevo, otra comparación', async () => {
    const o = await owner();
    const first = await registerReplacement(o);
    expect((await reject(o, first.rotationId, manual(first.newKey))).statusCode).toBe(200);
    const STOP = new Error('la propuesta se corta antes de crear la operación');
    const prepare = vi.fn<OperationService['prepare']>(() => Promise.reject(STOP));
    const propose = proposals(o, prepare);

    const refused = await propose().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'CONFLICT' });
    expect((refused as ApiError).detail).toContain('la app Recovery canceló el reemplazo de U');
    expect(prepare).not.toHaveBeenCalled();

    // Otra U′ registrada en la Wallet: otra rotación en DRAFT; la rechazada queda como estaba.
    const second = await registerReplacement(o);
    expect(second.rotationId).not.toBe(first.rotationId);
    expect(await rotationRow(second.rotationId)).toMatchObject({ status: 'DRAFT', rejection_reason: null });
    expect(await rotationRow(first.rotationId)).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'MANUAL_COMPARISON_FAILED',
    });
    const keys = await uKeys(o.walletId);
    expect(keyStatus(keys, first.newKey)).toBe('REVOKED');
    expect(keyStatus(keys, second.newKey)).toBe('PENDING');

    // La propuesta de R se arma hacia la U′ nueva (se corta en el prepare, antes de crear la operación).
    expect(await propose().catch((e: unknown) => e)).toBe(STOP);
    expect(prepare).toHaveBeenCalledTimes(1);
    const call = prepare.mock.calls[0]?.[1].call;
    const decoded = decodeFunctionData({ abi: rotationTimelockAbi, data: call?.data ?? '0x' });
    expect(decoded.functionName).toBe('propose');
    expect(decoded.args.slice(1)).toEqual([o.oldKey, second.newKey]);
    // (Que el borrador nuevo también se puede rechazar lo cubre el caso del tope de emails, con el mismo usuario.)
  });

  it('un rechazo que llega entre la lectura del borrador y la transacción de la propuesta la frena (409)', async () => {
    const o = await owner();
    const draft = await registerReplacement(o);
    const propose = proposals(o, async (_actor, input) => {
      // El aviso de Recovery entra justo después de que la propuesta leyó el borrador y antes de su transacción.
      const rejected = await reject(o, draft.rotationId, manual(draft.newKey));
      expect(rejected.statusCode, rejected.body).toBe(200);
      await withTransaction(
        db.app,
        async (trx) => {
          await input.afterInsert?.(trx, {
            operationId: randomUUID(),
            walletId: o.walletId,
            safe: o.safe,
            nonce: 0n,
            safeTxHash: ZERO32,
          });
        },
        { auditLock: true },
      );
      throw new Error('la propuesta no debía seguir');
    });
    const error = await propose().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as ApiError).detail).toContain('el borrador de la rotación cambió');
    expect(await rotationRow(draft.rotationId)).toMatchObject({ status: 'REJECTED', propose_operation_id: null });
  });

  it('un email por ventana y usuario (aparte de los rechazos de R) y el resto en el resumen', async () => {
    const o = await owner();
    // Un email de rechazo de R de esta misma hora no retiene el de U′: cada tipo de rechazo tiene su ventana.
    const now = new Date();
    await db.app
      .insertInto('recovery_metadata')
      .values({
        wallet_id: o.walletId,
        enrollment_id: randomUUID(),
        nonce: randomBytes(32),
        status: 'REJECTED',
        expires_at: now,
        rejection_reason: 'MANUAL_COMPARISON_FAILED',
        rejected_at: now,
        rejection_reported_at: now,
        rejection_email: 'SENT',
        rejection_emailed_at: now,
      })
      .execute();
    const first = await registerReplacement(o);
    expect((await reject(o, first.rotationId, manual(first.newKey))).statusCode).toBe(200);
    expect((await rotationRow(first.rotationId)).rejection_email).toBe('SENT');

    // El segundo de la ventana: el rechazo vale igual, con su aviso in-app y su alerta, pero el email queda retenido.
    const second = await registerReplacement(o);
    const held = await heldEmails();
    expect((await reject(o, second.rotationId, manual(second.newKey))).statusCode).toBe(200);
    expect(await rotationRow(second.rotationId)).toMatchObject({
      status: 'REJECTED',
      rejection_email: 'HELD',
      rejection_emailed_at: null,
    });
    expect((await auditEvents(second.rotationId))[0]?.payload).toMatchObject({ email: 'HELD' });
    expect(await notifications(o.account.id)).toHaveLength(2);
    expect(alerts(second.rotationId)).toHaveLength(1);
    expect(alerts(second.rotationId)[0]).toMatchObject({ email: 'HELD' });
    expect(await emailRequests(o.account.email, 'u-replacement-rejected')).toBe(1);
    expect(await heldEmails()).toBe(held + 1);

    // Con la ventana abierta el resumen no sale; al cerrarse, uno solo con lo retenido, y abre una ventana nueva.
    const digest = (offsetMs: number) =>
      new RejectionEmailDigest({
        db: db.app,
        emails: wallet.services.emails,
        logger: logs.logger,
        now: () => Date.now() + offsetMs,
      });
    expect(await digest(0).runOnce()).toBe(0);
    expect((await rotationRow(second.rotationId)).rejection_email).toBe('HELD');
    expect(await digest(REJECTION_EMAIL_WINDOW_MS + 60_000).runOnce()).toBe(1);
    const summarized = await rotationRow(second.rotationId);
    expect(summarized.rejection_email).toBe('SUMMARIZED');
    expect(summarized.rejection_emailed_at).toBeInstanceOf(Date);
    const summary = await waitForMessage(o.account.email, (m) =>
      m.subject.includes('Más pedidos de tu clave U nueva cancelados'),
    );
    expect(summary.text).toContain('Pedidos cancelados: 1');
    expect(summary.text).toContain('Motivos: la dirección copiada de la app Wallet no coincidió');
    expect(summary.text).toContain(`Safe: ${groupedAddress(o.safe)}`);
    expect(await digest(REJECTION_EMAIL_WINDOW_MS + 60_000).runOnce()).toBe(0);
    expect(await emailRequests(o.account.email, 'u-replacement-rejections-summary')).toBe(1);
    expect(await emailRequests(o.account.email, 'recovery-enrollment-rejections-summary')).toBe(0);
  });

  it('409: otra U′ registrada en el mismo borrador, una rotación que ya no es un borrador o en curso (auditado y con alerta)', async () => {
    const o = await owner();
    const a = await registerReplacement(o);
    // La Wallet registró otra U′ mientras tanto: el mismo borrador, con la U′ nueva.
    const b = await registerReplacement(o);
    expect(b.rotationId).toBe(a.rotationId);
    const stale = await reject(o, a.rotationId, manual(a.newKey));
    expect(stale.statusCode, stale.body).toBe(409);
    expect(await rotationRow(a.rotationId)).toMatchObject({ status: 'DRAFT', rejection_reason: null });
    expect(keyStatus(await uKeys(o.walletId), b.newKey)).toBe('PENDING');

    // Terminada sin ejecutarse: 409 sin efectos.
    await db.app
      .updateTable('rotation_requests')
      .set({ status: 'FAILED', failure_reason: 'PROPOSAL_FAILED' })
      .where('id', '=', a.rotationId)
      .execute();
    expect((await reject(o, a.rotationId, manual(b.newKey))).statusCode).toBe(409);
    expect(await auditEvents(a.rotationId)).toHaveLength(0);
    expect(alerts(a.rotationId)).toHaveLength(0);

    // Con la propuesta hacia esa U′ en el timelock: no se acepta (hay que cancelarla con R), con auditoría y alerta.
    await db.app
      .updateTable('rotation_requests')
      .set({
        status: 'PENDING_TIMELOCK',
        proposal_id: randomBytes(32),
        executable_at: new Date(Date.now() + 48 * 3600_000),
        proposed_at: new Date(),
        failure_reason: null,
      })
      .where('id', '=', a.rotationId)
      .execute();
    const refused = await reject(o, a.rotationId, manual(b.newKey));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await rotationRow(a.rotationId)).toMatchObject({ status: 'PENDING_TIMELOCK', rejection_reason: null });
    expect(keyStatus(await uKeys(o.walletId), b.newKey)).toBe('PENDING');
    expect(await auditEvents(a.rotationId)).toHaveLength(0);
    expect((await auditEvents(a.rotationId, 'U_REPLACEMENT_REJECTION_REFUSED'))[0]?.payload).toMatchObject({
      reason: 'MANUAL_COMPARISON_FAILED',
      newKey: b.newKey,
      rotationStatus: 'PENDING_TIMELOCK',
    });
    expect(alerts(a.rotationId)).toHaveLength(1);
    expect(alerts(a.rotationId)[0]).toMatchObject({ rotationStatus: 'PENDING_TIMELOCK', newKey: b.newKey });
    expect(await notifications(o.account.id)).toHaveLength(0);
  });

  it('[B-AUTHZ]: otro usuario, otra wallet o una rotación que no es de U → 404; sólo en Recovery con la sesión RECOVERY; cuerpo inválido o sin Idempotency-Key → 400', async () => {
    const o = await owner();
    const draft = await registerReplacement(o);
    const body = manual(draft.newKey);
    const path = `/recovery/u-replacement/${draft.rotationId}/reject`;

    // Otro usuario, con su propia sesión RECOVERY: el borrador de A no existe para él.
    const other = await owner();
    const foreign = await critical(other.recoveryBrowser, other.recoverySession, path, body, {
      idempotencyKey: idempotencyKey(),
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect((await reject(o, randomUUID(), body)).statusCode).toBe(404);
    // Una rotación de U de otra wallet del mismo usuario (una vieja, ya migrada): la sesión es de la wallet viva.
    const old = await db.app
      .insertInto('wallets')
      .values({
        user_id: o.account.id,
        platform_id: snapshot.platformId,
        chain_id: 8453,
        status: 'MIGRATED',
        safe_address: randomBytes(20),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const oldKey = addr();
    const elsewhere = await db.app
      .insertInto('rotation_requests')
      .values({
        wallet_id: old.id,
        role: 'U',
        old_key: addressToBuffer(addr()),
        new_key: addressToBuffer(oldKey),
        initiated_by: 'R',
        status: 'DRAFT',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect((await reject(o, elsewhere.id, manual(oldKey))).statusCode).toBe(404);
    // Un borrador que no es del reemplazo de U (la rotación de S pedida por la plataforma).
    const executorKey = addr();
    const executor = await db.app
      .insertInto('rotation_requests')
      .values({
        wallet_id: o.walletId,
        role: 'S',
        old_key: addressToBuffer(addr()),
        new_key: addressToBuffer(executorKey),
        initiated_by: 'U',
        status: 'DRAFT',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect((await reject(o, executor.id, manual(executorKey))).statusCode).toBe(404);

    // Sólo el listener de Recovery: en el de Wallet la ruta no existe.
    const fromWallet = await o.browser.post(`/api/v1${path}`, body, { 'idempotency-key': idempotencyKey() });
    expect(fromWallet.statusCode).toBe(404);
    // Sin PlatformSession (request crítico sin firmar) o con otro scope de Recovery (ENROLLMENT): 403.
    const unsigned = await o.recoveryBrowser.post(`/api/v1${path}`, body, { 'idempotency-key': idempotencyKey() });
    expect(unsigned.statusCode).toBe(403);
    const enrollmentBrowser = await login(recovery, o.account);
    const enrollment = await stepUp(enrollmentBrowser, o.account.email, 'ENROLLMENT');
    const wrongScope = await critical(enrollmentBrowser, enrollment, path, body, { idempotencyKey: idempotencyKey() });
    expect(wrongScope.statusCode, wrongScope.body).toBe(403);
    // Motivo desconocido, sin la U′ comparada, una dirección inválida o un campo de más: 400; sin Idempotency-Key, 400.
    for (const invalid of [
      { reason: 'OTRO', newKey: draft.newKey },
      { reason: 'MANUAL_COMPARISON_FAILED' },
      { reason: 'MANUAL_COMPARISON_FAILED', newKey: '0x1234' },
      { ...body, detail: 'texto libre' },
    ]) {
      expect((await reject(o, draft.rotationId, invalid)).statusCode, JSON.stringify(invalid)).toBe(400);
    }
    const withoutKey = await critical(o.recoveryBrowser, o.recoverySession, path, body);
    expect(withoutKey.statusCode, withoutKey.body).toBe(400);
    expect(withoutKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    expect(await rotationRow(draft.rotationId)).toMatchObject({ status: 'DRAFT' });
    for (const id of [draft.rotationId, elsewhere.id, executor.id]) expect(await auditEvents(id)).toHaveLength(0);
    // Con todo eso, el dueño con su sesión RECOVERY sí lo rechaza.
    expect((await reject(o, draft.rotationId, body)).statusCode).toBe(200);
  });
});
