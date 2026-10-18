// P14.T01 / P14.TST.b: whitelist de punta a punta contra el fork, el shard real del signer y Mailpit — pedido →
// challenge ligado {userId, safe, chainId, destination, action, nonce, expiresAt} → email [B-MAIL-02] → código →
// ChallengeCompletion firmada por el emisor de sesiones → SafeTx addDestination firmada por U → ejecución por S →
// ACTIVATING (no usable) → ACTIVE a las 24 h on-chain. Además: challenge vencido, reusado, de otra dirección o con el
// binding adulterado; idempotencia del pedido y duplicados; validaciones de destino; baja con U y con R (emergencia);
// alta soberana U+R; reintento del prepare sin otro código.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { encodeFunctionData, getAddress, type Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { destinationWhitelistAbi } from '../../src/chain/abis/index.ts';
import { groupedAddress } from '../../src/email/format.ts';
import { addressToBuffer } from '../../src/lib/bytes.ts';
import type { PreparedOperation } from '../../src/operations/intent.ts';
import { codeFrom } from '../helpers/mailpit.ts';
import { critical, idempotencyKey, resetRateLimits, stepUp } from '../helpers/onboarding.ts';
import {
  activeWallet,
  actorFor,
  confirmWhitelist,
  nextEmail,
  operationRow,
  requestWhitelist,
  sendCall,
  sessionOf,
  startOperationsEnv,
  statusOf,
  submissionBody,
  submitSignature,
  syncChain,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.whitelistChallenge });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  // Cada caso pide altas nuevas: el cupo diario de [B-RL] (5 por Safe) es para usuarios, no para el archivo entero.
  await resetRateLimits(env.base.redis);
  // Los casos que confirman sin firmar dejan operaciones CREATED que ocupan nonces menores: se vencen (como a los
  // 15 min) para que las siguientes no esperen un nonce que nadie va a firmar ([B-NONCE-03]).
  await env.base.db.app
    .updateTable('wallet_operations')
    .set({ expires_at: new Date(Date.now() - 1_000) })
    .where('wallet_id', '=', wallet.walletId)
    .where('status', '=', 'CREATED')
    .execute();
  await env.operations.sweep();
});

const randomDestination = (): Address => getAddress(`0x${randomBytes(20).toString('hex')}`);

interface RequestView {
  id: string;
  status: string;
  destination: Address;
  label: string;
  challengeExpiresAt: string | null;
  operationId: string | null;
  failureReason: string | null;
}

async function requestWithCode(destination: string, label = 'Proveedor') {
  const response = await requestWhitelist(wallet, { destination, label });
  expect(response.statusCode, response.body).toBe(201);
  const request = response.json<RequestView>();
  const email = await nextEmail(wallet.onboarded.user.account.email, 'Confirmá el nuevo destino autorizado');
  return { request, email, code: codeFrom(email) };
}

async function requestRow(id: string) {
  return env.base.db.app.selectFrom('whitelist_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function auditOf(targetId: string) {
  const rows = await env.base.db.app
    .selectFrom('audit_events')
    .select(['event_type', 'payload'])
    .where('target_id', '=', targetId)
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ event: r.event_type, payload: r.payload as Record<string, unknown> }));
}

/** Firma con U la SafeTx preparada, la ejecuta el worker y la indexa con confirmaciones. */
async function signAndExecute(operation: PreparedOperation): Promise<void> {
  const signed = await submitSignature(wallet, operation.operationId, await submissionBody(wallet, operation));
  expect(signed.statusCode, signed.body).toBe(200);
  await env.pipeline().processWallet(wallet.walletId);
  expect(await statusOf(env, operation.operationId)).toBe('MINED');
  await syncChain(env);
}

async function addDestination(destination: Address, label = 'Proveedor'): Promise<RequestView> {
  const { request, code } = await requestWithCode(destination, label);
  const confirmed = await confirmWhitelist(wallet, request.id, code);
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  await signAndExecute(confirmed.json<{ operation: PreparedOperation }>().operation);
  return request;
}

/** Un SEND al destino con el prepare interno (la misma policy que usa la ruta de send, test/integration/send.test.ts). */
function prepareSend(destination: Address) {
  return env.operations.prepare(wallet.actor, sendCall(env, wallet, 'USDC', destination, 2_000_000n));
}

