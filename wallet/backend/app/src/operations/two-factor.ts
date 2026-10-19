// 2FA de operaciones de alto valor (P14.T03, [B-POL-02], RQ-83): un SEND con monto ≥ umbral se prepara con
// `requiresTwoFactor` y el usuario lo completa con POST /operations/{id}/two-factor antes de firmar con U:
//
// - sin código: crea el challenge `HIGH_VALUE_TX` ligado a la Safe, el SafeTxHash, la acción, el token, el monto, el
//   destino y el nonce de la Safe; el factor es el TOTP del usuario si lo tiene activo y si no un OTP por email
//   (plantilla `high-value-challenge` con los datos exactos de la operación). Un challenge nuevo de la misma operación
//   invalida el anterior.
// - con código: lo verifica (intentos, vencimiento, un solo uso), comprueba que el binding siga siendo el de la
//   operación, firma la atestación `ChallengeCompletion` (emisor de sesiones; la verifica el signer) y la guarda en la
//   operación junto con el challenge. La firma de U se acepta recién con el 2FA completo (challengeFacts).
import { sql, type Kysely } from 'kysely';
import { getAddress, isAddressEqual, type Address } from 'viem';
import { z } from 'zod';
import { ApiError } from '../api/errors.ts';
import type { AuditWriter } from '../audit/audit-writer.ts';
import type { ChallengeService } from '../auth/challenges.ts';
import { verifySecondFactor } from '../auth/second-factor.ts';
import type { Secret } from '../config/secret.ts';
import type { Database } from '../db/schema.ts';
import { withTransaction } from '../db/transaction.ts';
import type { EmailOutbox, EmailRequest } from '../email/email-outbox.ts';
import type { RequestOrigin } from '../email/templates.ts';
import { bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { PlatformSessionIssuer } from '../platform-session/token.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';
import type { CanonicalIntent } from './intent.ts';
import type { OperationActor } from './service.ts';
import { isUuid } from './wallet-access.ts';

export type TwoFactorMethod = 'TOTP' | 'EMAIL';

const BindingSchema = z.object({
  operationId: z.uuid(),
  userId: z.uuid(),
  safe: z.string(),
  chainId: z.number(),
  action: z.literal('SEND'),
  destination: z.string(),
  safeTxHash: z.string(),
  token: z.string(),
  amount: z.string(),
  nonce: z.string(),
  method: z.enum(['TOTP', 'EMAIL']),
});

export interface TwoFactorDeps {
  db: Kysely<Database>;
  challenges: ChallengeService;
  issuer: PlatformSessionIssuer;
  emails: EmailOutbox;
  audit: AuditWriter;
  fieldKey: Secret<Buffer>;
  snapshot: () => BackendPolicySnapshot;
  metrics?: Metrics;
  /** Reloj en ms (tests). */
  now?: () => number;
}

interface PendingTransfer {
  id: string;
  walletId: string;
  safe: Address;
  safeTxHash: string;
  nonce: string;
  token: Address;
  tokenSymbol: 'USDC' | 'USDT';
  /** Unidades mínimas del token. */
  amount: string;
  destination: Address;
}

/**
 * El email del código de alto valor (plantilla `high-value-challenge`) con los datos exactos de la operación: el monto va
 * en unidades mínimas y la plantilla lo muestra en es-AR, igual que la app que pide compararlo con el email.
 */
export function highValueChallengeEmail(input: {
  to: string;
  locale: string;
  timeZone: string;
  operation: Pick<PendingTransfer, 'safe' | 'tokenSymbol' | 'amount' | 'destination' | 'nonce'>;
  challenge: { secret: string; expiresAt: Date };
  origin: RequestOrigin;
}): EmailRequest<'high-value-challenge'> {
  const { operation: op } = input;
  return {
    to: input.to,
    template: 'high-value-challenge',
    params: {
      code: input.challenge.secret,
      safe: op.safe,
      token: op.tokenSymbol,
      amountUnits: op.amount,
      destination: op.destination,
      nonce: op.nonce,
      expiresAt: input.challenge.expiresAt.toISOString(),
      origin: input.origin,
    },
    locale: input.locale,
    timeZone: input.timeZone,
    product: 'Wallet',
  };
}

export class TwoFactorService {
  readonly #d: TwoFactorDeps;

  constructor(deps: TwoFactorDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  /** La operación del actor, CREATED vigente, de su wallet y con 2FA pendiente. */
  async #pending(actor: OperationActor, operationId: string): Promise<PendingTransfer> {
    if (!isUuid(operationId)) throw new ApiError('NOT_FOUND');
    const op = await this.#d.db
      .selectFrom('wallet_operations')
      .selectAll()
      .where('id', '=', operationId)
      .executeTakeFirst();
    if (op?.user_id !== actor.userId) throw new ApiError('NOT_FOUND');
    const claims = actor.session.claims;
    const safe = bufferToAddress(op.safe_address);
    if (claims.walletId !== op.wallet_id || claims.safe === null || !isAddressEqual(claims.safe, safe)) {
      throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession es de otra wallet' });
    }
    if (!op.requires_two_factor) throw new ApiError('CONFLICT', { detail: 'la operación no requiere 2FA' });
    if (op.status !== 'CREATED')
      throw new ApiError('OPERATION_NOT_PENDING', { detail: `la operación está en ${op.status}` });
    if (op.expires_at !== null && op.expires_at.getTime() <= this.#now()) throw new ApiError('OPERATION_EXPIRED');
    if (op.challenge_attestation !== null) throw new ApiError('CONFLICT', { detail: 'el 2FA ya está completo' });
    const intent = op.canonical_intent as CanonicalIntent;
    const { token, amount, destination } = intent.decoded;
    if (intent.operationType !== 'SEND' || token === undefined || amount === undefined || destination === undefined) {
      throw new ApiError('CONFLICT', { detail: 'la operación no es un envío' });
    }
    return {
      id: op.id,
      walletId: op.wallet_id,
      safe,
      safeTxHash: bufferToHex(op.safe_tx_hash),
      nonce: op.safe_nonce,
      token: this.#d.snapshot().tokens[token],
      tokenSymbol: token,
      amount,
      destination: getAddress(destination),
    };
  }

  /** Crea el challenge (TOTP si está activo; si no, OTP por email con los datos de la operación). */
  async start(
    actor: OperationActor,
    operationId: string,
    origin: { userAgent: string | null },
  ): Promise<{ method: TwoFactorMethod; challengeId: string; expiresAt: string }> {
    const op = await this.#pending(actor, operationId);
    const snapshot = this.#d.snapshot();
    const result = await withTransaction(
      this.#d.db,
      async (trx) => {
        const user = await trx
          .selectFrom('users')
          .select(['email', 'locale', 'time_zone', 'totp_enabled'])
          .where('id', '=', actor.userId)
          .executeTakeFirstOrThrow();
        const method: TwoFactorMethod = user.totp_enabled ? 'TOTP' : 'EMAIL';
        const challenge = await this.#d.challenges.issue(trx, {
          userId: actor.userId,
          type: 'HIGH_VALUE_TX',
          walletId: op.walletId,
          ipPrefix: actor.meta.ipPrefix,
          supersede: { key: 'operationId', value: op.id },
          bindExpiry: true,
          binding: {
            operationId: op.id,
            userId: actor.userId,
            safe: op.safe,
            chainId: snapshot.chainId,
            action: 'SEND',
            destination: op.destination,
            safeTxHash: op.safeTxHash,
            token: op.token,
            amount: op.amount,
            nonce: op.nonce,
            method,
          },
        });
        if (method === 'EMAIL') {
          await this.#d.emails.enqueue(
            trx,
            highValueChallengeEmail({
              to: user.email,
              locale: user.locale,
              timeZone: user.time_zone,
              operation: op,
              challenge,
              origin: { ipPrefix: actor.meta.ipPrefix, userAgent: origin.userAgent },
            }),
          );
        }
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId: op.walletId,
          sessionId: actor.session.claims.sessionId,
          eventType: 'TWO_FACTOR_REQUESTED',
          targetType: 'operation',
          targetId: op.id,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: { method, challengeId: challenge.challengeId, expiresAt: challenge.expiresAt.toISOString() },
        });
        return { method, challengeId: challenge.challengeId, expiresAt: challenge.expiresAt.toISOString() };
      },
      { auditLock: true },
    );
    this.#d.metrics?.twoFactorChallenges.inc({ method: result.method, result: 'issued' });
    return result;
  }

  /** Verifica el código y guarda la ChallengeCompletion en la operación. */
  async verify(actor: OperationActor, operationId: string, code: string): Promise<void> {
    const op = await this.#pending(actor, operationId);
    const snapshot = this.#d.snapshot();
    const open = await this.#d.db
      .selectFrom('security_challenges')
      .select(['id', 'binding'])
      .where('user_id', '=', actor.userId)
      .where('type', '=', 'HIGH_VALUE_TX')
      .where('consumed_at', 'is', null)
      .where(sql<boolean>`binding ->> 'operationId' = ${op.id}`)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!open) throw new ApiError('INVALID_CODE', { detail: 'no hay un código pedido para esta operación' });
    const method = BindingSchema.parse(open.binding).method;
    // Confirmar y después lanzar: el intento fallido queda contado aunque el request termine en error.
    const outcome = await withTransaction(
      this.#d.db,
      async (trx) => {
        const check =
          method === 'EMAIL'
            ? await this.#d.challenges.verify(trx, {
                type: 'HIGH_VALUE_TX',
                challengeId: open.id,
                userId: actor.userId,
                secret: code,
              })
            : await this.#d.challenges.verifyWith(trx, {
                type: 'HIGH_VALUE_TX',
                challengeId: open.id,
                userId: actor.userId,
                check: () => verifySecondFactor(trx, this.#d.fieldKey, actor.userId, { totp: code }),
              });
        const binding = check.result === 'OK' ? BindingSchema.safeParse(check.binding) : null;
        const bound =
          binding?.success === true &&
          binding.data.operationId === op.id &&
          binding.data.userId === actor.userId &&
          binding.data.chainId === snapshot.chainId &&
          isAddressEqual(binding.data.safe as Address, op.safe) &&
          isAddressEqual(binding.data.destination as Address, op.destination) &&
          isAddressEqual(binding.data.token as Address, op.token) &&
          binding.data.safeTxHash === op.safeTxHash &&
          binding.data.amount === op.amount &&
          binding.data.nonce === op.nonce;
        if (!bound) {
          await this.#d.audit.append(trx, {
            actorType: 'USER',
            actorId: actor.userId,
            userId: actor.userId,
            walletId: op.walletId,
            sessionId: actor.session.claims.sessionId,
            eventType: 'TWO_FACTOR_FAILED',
            targetType: 'operation',
            targetId: op.id,
            requestId: actor.meta.requestId,
            ipPrefix: actor.meta.ipPrefix,
            payload: {
              method,
              challengeId: open.id,
              result: check.result === 'OK' ? 'BINDING_MISMATCH' : check.result,
            },
          });
          return { error: true as const };
        }
        const attestation = await this.#d.issuer.signChallengeCompletion({
          challengeId: open.id,
          type: 'HIGH_VALUE_TX',
          userId: actor.userId,
          safe: op.safe,
          chainId: snapshot.chainId,
          action: 'SEND',
          destination: op.destination,
          safeTxHash: op.safeTxHash,
          token: op.token,
          amount: op.amount,
          nonce: Number(op.nonce),
          completedAt: Math.floor(this.#now() / 1000),
        });
        const updated = await trx
          .updateTable('wallet_operations')
          .set({ two_factor_challenge_id: open.id, challenge_attestation: attestation })
          .where('id', '=', op.id)
          .where('status', '=', 'CREATED')
          .where('challenge_attestation', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw new ApiError('OPERATION_NOT_PENDING');
        await this.#d.audit.append(trx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          walletId: op.walletId,
          sessionId: actor.session.claims.sessionId,
          eventType: 'TWO_FACTOR_PASSED',
          targetType: 'operation',
          targetId: op.id,
          requestId: actor.meta.requestId,
          ipPrefix: actor.meta.ipPrefix,
          payload: { method, challengeId: open.id },
        });
        return { error: false as const };
      },
      { auditLock: true },
    );
    this.#d.metrics?.twoFactorChallenges.inc({ method, result: outcome.error ? 'failed' : 'passed' });
    if (outcome.error) throw new ApiError('INVALID_CODE');
  }
}
