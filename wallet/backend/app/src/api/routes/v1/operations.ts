// Grupo `operations` de [B-API] (P13.T03/T08, P14.T03): lectura de operaciones con su historial, envío de la firma
// U/R, cancelación (NoOp con el mismo nonce) y 2FA de operaciones de alto valor. Las escrituras son críticas
// (PlatformSession + firma del request) e idempotentes; en el listener de Wallet firma U (scope OPERATIONS) y en el de
// Recovery firma R (scope RECOVERY). El 2FA existe sólo en Wallet (lo exige un SEND de U).
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Client } from '../../../db/schema.ts';
import { OPERATION_TYPES } from '../../../policy/snapshot.ts';
import { OPERATION_STATUSES } from '../../../operations/state-machine.ts';
import type { OperationActor, OperationService } from '../../../operations/service.ts';
import type { TwoFactorService } from '../../../operations/two-factor.ts';
import { CriticalRequestHeadersSchema, SubmissionEnvelopeSchema } from '../../../platform-session/request-signature.ts';
import { errorResponses } from '../../errors.ts';
import { requestMeta } from './auth.ts';

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];
const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const SafeTxSchema = z
  .object({
    to: Address,
    value: z.string(),
    data: z.string(),
    operation: z.union([z.literal(0), z.literal(1)]),
    safeTxGas: z.string(),
    baseGas: z.string(),
    gasPrice: z.string(),
    gasToken: Address,
    refundReceiver: Address,
    nonce: z.string(),
  })
  .meta({ id: 'SafeTx', description: 'SafeTx (uint256 en decimal)' });

export const DecodedSchema = z
  .object({
    token: z.enum(['USDC', 'USDT']).optional(),
    amount: z.string().optional(),
    destination: Address.optional(),
    tokenIn: z.enum(['USDC', 'USDT']).optional(),
    tokenOut: z.enum(['USDC', 'USDT']).optional(),
    minAmountOut: z.string().optional(),
    deadline: z.string().optional(),
    role: z.enum(['U', 'R', 'S', 'GUARD', 'MODULE_GUARD']).optional(),
    oldKey: Address.optional(),
    newKey: Address.optional(),
  })
  .meta({ id: 'DecodedOperation', description: 'Datos decodificados de la SafeTx (sólo para mostrar)' });

export const PreparedOperationSchema = z
  .object({
    operationId: z.uuid(),
    groupId: z.uuid().nullable(),
    walletId: z.uuid(),
    safe: Address,
    chainId: z.number().int(),
    operationType: z.enum(OPERATION_TYPES),
    safeTx: SafeTxSchema,
    safeTxHash: Hex32,
    typedData: z.record(z.string(), z.unknown()).describe('Typed data EIP-712 de la SafeTx (eth_signTypedData_v4)'),
    decoded: DecodedSchema,
    requiresTwoFactor: z.boolean(),
    twoFactorThreshold: z
      .string()
      .regex(/^\d+$/)
      .nullable()
      .describe(
        'Umbral de 2FA de la policy vigente (unidades de 6 decimales) cuando la operación lo exige; null si no lo exige',
      ),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'PreparedOperation' });

export const OperationStatusSchema = z
  .object({
    id: z.uuid(),
    walletId: z.uuid(),
    status: z.enum(OPERATION_STATUSES),
    operationType: z.enum(OPERATION_TYPES),
    // La intención guardada al preparar (monto, token, destino…): la actividad la muestra aunque no haya transfers.
    decoded: DecodedSchema,
    groupId: z.uuid().nullable(),
    safeNonce: z.string(),
    safeTxHash: Hex32,
    txHash: Hex32.nullable(),
    blockNumber: z.string().nullable(),
    blockHash: Hex32.nullable(),
    confirmations: z.object({ safe: z.boolean(), finalized: z.boolean() }),
    failureReason: z.string().nullable(),
    lastErrorCode: z.string().nullable(),
    blockedReason: z.enum(['WAITING_LOWER_NONCE']).nullable(),
    requiresTwoFactor: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
    cancelsOperationId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    history: z.array(z.object({ status: z.enum(OPERATION_STATUSES), at: z.iso.datetime() })),
  })
  .meta({ id: 'OperationStatus' });

export const SubmitSignatureRequestSchema = z
  .object({
    ownerSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, { error: 'firma ECDSA de 65 bytes' }),
    ownerRole: z.enum(['U', 'R']),
    submissionEnvelope: SubmissionEnvelopeSchema,
    submissionEnvelopeSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, { error: 'P-256 r‖s en base64url' }),
    twoFactorChallengeId: z
      .uuid()
      .optional()
      .describe(
        'Challenge HIGH_VALUE_TX completado con POST /operations/{id}/two-factor (si se envía, tiene que coincidir)',
      ),
  })
  .strict()
  .meta({ id: 'SubmitSignatureRequest' });