describe('alta de un destino', () => {
  it('email con acción, dirección, red y expiración → código → atestación → firma U → ACTIVATING (no usable) → ACTIVE a las 24 h', async () => {
    const user = wallet.onboarded.user;
    const destination = randomDestination();
    // Minúsculas sin checksum: se acepta y se normaliza a EIP-55.
    const { request, email, code } = await requestWithCode(destination.toLowerCase(), 'Proveedor principal');
    expect(request).toMatchObject({ status: 'PENDING_CHALLENGE', destination, label: 'Proveedor principal' });
    expect(Date.parse(request.challengeExpiresAt ?? '') - Date.now()).toBeGreaterThan(14 * 60_000);
    // [B-MAIL-02] (P14.MAN): acción, dirección completa en grupos de 4, red, Safe, expiración y origen; sin links.
    expect(email.text).toContain('Acción: Agregar destino a la whitelist');
    expect(email.text).toContain(`Dirección: ${groupedAddress(destination)}`);
    expect(email.text).toContain('Red: Base fork local — chainId 8453');
    expect(email.text).toContain(`Safe: ${groupedAddress(wallet.safe)}`);
    expect(email.text).toContain('Etiqueta: Proveedor principal');
    expect(email.text).toMatch(/Vence \(UTC\): .+/);
    expect(email.text).toContain('Se activa 24 h después de confirmarse en la red');
    expect(email.text).not.toMatch(/https?:\/\//);
    expect(email.html).not.toMatch(/<a\s/i);

    // El challenge queda ligado al usuario, la Safe, la red, el destino, la acción, un nonce y su vencimiento.
    const row = await requestRow(request.id);
    const challenge = await env.base.db.app
      .selectFrom('security_challenges')
      .selectAll()
      .where('id', '=', row.challenge_id ?? '')
      .executeTakeFirstOrThrow();
    expect(challenge).toMatchObject({ type: 'WHITELIST_ADD', user_id: user.account.id, consumed_at: null });
    expect(challenge.binding).toMatchObject({
      requestId: request.id,
      userId: user.account.id,
      safe: wallet.safe,
      chainId: 8453,
      destination,
      action: 'WHITELIST_ADD',
      expiresAt: challenge.expires_at.toISOString(),
    });
    expect((challenge.binding as { nonce: string }).nonce).toMatch(/^0x[0-9a-f]{32}$/);

    const confirmed = await confirmWhitelist(wallet, request.id, code);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const { request: after, operation } = confirmed.json<{ request: RequestView; operation: PreparedOperation }>();
    expect(after).toMatchObject({ status: 'AWAITING_SIGNATURE', operationId: operation.operationId });
    expect(operation).toMatchObject({
      operationType: 'WHITELIST_ADD',
      decoded: { destination },
      safeTx: { to: env.base.snapshot.contracts.destinationWhitelist },
    });
    // ChallengeCompletion del emisor de sesiones, ligada a la SafeTx exacta (la verifica el signer).
    const op = await operationRow(env, operation.operationId);
    const claims = await env.issuer.verifyChallengeCompletion(op.challenge_attestation ?? '');
    expect(claims).toMatchObject({
      challengeId: challenge.id,
      type: 'WHITELIST_ADD',
      action: 'WHITELIST_ADD',
      userId: user.account.id,
      safe: wallet.safe,
      chainId: 8453,
      destination,
      safeTxHash: operation.safeTxHash,
      nonce: Number(operation.safeTx.nonce),
    });

    await signAndExecute(operation);
    const activating = await requestRow(request.id);
    expect(activating.status).toBe('ACTIVATING');
    const list = await user.wallet.get(`/api/v1/wallets/${wallet.walletId}/whitelist`);
    expect(list.statusCode, list.body).toBe(200);
    const entry = list
      .json<{
        entries: { destination: string; status: string; activatesAt: string; origin: string; label: string }[];
      }>()
      .entries.find((e) => e.destination === destination);
    expect(entry).toMatchObject({ status: 'ACTIVATING', origin: 'PLATFORM', label: 'Proveedor principal' });
    const block = await env.chain.public.getBlock({ blockTag: 'latest' });
    expect(Date.parse(entry?.activatesAt ?? '') / 1000).toBeGreaterThan(Number(block.timestamp) + 23 * 3600);

    // En ACTIVATING el destino no se puede usar: on-chain todavía no está activo.
    await expect(prepareSend(destination)).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      detail: 'DESTINATION_NOT_WHITELISTED',
    });
    await env.whitelistSync().runOnce();
    expect((await requestRow(request.id)).status).toBe('ACTIVATING');

    // 24 h después (reloj de la cadena) queda ACTIVE, con email y notificación, y se puede enviar.
    await env.chain.increaseTime(24 * 3600 + 1);
    expect((await env.whitelistSync().runOnce()).activated).toBe(1);
    expect((await requestRow(request.id)).status).toBe('ACTIVE');
    const activated = await nextEmail(user.account.email, 'Destino autorizado activo');
    expect(activated.text).toContain(`Dirección: ${groupedAddress(destination)}`);
    const notifications = await env.base.db.app
      .selectFrom('notifications')
      .select('type')
      .where('user_id', '=', user.account.id)
      .execute();
    expect(notifications.map((n) => n.type)).toEqual(
      expect.arrayContaining(['WHITELIST_REQUESTED', 'WHITELIST_ACTIVATED']),
    );
    await env.chain.fund(env.base.snapshot.tokens.USDC, USDC_HOLDER, wallet.safe, 5_000_000n);
    expect(await prepareSend(destination)).toMatchObject({
      operationType: 'SEND',
      decoded: { destination, token: 'USDC' },
    });

    const events = (await auditOf(request.id)).map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(['WHITELIST_REQUESTED', 'WHITELIST_CHALLENGE_PASSED', 'WHITELIST_CONFIRMED_ONCHAIN']),
    );
    const entryRow = await env.base.db.app
      .selectFrom('whitelisted_destinations')
      .select('id')
      .where('destination', '=', addressToBuffer(destination))
      .executeTakeFirstOrThrow();
    expect((await auditOf(entryRow.id)).map((e) => e.event)).toContain('WHITELIST_ACTIVATED');
  });

  it('challenge vencido: el código ya no sirve y el pedido queda EXPIRED', async () => {
    const { request, code } = await requestWithCode(randomDestination());
    const row = await requestRow(request.id);
    await env.base.db.app
      .updateTable('security_challenges')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', row.challenge_id ?? '')
      .execute();
    const confirmed = await confirmWhitelist(wallet, request.id, code);
    expect(confirmed.statusCode).toBe(400);
    expect(confirmed.json()).toMatchObject({ code: 'INVALID_CODE' });
    expect(await requestRow(request.id)).toMatchObject({ status: 'EXPIRED', failure_reason: 'CHALLENGE_EXPIRED' });
    expect(await auditOf(request.id)).toContainEqual({
      event: 'WHITELIST_CHALLENGE_FAILED',
      payload: expect.objectContaining({ result: 'EXPIRED' }) as unknown,
    });
  });

  it('código reusado: una vez usado no vuelve a servir, tampoco en otro pedido', async () => {
    const first = await requestWithCode(randomDestination());
    const ok = await confirmWhitelist(wallet, first.request.id, first.code);
    expect(ok.statusCode, ok.body).toBe(200);
    // El mismo pedido ya no espera un código.
    const again = await confirmWhitelist(wallet, first.request.id, first.code);
    expect(again.statusCode).toBe(409);
    // En otro pedido el código del primero es incorrecto (cada challenge tiene el suyo) y el intento se cuenta.
    const second = await requestWithCode(randomDestination());
    const reused = await confirmWhitelist(wallet, second.request.id, first.code);
    expect(reused.statusCode).toBe(400);
    const challenge = await env.base.db.app
      .selectFrom('security_challenges')
      .select(['attempts', 'consumed_at'])
      .where('id', '=', (await requestRow(second.request.id)).challenge_id ?? '')
      .executeTakeFirstOrThrow();
    expect(challenge).toMatchObject({ attempts: 1, consumed_at: null });
    expect((await requestRow(second.request.id)).status).toBe('PENDING_CHALLENGE');
    // Con su propio código sí.
    const own = await confirmWhitelist(wallet, second.request.id, second.code);
    expect(own.statusCode, own.body).toBe(200);
  });

  it('challenge con otra dirección (binding adulterado en la base): rechazo y pedido FAILED', async () => {
    const { request, code } = await requestWithCode(randomDestination());
    const row = await requestRow(request.id);
    await env.base.db.app
      .updateTable('security_challenges')
      .set({ binding: sql`jsonb_set(binding, '{destination}', ${JSON.stringify(randomDestination())}::jsonb)` })
      .where('id', '=', row.challenge_id ?? '')
      .execute();
    const confirmed = await confirmWhitelist(wallet, request.id, code);
    expect(confirmed.statusCode).toBe(400);
    expect(await requestRow(request.id)).toMatchObject({
      status: 'FAILED',
      failure_reason: 'CHALLENGE_BINDING_MISMATCH',
    });
    expect(await auditOf(request.id)).toContainEqual({
      event: 'WHITELIST_CHALLENGE_FAILED',
      payload: expect.objectContaining({ result: 'BINDING_MISMATCH' }) as unknown,
    });
    expect((await requestRow(request.id)).operation_id).toBeNull();
  });

  it('5 intentos fallidos agotan el challenge', async () => {
    const { request, code } = await requestWithCode(randomDestination());
    const wrong = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 4; i++) {
      expect((await confirmWhitelist(wallet, request.id, wrong)).statusCode).toBe(400);
      expect((await requestRow(request.id)).status).toBe('PENDING_CHALLENGE');
    }
    expect((await confirmWhitelist(wallet, request.id, wrong)).statusCode).toBe(400);
    expect(await requestRow(request.id)).toMatchObject({ status: 'FAILED', failure_reason: 'CHALLENGE_EXHAUSTED' });
    expect((await confirmWhitelist(wallet, request.id, code)).statusCode).toBe(409);
  });
});

