// P13.SEC: "S sólo firma vía signer tras checks; ninguna transición sin auditoría".
//
// - La base rechaza al confirmar cualquier cambio de estado de wallet_operations sin su evento OPERATION_<ESTADO> en la
//   misma transacción (constraint trigger), aun con el rol de la aplicación.
// - Después de ejecutar operaciones por todos los caminos (éxito, cancelación, rechazo), el historial auditado de cada
//   una es un camino válido de la máquina de estados que termina en su estado actual.
// - El backend no tiene ninguna clave secp256k1 ni código para firmar como S: la única firma del proceso es la del
//   emisor de sesiones (Ed25519).
// - Un backend comprometido que salte sus propios checks no obtiene la firma de S: el signer rechaza por su cuenta la
//   SafeTx que la policy no permite y la que no firmó U; y el worker no le pide nada al signer si la intención guardada
//   fue adulterada.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodeFunctionData, getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeTxHash } from '../../src/chain/safe-tx.ts';
import { withTransaction } from '../../src/db/transaction.ts';
import { safeTxFromJson, type CanonicalIntent, type PreparedOperation } from '../../src/operations/intent.ts';
import { ALLOWED_TRANSITIONS, OPERATION_STATUSES } from '../../src/operations/state-machine.ts';
import { SignerClientError } from '../../src/signer-client/client.ts';
import type { OperationStatus } from '../../src/db/schema.ts';
import {
  activeWallet,
  cancelOperation,
  noopCall,
  operationRow,
  prepare,
  queueOperation,
  revokeCall,
  startOperationsEnv,
  submissionBody,
  submitSignature,
  type ActiveWallet,
  type OperationsEnv,
} from '../helpers/operations.ts';
import { REDIS_DBS } from '../helpers/redis-dbs.ts';

let env: OperationsEnv;
let wallet: ActiveWallet;

beforeAll(async () => {
  env = await startOperationsEnv({ redisDb: REDIS_DBS.operationsSecurity });
  wallet = await activeWallet(env);
}, 600_000);

