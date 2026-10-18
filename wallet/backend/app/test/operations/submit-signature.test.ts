// P13.T03: POST /operations/{id}/signatures (crítico) por la API real: firma ECDSA estricta contra el rol vigente
// on-chain, envelope de envío ligado a la operación, la SafeTx y la sesión (firmado por la session key, dentro de la
// vigencia y con submittedAt ±60 s), SafeTxHash recalculado, policy y 2FA → USER_SIGNED → QUEUED + outbox en una
// transacción. Rechazos: firma de otra clave o no estricta, envelope adulterado, rol/scope cruzado, IDOR, operación
// vencida, ya firmada, nonce consumido, policy rechazada y 2FA faltante. También R firmando por el listener de
// Recovery (scope RECOVERY).
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, getAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationWhitelistAbi } from '../../src/chain/abis/index.ts';
import { SECP256K1_N } from '../../src/chain/signatures.ts';
import { submissionCanonical } from '../../src/platform-session/request-signature.ts';
import { critical, idempotencyKey, resetRateLimits, stepUp } from '../helpers/onboarding.ts';
import {
  activeWallet,
  actorFor,
  auditTypes,
  noopCall,
  operationRow,
  prepare,
  sendCall,
  startOperationsEnv,
  statusOf,
  submissionBody,
  submitSignature,
  USDC_HOLDER,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { newSessionKey, signP256 } from '../helpers/platform.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;
let other: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.submitSignature });
  [wallet, other] = [await activeWallet(env), await activeWallet(env)];
}, 900_000);

afterAll(async () => {
  await env.close();
});