describe('pedido: idempotencia, duplicados y validaciones', () => {
  it('mismo Idempotency-Key → misma respuesta y un solo email; un pedido nuevo del mismo destino reemplaza al pendiente', async () => {
    const destination = randomDestination();
    const key = idempotencyKey();
    const first = await requestWhitelist(wallet, { destination, label: 'Caja' }, key);
    expect(first.statusCode, first.body).toBe(201);
    const replay = await requestWhitelist(wallet, { destination, label: 'Caja' }, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const rows = await env.base.db.app
      .selectFrom('whitelist_requests')
      .select(['id', 'status'])
      .where('destination', '=', addressToBuffer(destination))
      .execute();
    expect(rows).toHaveLength(1);
    const email = await nextEmail(wallet.onboarded.user.account.email, 'Confirmá el nuevo destino autorizado');
    // Otro pedido del mismo destino (el email no llegó): reemplaza al anterior, cuyo código deja de servir.
    const second = await requestWithCode(destination, 'Caja');
    expect(second.request.id).not.toBe(first.json<RequestView>().id);
    expect(await requestRow(first.json<RequestView>().id)).toMatchObject({
      status: 'CANCELLED',
      failure_reason: 'SUPERSEDED',
    });
    expect((await confirmWhitelist(wallet, first.json<RequestView>().id, codeFrom(email))).statusCode).toBe(409);
    const ok = await confirmWhitelist(wallet, second.request.id, second.code);
    expect(ok.statusCode, ok.body).toBe(200);
    // Con un alta confirmada en curso, otro pedido del mismo destino es un duplicado.
    const duplicate = await requestWhitelist(wallet, { destination, label: 'Caja' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'WHITELIST_DUPLICATE' });
  });

  it('un destino activo o en activación no se puede volver a pedir', async () => {
    const destination = randomDestination();
    await addDestination(destination);
    const duplicate = await requestWhitelist(wallet, { destination, label: 'Otra vez' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'WHITELIST_DUPLICATE', detail: 'el destino ya está en activación' });
  });

  it('destinos inválidos: 422 con el motivo (formato, checksum, cero, la propia Safe, tokens y contratos del sistema)', async () => {
    const s = env.base.snapshot;
    const valid = randomDestination();
    const index = valid.split('').findIndex((c, i) => i > 1 && /[a-f]/.test(c));
    const flipped =
      index > 0 ? `${valid.slice(0, index)}${(valid[index] ?? '').toUpperCase()}${valid.slice(index + 1)}` : null;
    const cases: [string, string][] = [
      ['0x1234', 'INVALID_FORMAT'],
      ['0x0000000000000000000000000000000000000000', 'ZERO_ADDRESS'],
      [wallet.safe, 'OWN_SAFE'],
      [s.tokens.USDC, 'TOKEN_CONTRACT'],
      [s.tokens.USDT, 'TOKEN_CONTRACT'],
      [s.contracts.securityGuard, 'SYSTEM_CONTRACT'],
      [s.contracts.swapExecutor, 'SYSTEM_CONTRACT'],
      [s.contracts.destinationWhitelist, 'SYSTEM_CONTRACT'],
      ...(flipped && flipped !== valid ? ([[flipped, 'BAD_CHECKSUM']] as [string, string][]) : []),
    ];
    for (const [destination, problem] of cases) {
      await resetRateLimits(env.base.redis);
      const response = await requestWhitelist(wallet, { destination, label: 'X' });
      expect(response.statusCode, destination).toBe(422);
      expect(response.json(), destination).toMatchObject({ code: 'DESTINATION_INVALID', detail: problem });
    }
    // Etiqueta con un override bidi (puede disfrazar una dirección en la UI o el email).
    const bidi = await requestWhitelist(wallet, { destination: valid, label: 'Pago ‮' });
    expect(bidi.statusCode).toBe(400);
  });

  it('reintento del prepare sin otro código dentro de la ventana; fuera de ella el pedido vence', async () => {
    const { request, code } = await requestWithCode(randomDestination());
    // Como si el prepare hubiera fallado por un error transitorio después de superar el challenge.
    await env.base.db.app
      .updateTable('whitelist_requests')
      .set({ status: 'CHALLENGE_PASSED', challenge_passed_at: new Date() })
      .where('id', '=', request.id)
      .execute();
    await env.base.db.app
      .updateTable('security_challenges')
      .set({ consumed_at: new Date() })
      .where('id', '=', (await requestRow(request.id)).challenge_id ?? '')
      .execute();
    const retried = await confirmWhitelist(wallet, request.id, code);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json<{ request: RequestView }>().request.status).toBe('AWAITING_SIGNATURE');

    const late = await requestWithCode(randomDestination());
    await env.base.db.app
      .updateTable('whitelist_requests')
      .set({ status: 'CHALLENGE_PASSED', challenge_passed_at: new Date(Date.now() - 16 * 60_000) })
      .where('id', '=', late.request.id)
      .execute();
    const expired = await confirmWhitelist(wallet, late.request.id, late.code);
    expect(expired.statusCode).toBe(400);
    expect(await requestRow(late.request.id)).toMatchObject({
      status: 'EXPIRED',
      failure_reason: 'NOT_PREPARED_IN_TIME',
    });
  });

  it('un pedido cuya operación vence sin firma queda EXPIRED (la sincronización del worker)', async () => {
    const { request, code } = await requestWithCode(randomDestination());
    const confirmed = await confirmWhitelist(wallet, request.id, code);
    const { operation } = confirmed.json<{ operation: PreparedOperation }>();
    await env.base.db.app
      .updateTable('wallet_operations')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', operation.operationId)
      .execute();
    await env.operations.sweep();
    expect(await statusOf(env, operation.operationId)).toBe('EXPIRED');
    await env.whitelistSync().runOnce();
    expect(await requestRow(request.id)).toMatchObject({ status: 'EXPIRED', failure_reason: 'NOT_SIGNED_IN_TIME' });
  });
});

