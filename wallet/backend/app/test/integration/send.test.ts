// P14.T03 / P14.TST.c: send real de USDC y USDT a un destino activo de la whitelist con los saldos verificados
// on-chain; 2FA sobre el umbral (OTP por email o TOTP si está activo) ligado a la SafeTx, con la atestación
// ChallengeCompletion que exige el signer, y aviso de operación de alto valor ejecutada; rechazos de la policy por la
// API (destino no whitelisteado, saldo, límites, mínimo) y 2FA que no sirve para otra operación.
import { randomBytes } from 'node:crypto';
import { Secret as OtpSecret } from 'otpauth';
import { getAddress, type Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/auth/totp.ts';
import { groupedAddress } from '../../src/email/format.ts';
import type { OperationView, PreparedOperation } from '../../src/operations/intent.ts';
import { codeFrom } from '../helpers/mailpit.ts';
import { critical, idempotencyKey, resetRateLimits } from '../helpers/onboarding.ts';
import {
  activeWallet,
  expireCreated,
  nextEmail,
  operationRow,
  refreshSession,
  settle,
  startOperationsEnv,
  statusOf,
  submissionBody,
  submitSignature,
  USDC_HOLDER,
  USDT_HOLDER,
  walletPost,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;
let destination: Address;
let usdc: Address;
let usdt: Address;

const UNIT = 1_000_000n;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.send });
  wallet = await activeWallet(env);
  usdc = env.base.snapshot.tokens.USDC;
  usdt = env.base.snapshot.tokens.USDT;
  await env.chain.fund(usdc, USDC_HOLDER, wallet.safe, 3_000n * UNIT);
  await env.chain.fund(usdt, USDT_HOLDER, wallet.safe, 2_000n * UNIT);
  destination = getAddress(`0x${randomBytes(20).toString('hex')}`);
  // Destino activo (alta U+R y 24 h on-chain); el flujo de alta de la plataforma lo prueba whitelist-challenge.
  await env.chain.whitelistSovereign(wallet.safe, env.base.snapshot.contracts.destinationWhitelist, destination, [
    wallet.userKey,
    wallet.recoveryKey,
  ]);
}, 600_000);

afterAll(async () => {
  await env.close();
});

beforeEach(async () => {
  await resetRateLimits(env.base.redis);
  await expireCreated(env, wallet);
});

function sendPrepare(body: Record<string, unknown>) {
  return walletPost(wallet, `/wallets/${wallet.walletId}/send/prepare`, body);
}

async function prepareSend(token: 'USDC' | 'USDT', amount: bigint, to: Address = destination) {
  const response = await sendPrepare({ token, destination: to, amount: amount.toString() });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PreparedOperation>();
}

function twoFactor(operationId: string, body: Record<string, unknown> = {}) {
  return walletPost(wallet, `/operations/${operationId}/two-factor`, body);
}

async function execute(prepared: PreparedOperation, extra: Record<string, unknown> = {}) {
  const signed = await submitSignature(wallet, prepared.operationId, {
    ...(await submissionBody(wallet, prepared)),
    ...extra,
  });
  expect(signed.statusCode, signed.body).toBe(200);
  expect(signed.json<OperationView>().status).toBe('QUEUED');
  await env.pipeline().processWallet(wallet.walletId);
  expect(await statusOf(env, prepared.operationId)).toBe('MINED');
}