export const TwoFactorChallengeSchema = z
  .object({
    method: z.enum(['TOTP', 'EMAIL']).describe('TOTP si el usuario lo tiene activo; si no, código por email'),
    challengeId: z.uuid(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'TwoFactorChallenge' });

export interface OperationRoutesOptions {
  client: Client;
  operations: OperationService;
  /** 2FA de alto valor (sólo en el listener de Wallet). */
  twoFactor?: TwoFactorService;
}

export function operationActor(request: FastifyRequest): OperationActor {
  const session = request.session;
  const platform = request.platformSession;
  if (!session || !platform) throw new Error('ruta crítica sin sesión de cuenta o PlatformSession');
  return {
    userId: session.userId,
    session: platform,
    meta: { requestId: request.id, ipPrefix: requestMeta(request).ipPrefix },
  };
}

const IdParams = z.object({ id: z.uuid() });

export const operationRoutes: FastifyPluginCallbackZod<OperationRoutesOptions> = (app, options, done) => {
  const tags = ['operations'];
  const { operations } = options;
  // [W-07]: en Wallet firma U con OPERATIONS; en Recovery firma R con RECOVERY.
  const scopes = options.client === 'WALLET' ? (['OPERATIONS'] as const) : (['RECOVERY'] as const);

  app.get(
    '/wallets/:id/operations',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'listWalletOperations',
        tags,
        summary: 'Operaciones de la wallet (más recientes primero, paginadas por cursor)',
        security: accountSecurity,
        params: IdParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          before: z.uuid().optional().describe('Cursor: id de la última operación de la página anterior'),
        }),
        response: {
          200: z.object({ items: z.array(OperationStatusSchema), nextCursor: z.uuid().nullable() }),
          ...errorResponses(401, 404),
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return operations.list(session.userId, request.params.id, {
        limit: request.query.limit,
        ...(request.query.before === undefined ? {} : { before: request.query.before }),
      });
    },
  );

  app.get(
    '/operations/:id',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'getOperation',
        tags,
        summary: 'Estado de una operación con su historial de estados',
        security: accountSecurity,
        params: IdParams,
        response: { 200: OperationStatusSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return operations.get(session.userId, request.params.id);
    },
  );

  app.post(
    '/operations/:id/signatures',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes, critical: true } },
      schema: {
        operationId: 'submitOperationSignature',
        tags,
        summary: 'Envía la firma U/R de la SafeTx con el envelope de envío; la operación queda encolada (QUEUED)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: IdParams,
        body: SubmitSignatureRequestSchema,
        response: { 200: OperationStatusSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
      },
    },
    async (request) => {
      // Sin cupo propio: cada operación se firma una sola vez (lo acota el `prepare` que la creó, [B-RL]).
      const actor = operationActor(request);
      const body = request.body;
      return operations.submitSignature(actor, request.params.id, {
        ...body,
        ownerSignature: body.ownerSignature as `0x${string}`,
      });
    },
  );

  app.post(
    '/operations/:id/cancel',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes, critical: true } },
      schema: {
        operationId: 'cancelOperation',
        tags,
        summary:
          'Cancela una operación: sin firma queda CANCELLED; firmada pasa a CANCEL_REQUESTED y devuelve la NoOp a firmar',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: IdParams,
        body: z.object({}).strict(),
        response: {
          200: z.object({ operation: OperationStatusSchema, noop: PreparedOperationSchema.nullable() }),
          ...errorResponses(401, 403, 404, 409, 415, 422),
        },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return operations.cancel(actor, request.params.id);
    },
  );

  const twoFactor = options.twoFactor;
  if (options.client === 'WALLET' && twoFactor) {
    app.post(
      '/operations/:id/two-factor',
      {
        config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
        schema: {
          operationId: 'operationTwoFactor',
          tags,
          summary:
            '2FA de una operación de alto valor: sin código crea el challenge (TOTP o email); con código lo verifica y liga la atestación a la operación',
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          params: IdParams,
          body: z
            .object({
              code: z
                .string()
                .regex(/^\d{6}(\d{2})?$/, { error: 'TOTP de 6 dígitos o código del email de 8' })
                .optional(),
            })
            .strict(),
          response: {
            200: OperationStatusSchema,
            202: TwoFactorChallengeSchema,
            ...errorResponses(401, 403, 404, 409, 415, 422),
          },
        },
      },
      async (request, reply) => {
        const actor = operationActor(request);
        if (request.body.code === undefined) {
          await app.enforceRateLimit(request, 'otp-challenge', { user: actor.userId, challengeType: 'HIGH_VALUE_TX' });
          const started = await twoFactor.start(actor, request.params.id, {
            userAgent: requestMeta(request).userAgent,
          });
          return reply.code(202).send(started);
        }
        await twoFactor.verify(actor, request.params.id, request.body.code);
        return reply.code(200).send(await operations.get(actor.userId, request.params.id));
      },
    );
  }

  done();
};