describe('bajas y altas por fuera', () => {
  it('baja con U: removeDestination inmediata → REMOVED con email y auditoría', async () => {
    const destination = randomDestination();
    await addDestination(destination, 'Para quitar');
    const prepared = await critical(
      wallet.onboarded.user.wallet,
      sessionOf(wallet),
      `/wallets/${wallet.walletId}/whitelist/${destination}/remove`,
      {},
      { idempotencyKey: idempotencyKey() },
    );
    expect(prepared.statusCode, prepared.body).toBe(200);
    const operation = prepared.json<PreparedOperation>();
    expect(operation).toMatchObject({ operationType: 'WHITELIST_REMOVE', decoded: { destination } });
    await signAndExecute(operation);
    const entry = await env.base.db.app
      .selectFrom('whitelisted_destinations')
      .selectAll()
      .where('destination', '=', addressToBuffer(destination))
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ status: 'REMOVED', removed_by: 'U' });
    const email = await nextEmail(wallet.onboarded.user.account.email, 'Destino autorizado eliminado');
    expect(email.text).toContain(`Dirección: ${groupedAddress(destination)}`);
    expect(email.text).toContain('tu clave de usuario');
    // Un destino que no está en la lista on-chain no se puede quitar.
    const missing = await critical(
      wallet.onboarded.user.wallet,
      sessionOf(wallet),
      `/wallets/${wallet.walletId}/whitelist/${randomDestination()}/remove`,
      {},
      { idempotencyKey: idempotencyKey() },
    );
    expect(missing.statusCode).toBe(404);
  });

  it('baja de emergencia con R desde Recovery (scope RECOVERY): removedBy R', async () => {
    const destination = randomDestination();
    await addDestination(destination, 'Emergencia');
    const user = wallet.onboarded.user;
    const recovery = await stepUp(user.recovery, user.account.email, 'RECOVERY');
    // En el listener de Wallet no existe la ruta de emergencia, y en Recovery no existe el alta.
    const viaWallet = await critical(
      user.wallet,
      sessionOf(wallet),
      `/wallets/${wallet.walletId}/emergency/whitelist-remove`,
      { destination },
      { idempotencyKey: idempotencyKey() },
    );
    expect(viaWallet.statusCode).toBe(404);
    const addViaRecovery = await critical(
      user.recovery,
      recovery,
      `/wallets/${wallet.walletId}/whitelist/requests`,
      { destination: randomDestination(), label: 'X' },
      { idempotencyKey: idempotencyKey() },
    );
    expect(addViaRecovery.statusCode).toBe(404);
    const prepared = await critical(
      user.recovery,
      recovery,
      `/wallets/${wallet.walletId}/emergency/whitelist-remove`,
      { destination },
      { idempotencyKey: idempotencyKey() },
    );
    expect(prepared.statusCode, prepared.body).toBe(200);
    const operation = prepared.json<PreparedOperation>();
    const body = {
      ...(await submissionBody(wallet, operation, { signer: wallet.recoveryKey, session: recovery })),
      ownerRole: 'R',
    };
    const signed = await critical(user.recovery, recovery, `/operations/${operation.operationId}/signatures`, body, {
      idempotencyKey: idempotencyKey(),
    });
    expect(signed.statusCode, signed.body).toBe(200);
    await env.pipeline().processWallet(wallet.walletId);
    expect(await statusOf(env, operation.operationId)).toBe('MINED');
    await syncChain(env);
    const entry = await env.base.db.app
      .selectFrom('whitelisted_destinations')
      .select(['status', 'removed_by'])
      .where('destination', '=', addressToBuffer(destination))
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({ status: 'REMOVED', removed_by: 'R' });
    const email = await nextEmail(user.account.email, 'Destino autorizado eliminado');
    expect(email.text).toContain('tu clave de recuperación');
    // R no puede preparar un alta (el servicio la rechaza aunque se llame por dentro).
    const services = env.base.wallet.wallets;
    if (!services) throw new Error('el listener de Wallet no tiene los servicios de wallets');
    await expect(
      services.whitelist.request(
        actorFor(user.account.id, recovery),
        wallet.walletId,
        { destination: randomDestination(), label: 'X' },
        { userAgent: null },
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
  });

  it('alta soberana U+R por fuera de la plataforma: aparece como SOVEREIGN con notificación', async () => {
    const destination = randomDestination();
    await env.chain.execSovereign(
      wallet.safe,
      {
        to: env.base.snapshot.contracts.destinationWhitelist,
        data: encodeFunctionData({ abi: destinationWhitelistAbi, functionName: 'addDestination', args: [destination] }),
      },
      [wallet.userKey, wallet.recoveryKey],
    );
    await syncChain(env);
    const entry = await env.base.db.app
      .selectFrom('whitelisted_destinations')
      .selectAll()
      .where('destination', '=', addressToBuffer(destination))
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({
      status: 'ACTIVATING',
      origin: 'SOVEREIGN',
      label: 'Agregado con U+R',
      request_id: null,
    });
    const notification = await env.base.db.app
      .selectFrom('notifications')
      .select(['type', 'payload'])
      .where('type', '=', 'WHITELIST_ADDED_SOVEREIGN')
      .where(sql<boolean>`payload ->> 'destination' = ${destination}`)
      .executeTakeFirst();
    expect(notification).toBeDefined();
    // El evento se aplica una sola vez.
    await syncChain(env);
    const count = await env.base.db.app
      .selectFrom('whitelisted_destinations')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('destination', '=', addressToBuffer(destination))
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(1);
  });
});