describe('send', () => {
  it('USDC y USDT debajo del umbral: prepare → firma U → ejecución por S; los saldos se mueven on-chain', async () => {
    for (const [token, address] of [
      ['USDC', usdc],
      ['USDT', usdt],
    ] as const) {
      const safeBefore = await env.chain.tokenBalance(address, wallet.safe);
      const destBefore = await env.chain.tokenBalance(address, destination);
      const prepared = await prepareSend(token, 25n * UNIT);
      expect(prepared).toMatchObject({
        operationType: 'SEND',
        requiresTwoFactor: false,
        decoded: { token, amount: (25n * UNIT).toString(), destination },
        safeTx: { to: address, value: '0', operation: 0 },
      });
      await execute(prepared);
      expect(await env.chain.tokenBalance(address, wallet.safe)).toBe(safeBefore - 25n * UNIT);
      expect(await env.chain.tokenBalance(address, destination)).toBe(destBefore + 25n * UNIT);
    }
  });

  it('sobre el umbral: sin 2FA no se acepta la firma; OTP por email ligado a la operación → atestación → ejecución y aviso de alto valor', async () => {
    const user = wallet.onboarded.user;
    const amount = 1_500n * UNIT;
    const prepared = await prepareSend('USDC', amount);
    expect(prepared.requiresTwoFactor).toBe(true);
    const early = await submitSignature(wallet, prepared.operationId, await submissionBody(wallet, prepared));
    expect(early.statusCode).toBe(403);
    expect(early.json()).toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    expect(await statusOf(env, prepared.operationId)).toBe('CREATED');
    // Sin pedir el código primero no hay nada que verificar.
    expect((await twoFactor(prepared.operationId, { code: '12345678' })).statusCode).toBe(400);

    const started = await twoFactor(prepared.operationId);
    expect(started.statusCode, started.body).toBe(202);
    const challenge = started.json<{ method: string; challengeId: string; expiresAt: string }>();
    expect(challenge.method).toBe('EMAIL');
    const email = await nextEmail(user.account.email, 'Confirmá una operación de alto valor');
    expect(email.text).toContain('Acción: Envío de 1500 USDC');
    expect(email.text).toContain(`Destino: ${groupedAddress(destination)}`);
    expect(email.text).toContain(`Nonce de la Safe: ${prepared.safeTx.nonce}`);
    expect(email.text).toContain('Red: Base fork local — chainId 8453');
    const code = codeFrom(email);
    const wrong = code === '00000000' ? '11111111' : '00000000';
    expect((await twoFactor(prepared.operationId, { code: wrong })).statusCode).toBe(400);
    const verified = await twoFactor(prepared.operationId, { code });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json<OperationView>()).toMatchObject({ id: prepared.operationId, status: 'CREATED' });
    const row = await operationRow(env, prepared.operationId);
    expect(row.two_factor_challenge_id).toBe(challenge.challengeId);
    const claims = await env.issuer.verifyChallengeCompletion(row.challenge_attestation ?? '');
    expect(claims).toMatchObject({
      challengeId: challenge.challengeId,
      type: 'HIGH_VALUE_TX',
      action: 'SEND',
      userId: user.account.id,
      safe: wallet.safe,
      destination,
      token: usdc,
      amount: amount.toString(),
      safeTxHash: prepared.safeTxHash,
      nonce: Number(prepared.safeTx.nonce),
    });
    // Ya completo: no se pide otro.
    expect((await twoFactor(prepared.operationId)).statusCode).toBe(409);

    const safeBefore = await env.chain.tokenBalance(usdc, wallet.safe);
    await execute(prepared, { twoFactorChallengeId: challenge.challengeId });
    expect(await env.chain.tokenBalance(usdc, wallet.safe)).toBe(safeBefore - amount);
    await settle(env, prepared.operationId, 'CONFIRMED');
    expect(await env.highValue().runOnce()).toBe(1);
    const executed = await nextEmail(user.account.email, 'Operación de alto valor ejecutada');
    expect(executed.text).toContain('Se enviaron 1500 USDC.');
    expect(executed.text).toContain(`Destino: ${groupedAddress(destination)}`);
    // Una sola vez por operación.
    expect(await env.highValue().runOnce()).toBe(0);
    const audit = await env.base.db.app
      .selectFrom('audit_events')
      .select('event_type')
      .where('target_id', '=', prepared.operationId)
      .execute();
    expect(audit.map((a) => a.event_type)).toEqual(
      expect.arrayContaining(['TWO_FACTOR_REQUESTED', 'TWO_FACTOR_FAILED', 'TWO_FACTOR_PASSED']),
    );
  });

  it('el 2FA de una operación no sirve para otra (ni declarado en la firma ni copiado en la base)', async () => {
    const a = await prepareSend('USDC', 1_100n * UNIT);
    const b = await prepareSend('USDC', 1_100n * UNIT);
    expect((await twoFactor(a.operationId)).statusCode).toBe(202);
    const code = codeFrom(await nextEmail(wallet.onboarded.user.account.email, 'Confirmá una operación de alto valor'));
    expect((await twoFactor(a.operationId, { code })).statusCode).toBe(200);
    const rowA = await operationRow(env, a.operationId);
    // Declarar el challenge de A al firmar B.
    const declared = await submitSignature(wallet, b.operationId, {
      ...(await submissionBody(wallet, b)),
      twoFactorChallengeId: rowA.two_factor_challenge_id,
    });
    expect(declared.statusCode).toBe(403);
    // Copiar el challenge y la atestación de A en B: el binding es de la SafeTx de A.
    await env.base.db.app
      .updateTable('wallet_operations')
      .set({ two_factor_challenge_id: rowA.two_factor_challenge_id, challenge_attestation: rowA.challenge_attestation })
      .where('id', '=', b.operationId)
      .execute();
    const copied = await submitSignature(wallet, b.operationId, await submissionBody(wallet, b));
    expect(copied.statusCode).toBe(403);
    expect(copied.json()).toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    expect(await statusOf(env, b.operationId)).toBe('CREATED');
  });

  it('rechazos de la policy por la API: destino no whitelisteado, saldo, límites, mínimo y token o destino inválidos', async () => {
    const other = getAddress(`0x${randomBytes(20).toString('hex')}`);
    const cases: [Record<string, unknown>, number, Record<string, unknown>][] = [
      [
        { token: 'USDC', destination: other, amount: (5n * UNIT).toString() },
        422,
        { detail: 'DESTINATION_NOT_WHITELISTED' },
      ],
      [{ token: 'USDC', destination, amount: (9_000n * UNIT).toString() }, 422, { detail: 'INSUFFICIENT_BALANCE' }],
      [{ token: 'USDC', destination, amount: (10_001n * UNIT).toString() }, 422, { detail: 'LIMIT_PER_OPERATION' }],
      [{ token: 'USDT', destination, amount: '500000' }, 422, { detail: 'BELOW_MINIMUM' }],
      [
        { token: 'USDC', destination: usdc, amount: '5000000' },
        422,
        { code: 'DESTINATION_INVALID', detail: 'TOKEN_CONTRACT' },
      ],
      [
        { token: 'USDC', destination: wallet.safe, amount: '5000000' },
        422,
        { code: 'DESTINATION_INVALID', detail: 'OWN_SAFE' },
      ],
      [{ token: 'DAI', destination, amount: '5000000' }, 400, { code: 'VALIDATION_FAILED' }],
      [{ token: 'USDC', destination, amount: '1.5' }, 400, { code: 'VALIDATION_FAILED' }],
    ];
    for (const [body, status, problem] of cases) {
      const response = await sendPrepare(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(status);
      expect(response.json(), JSON.stringify(body)).toMatchObject(problem);
    }
    // El listener de Recovery no expone send ([B-AUTHZ] 3).
    const viaRecovery = await critical(
      wallet.onboarded.user.recovery,
      {
        token: wallet.session.token,
        sessionId: wallet.session.sessionId,
        key: wallet.session.key,
        walletId: wallet.walletId,
      },
      `/wallets/${wallet.walletId}/send/prepare`,
      { token: 'USDC', destination, amount: '5000000' },
      { idempotencyKey: idempotencyKey() },
    );
    expect(viaRecovery.statusCode).toBe(404);
  });

  it('con TOTP activo el factor es el TOTP (sin email); un TOTP incorrecto se rechaza', async () => {
    const browser = wallet.onboarded.user.wallet;
    const setup = await browser.post('/api/v1/auth/totp/setup', {});
    expect(setup.statusCode, setup.body).toBe(200);
    const secret = Buffer.from(OtpSecret.fromBase32(setup.json<{ secret: string }>().secret).bytes);
    const enabled = await browser.post('/api/v1/auth/totp/enable', { code: totpCode(secret) });
    expect(enabled.statusCode, enabled.body).toBe(200);
    // Activar el TOTP rota la sesión de cuenta: se vuelve a desbloquear la wallet con U.
    await refreshSession(wallet);
    const amount = 1_200n * UNIT;
    const prepared = await prepareSend('USDT', amount);
    expect(prepared.requiresTwoFactor).toBe(true);
    const started = await twoFactor(prepared.operationId);
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json()).toMatchObject({ method: 'TOTP' });
    // El paso actual lo consumió la activación (anti-replay): el siguiente.
    const next = totpCode(secret, Date.now() + 30_000);
    const wrong = next === '000000' ? '111111' : '000000';
    expect((await twoFactor(prepared.operationId, { code: wrong })).statusCode).toBe(400);
    const verified = await twoFactor(prepared.operationId, { code: next });
    expect(verified.statusCode, verified.body).toBe(200);
    const claims = await env.issuer.verifyChallengeCompletion(
      (await operationRow(env, prepared.operationId)).challenge_attestation ?? '',
    );
    expect(claims).toMatchObject({ type: 'HIGH_VALUE_TX', token: usdt, amount: amount.toString(), destination });
    const before = await env.chain.tokenBalance(usdt, destination);
    await execute(prepared);
    expect(await env.chain.tokenBalance(usdt, destination)).toBe(before + amount);
  });
});