/** La misma firma con s en la mitad alta (maleable): válida para ecrecover, rechazada por la validación estricta. */
function highS(signature: Hex): Hex {
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return `${signature.slice(0, 66)}${(SECP256K1_N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
}

describe('POST /operations/{id}/signatures', () => {
  it('firma válida de U: QUEUED, envelope y sesión guardados, evento de outbox y auditoría en la misma transacción', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    expect(prepared.typedData).toMatchObject({
      primaryType: 'SafeTx',
      domain: { chainId: 8453, verifyingContract: wallet.safe },
    });
    const body = await submissionBody(wallet, prepared);
    const response = await submitSignature(wallet, prepared.operationId, body);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: prepared.operationId, status: 'QUEUED', operationType: 'NOOP_CANCEL' });
    const row = await operationRow(env, prepared.operationId);
    expect(row).toMatchObject({
      status: 'QUEUED',
      owner_role: 'U',
      platform_session_id: wallet.session.sessionId,
      platform_session_token: wallet.session.token,
      submission_envelope_signature: body.submissionEnvelopeSignature,
      submission_envelope: body.submissionEnvelope,
      policy_snapshot_version: env.base.snapshot.version,
    });
    expect(`0x${row.owner_signature?.toString('hex') ?? ''}`).toBe(body.ownerSignature.toLowerCase());
    expect(await auditTypes(env, prepared.operationId)).toEqual([
      'OPERATION_PROPOSED',
      'OPERATION_USER_SIGNED',
      'OPERATION_SIGNATURE_RECEIVED',
      'OPERATION_QUEUED',
    ]);
    const outbox = await env.base.db.app
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', prepared.operationId)
      .execute();
    expect(outbox.map((o) => o.event_type)).toEqual(['OPERATION_QUEUED']);
  });

  it('firma de otra clave, firma no estricta (s alto) o v fuera de {27,28}: SIGNATURE_INVALID y sigue CREATED', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    const stranger = privateKeyToAccount(generatePrivateKey());
    const foreign = await submissionBody(wallet, prepared, { signer: stranger });
    let response = await submitSignature(wallet, prepared.operationId, foreign);
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    const valid = await submissionBody(wallet, prepared);
    response = await submitSignature(wallet, prepared.operationId, {
      ...valid,
      ownerSignature: highS(valid.ownerSignature),
    });
    expect(response.json()).toMatchObject({
      code: 'SIGNATURE_INVALID',
      detail: expect.stringContaining('HIGH_S') as unknown,
    });
    response = await submitSignature(wallet, prepared.operationId, {
      ...valid,
      ownerSignature: `${valid.ownerSignature.slice(0, 130)}00`,
    });
    expect(response.json()).toMatchObject({ code: 'SIGNATURE_INVALID' });
    expect(await statusOf(env, prepared.operationId)).toBe('CREATED');
  });

  it('envelope adulterado (otra operación, otra SafeTx, otra sesión, fuera de ventana, firma de otra key): SUBMISSION_INVALID', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    const valid = await submissionBody(wallet, prepared);
    const resign = (envelope: typeof valid.submissionEnvelope, key = wallet.session.key) => ({
      ...valid,
      submissionEnvelope: envelope,
      submissionEnvelopeSignature: signP256(key, submissionCanonical(envelope)),
    });
    const cases = [
      resign({ ...valid.submissionEnvelope, operationId: crypto.randomUUID() }),
      resign({ ...valid.submissionEnvelope, safeTxHash: `0x${randomBytes(32).toString('hex')}` }),
      resign({ ...valid.submissionEnvelope, sessionId: crypto.randomUUID() }),
      resign({ ...valid.submissionEnvelope, submittedAt: valid.submissionEnvelope.submittedAt - 300 }),
      resign(valid.submissionEnvelope, newSessionKey()),
    ];
    for (const body of cases) {
      const response = await submitSignature(wallet, prepared.operationId, body);
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json()).toMatchObject({ code: 'SUBMISSION_INVALID' });
    }
    expect(await statusOf(env, prepared.operationId)).toBe('CREATED');
  });

  it('R no firma por el listener de Wallet; la operación de otro usuario no existe para mí (404, [B-AUTHZ])', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    const asR = { ...(await submissionBody(wallet, prepared, { signer: wallet.recoveryKey })), ownerRole: 'R' };
    const response = await submitSignature(wallet, prepared.operationId, asR);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });

    const foreign = await prepare(env, other, noopCall(other));
    const idor = await submitSignature(wallet, foreign.operationId, await submissionBody(wallet, foreign));
    expect(idor.statusCode).toBe(404);
    const read = await wallet.onboarded.user.wallet.get(`/api/v1/operations/${foreign.operationId}`);
    expect(read.statusCode).toBe(404);
    const list = await wallet.onboarded.user.wallet.get(`/api/v1/wallets/${other.walletId}/operations`);
    expect(list.statusCode).toBe(404);
  });

  it('operación vencida (15 min sin firma): OPERATION_EXPIRED, queda EXPIRED y su nonce vuelve a estar disponible', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    await env.base.db.app
      .updateTable('wallet_operations')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', prepared.operationId)
      .execute();
    const response = await submitSignature(wallet, prepared.operationId, await submissionBody(wallet, prepared));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'OPERATION_EXPIRED' });
    expect(await statusOf(env, prepared.operationId)).toBe('EXPIRED');
    const again = await prepare(env, wallet, noopCall(wallet));
    expect(again.safeTx.nonce).toBe(prepared.safeTx.nonce);
  });

  it('ya firmada: la misma firma devuelve el estado actual; otra firma → OPERATION_NOT_PENDING', async () => {
    const prepared = await prepare(env, wallet, noopCall(wallet));
    const body = await submissionBody(wallet, prepared);
    expect((await submitSignature(wallet, prepared.operationId, body)).statusCode).toBe(200);
    const replay = await submitSignature(wallet, prepared.operationId, body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'QUEUED' });
    const otherSignature = await submissionBody(wallet, prepared, {
      signer: privateKeyToAccount(generatePrivateKey()),
    });
    const conflict = await submitSignature(wallet, prepared.operationId, otherSignature);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'OPERATION_NOT_PENDING' });
  });

  it('nonce consumido por fuera (ejecución soberana U+R) antes de firmar: NONCE_CONSUMED y la operación queda CANCELLED', async () => {
    const fresh = await activeWallet(env);
    const prepared = await prepare(env, fresh, noopCall(fresh));
    await env.chain.execSovereign(fresh.safe, { to: fresh.safe, data: '0x' }, [fresh.userKey, fresh.recoveryKey]);
    const response = await submitSignature(fresh, prepared.operationId, await submissionBody(fresh, prepared));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'NONCE_CONSUMED' });
    expect(await operationRow(env, prepared.operationId)).toMatchObject({
      status: 'CANCELLED',
      failure_reason: 'NONCE_CONSUMED',
    });
  });

  it('SEND: el destino dejó de estar whitelisteado entre prepare y la firma → POLICY_REJECTED; sobre el umbral sin 2FA → TWO_FACTOR_REQUIRED', async () => {
    const fresh = await activeWallet(env);
    const usdc = env.base.snapshot.tokens.USDC;
    const whitelist = env.base.snapshot.contracts.destinationWhitelist;
    const destination = getAddress(`0x${randomBytes(20).toString('hex')}`);
    await env.chain.fund(usdc, USDC_HOLDER, fresh.safe, 3_000_000_000n);
    await env.chain.whitelistSovereign(fresh.safe, whitelist, destination, [fresh.userKey, fresh.recoveryKey]);

    // 2FA: 1.500 USDC ≥ umbral (1.000): prepare lo marca y la firma sin challenge completado se rechaza.
    const big = await prepare(env, fresh, sendCall(env, fresh, 'USDC', destination, 1_500_000_000n));
    expect(big.requiresTwoFactor).toBe(true);
    const twoFactor = await submitSignature(fresh, big.operationId, await submissionBody(fresh, big));
    expect(twoFactor.statusCode, twoFactor.body).toBe(403);
    expect(twoFactor.json()).toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });

    // Un SEND preparado con el destino activo en el nonce n+1; la baja soberana del destino consume el nonce n.
    const send = await prepare(env, fresh, sendCall(env, fresh, 'USDC', destination, 2_000_000n));
    expect(BigInt(send.safeTx.nonce)).toBe(BigInt(big.safeTx.nonce) + 1n);
    await env.chain.execSovereign(
      fresh.safe,
      {
        to: whitelist,
        data: encodeFunctionData({
          abi: destinationWhitelistAbi,
          functionName: 'removeDestination',
          args: [destination],
        }),
      },
      [fresh.userKey, fresh.recoveryKey],
    );
    const rejected = await submitSignature(fresh, send.operationId, await submissionBody(fresh, send));
    expect(rejected.statusCode, rejected.body).toBe(422);
    expect(rejected.json()).toMatchObject({ code: 'POLICY_REJECTED', detail: 'DESTINATION_NOT_WHITELISTED' });
    expect(await statusOf(env, send.operationId)).toBe('CREATED');
  });

  it('lecturas: listado paginado por cursor (más recientes primero) y detalle con historial', async () => {
    const first = await wallet.onboarded.user.wallet.get(`/api/v1/wallets/${wallet.walletId}/operations?limit=2`);
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<{ items: { id: string; history: { status: string }[] }[]; nextCursor: string | null }>();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(page.items[1]?.id);
    expect((page.items[0]?.id ?? '') > (page.items[1]?.id ?? '')).toBe(true);
    const second = await wallet.onboarded.user.wallet.get(
      `/api/v1/wallets/${wallet.walletId}/operations?limit=2&before=${page.nextCursor ?? ''}`,
    );
    const next = second.json<{ items: { id: string }[] }>();
    expect(next.items.length).toBeGreaterThan(0);
    expect(next.items.every((i) => i.id < (page.nextCursor ?? ''))).toBe(true);
    const detail = await wallet.onboarded.user.wallet.get(`/api/v1/operations/${page.items[0]?.id ?? ''}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ history: { status: string }[] }>().history[0]?.status).toBe('CREATED');
  });

  it('R firma por el listener de Recovery con una PlatformSession RECOVERY (step-up)', async () => {
    await resetRateLimits(env.base.redis);
    const user = wallet.onboarded.user;
    const recovery = await stepUp(user.recovery, user.account.email, 'RECOVERY');
    const actor = actorFor(user.account.id, recovery);
    const prepared = await env.operations.prepare(actor, noopCall(wallet));
    const body = {
      ...(await submissionBody(wallet, prepared, { signer: wallet.recoveryKey, session: recovery })),
      ownerRole: 'R',
    };
    const response = await critical(user.recovery, recovery, `/operations/${prepared.operationId}/signatures`, body, {
      idempotencyKey: idempotencyKey(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await operationRow(env, prepared.operationId)).toMatchObject({ status: 'QUEUED', owner_role: 'R' });
    // Y U no puede firmar una operación preparada para R.
    const forU = await env.operations.prepare(actor, noopCall(wallet));
    const viaWallet = await submitSignature(wallet, forU.operationId, await submissionBody(wallet, forU));
    expect(viaWallet.statusCode).toBe(403);
  });
});