afterAll(async () => {
  await env.close();
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('ninguna transición sin auditoría', () => {
  it('la base rechaza un cambio de estado directo (rol de la aplicación) sin su evento de auditoría', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    await expect(
      env.base.db.app
        .updateTable('wallet_operations')
        .set({ status: 'VALIDATING' })
        .where('id', '=', prepared.operationId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    // Un evento de otro tipo o de otra operación tampoco alcanza.
    await expect(
      withTransaction(
        env.base.db.app,
        async (trx) => {
          await env.base.wallet.services.audit.append(trx, {
            actorType: 'WORKER',
            eventType: 'OPERATION_READY',
            targetType: 'operation',
            targetId: prepared.operationId,
          });
          await trx
            .updateTable('wallet_operations')
            .set({ status: 'VALIDATING' })
            .where('id', '=', prepared.operationId)
            .execute();
        },
        { auditLock: true },
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await operationRow(env, prepared.operationId)).status).toBe('QUEUED');
    // Por la máquina de estados (UPDATE + evento en la misma transacción) sí.
    await env.machine.transition({
      operationId: prepared.operationId,
      from: ['QUEUED'],
      to: 'VALIDATING',
      actor: { type: 'WORKER', id: 'sec-test' },
    });
    expect((await operationRow(env, prepared.operationId)).status).toBe('VALIDATING');
    // La deja lista para el resto (otro worker la retoma).
    await env.pipeline().processWallet(wallet.walletId);
    expect((await operationRow(env, prepared.operationId)).status).toBe('MINED');
  });

  it('el historial auditado de cada operación es un camino válido de la máquina de estados hasta su estado actual', async () => {
    // Éxito, cancelación sin firma, cancelación por NoOp y rechazo del worker.
    await queueOperation(env, wallet, noopCall(wallet));
    const created = await prepare(env, wallet, revokeCall(env, wallet));
    expect((await cancelOperation(wallet, created.operationId)).statusCode).toBe(200);
    const original = await queueOperation(env, wallet, revokeCall(env, wallet));
    const cancelled = await cancelOperation(wallet, original.operationId);
    const noop = cancelled.json<{ noop: PreparedOperation }>().noop;
    const signed = await submitSignature(wallet, noop.operationId, await submissionBody(wallet, noop));
    expect(signed.statusCode, signed.body).toBe(200);
    await env.pipeline().processWallet(wallet.walletId);
    expect((await operationRow(env, original.operationId)).status).toBe('CANCELLED');
    expect((await operationRow(env, noop.operationId)).status).toBe('MINED');

    const ops = await env.base.db.app
      .selectFrom('wallet_operations')
      .select(['id', 'status'])
      .where('wallet_id', '=', wallet.walletId)
      .execute();
    expect(ops.length).toBeGreaterThanOrEqual(4);
    for (const op of ops) {
      const events = await env.base.db.app
        .selectFrom('audit_events')
        .select('event_type')
        .where('target_type', '=', 'operation')
        .where('target_id', '=', op.id)
        .orderBy('id')
        .execute();
      const path = events
        .map((e) => e.event_type.replace(/^OPERATION_/, ''))
        .filter((s): s is OperationStatus => (OPERATION_STATUSES as readonly string[]).includes(s));
      expect(events[0]?.event_type, op.id).toBe('OPERATION_PROPOSED');
      let current: OperationStatus = 'CREATED';
      for (const next of path) {
        expect(ALLOWED_TRANSITIONS[current], `${op.id}: ${current} → ${next}`).toContain(next);
        current = next;
      }
      expect(current, op.id).toBe(op.status);
    }
  });
});

describe('S sólo firma vía signer tras checks', () => {
  it('el backend no tiene claves secp256k1 ni código para firmar como S', () => {
    const src = resolve(import.meta.dirname, '../../src');
    const forbidden = [
      /from ['"]viem\/accounts['"]/,
      /privateKeyToAccount|signTransaction|signMessage|signTypedData\(/,
      /@noble\/curves|@noble\/secp256k1|ethers/,
    ];
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) expect(pattern.test(text), `${file}: ${String(pattern)}`).toBe(false);
    }
    // La única firma del proceso es la del emisor de sesiones (Ed25519, jose).
    const signers = sourceFiles(src).filter((f) => /\.sign\(/.test(readFileSync(f, 'utf8')));
    expect(signers.map((f) => f.slice(src.length + 1)).sort()).toEqual([
      'platform-session/sessions.ts',
      'platform-session/token.ts',
    ]);
  });

  it('un backend comprometido que salte la policy no obtiene la firma de S: el signer rechaza por su cuenta', async () => {
    // SEND a un destino nunca whitelisteado: el backend lo rechaza en prepare; un backend comprometido lo arma igual.
    const destination = getAddress(`0x${randomBytes(20).toString('hex')}`);
    const call = {
      to: env.base.snapshot.tokens.USDC,
      data: encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'transfer',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ name: '', type: 'bool' }],
          },
        ] as const,
        functionName: 'transfer',
        args: [destination, 1_000_000n],
      }),
    };
    await expect(
      prepare(env, wallet, { walletId: wallet.walletId, operationType: 'SEND', call }),
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });

    // La misma SafeTx firmada por U y enviada directo al signer (como lo haría un backend comprometido), sin pasar por
    // prepare: ninguna operación del backend la respalda.
    const onchainNonce = await env.chain.safeNonce(wallet.safe);
    const safeTx = {
      to: call.to,
      value: '0',
      data: call.data,
      operation: 0 as const,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000' as const,
      refundReceiver: '0x0000000000000000000000000000000000000000' as const,
      nonce: onchainNonce.toString(),
    };
    const forged = {
      operationId: crypto.randomUUID(),
      safe: wallet.safe,
      chainId: 8453,
      safeTx,
      safeTxHash: safeTxHash(8453, wallet.safe, safeTxFromJson(safeTx)),
    };
    const body = await submissionBody(wallet, forged);
    const fees = await env.base.rpc.feeData();
    const accountNonce = await env.chain.public.getTransactionCount({ address: wallet.executor, blockTag: 'latest' });
    const request = (overrides: Record<string, unknown>) => ({
      operationId: forged.operationId,
      walletId: wallet.walletId,
      safe: wallet.safe,
      chainId: 8453,
      operationType: 'SEND',
      safeTx,
      ownerSignature: body.ownerSignature,
      ownerRole: 'U',
      platformSessionToken: wallet.session.token,
      submissionEnvelope: body.submissionEnvelope,
      submissionEnvelopeSignature: body.submissionEnvelopeSignature,
      policySnapshotVersion: env.base.snapshot.version,
      execution: {
        accountNonce: String(accountNonce),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      },
      ...overrides,
    });
    const refuse = (overrides: Record<string, unknown>) =>
      env.base.executorShard.client.signSafeTx(request(overrides)).then(
        () => null,
        (error: unknown) => error as SignerClientError,
      );
    const policy = await refuse({});
    expect(policy).toBeInstanceOf(SignerClientError);
    expect(policy?.code).toBe('POLICY_REJECTED');
    // Firma de U sobre otra SafeTx (el backend no puede inventar la autorización del usuario).
    const otherSignature = (
      await submissionBody(wallet, { ...forged, safeTx: { ...safeTx, data: '0x' }, safeTxHash: forged.safeTxHash })
    ).ownerSignature;
    const notSigned = await refuse({ ownerSignature: otherSignature });
    expect(notSigned).toBeInstanceOf(SignerClientError);
    expect(['OWNER_NOT_ROLE', 'SESSION_INVALID']).toContain(notSigned?.code);
  });

  it('intención adulterada en la base después de firmar: el worker no le pide nada al signer', async () => {
    const prepared = await queueOperation(env, wallet, noopCall(wallet));
    const row = await operationRow(env, prepared.operationId);
    const intent = row.canonical_intent as CanonicalIntent;
    const tampered: CanonicalIntent = {
      ...intent,
      safeTx: { ...intent.safeTx, data: '0xdeadbeef' },
    };
    await env.base.db.app
      .updateTable('wallet_operations')
      .set({ canonical_intent: JSON.stringify(tampered) })
      .where('id', '=', prepared.operationId)
      .execute();
    const signerCalls = async () => {
      const metric = await env.base.metrics.signerRequests.get();
      return metric.values.reduce((n, v) => n + v.value, 0);
    };
    const before = await signerCalls();
    await env.pipeline().processWallet(wallet.walletId);
    expect(await operationRow(env, prepared.operationId)).toMatchObject({
      status: 'FAILED_FINAL',
      last_error_code: 'INTEGRITY_MISMATCH',
      s_signature: null,
    });
    expect(await signerCalls()).toBe(before);
  });
});
