// Grupo `rotations` de [B-API] (P15): en los dos listeners. La propuesta y la ejecución son críticas e idempotentes y
// devuelven la SafeTx a firmar: en Wallet con U (OPERATIONS) y en Recovery con R (RECOVERY), según [W-07] y
// [C-GRD-11] (R propone U o S; U propone U, R, S y el upgrade del Guard). La cancelación (`/rotations/{id}/cancel`) es
// pública: la autoriza la firma EIP-712 `CancelRotation` de la U o la R vigentes on-chain, que el backend verifica y
// retransmite por el gas tank (también se puede transmitir por cualquier relayer o una wallet propia, [C-RTL-03]).
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Client } from '../../../db/schema.ts';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import { ROTATION_ROLES, ROTATION_STATUSES, type RotationService } from '../../../rotations/service.ts';
import { errorResponses } from '../../errors.ts';
import { requestMeta } from './auth.ts';
import { operationActor, PreparedOperationSchema } from './operations.ts';

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];
const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const RotationViewSchema = z
  .object({
    id: z.uuid(),
    walletId: z.uuid(),
    role: z.enum(ROTATION_ROLES),
    oldKey: Address,
    newKey: Address,
    status: z.enum(ROTATION_STATUSES),
    origin: z.enum(['PLATFORM', 'ONCHAIN']).describe('ONCHAIN: propuesta que no preparó el backend (U+R, otra app)'),
    initiatedBy: z.enum(['U', 'R', 'SAFE']),
    proposalId: z.string().nullable(),
    executableAt: z.iso.datetime().nullable().describe('Momento on-chain desde el que se puede ejecutar (48 h)'),
    cancelledBy: z.enum(['U', 'R', 'SAFE']).nullable(),
    proposeOperationId: z.uuid().nullable(),
    executeOperationId: z.uuid().nullable(),
    proposedAt: z.iso.datetime().nullable(),
    executedAt: z.iso.datetime().nullable(),
    failureReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    cancelTypedData: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('EIP-712 CancelRotation (eth_signTypedData_v4) mientras la propuesta esté pendiente'),
  })
  .meta({ id: 'Rotation' });

const RotationOperationSchema = z
  .object({ rotation: RotationViewSchema, operation: PreparedOperationSchema })
  .meta({ id: 'RotationOperation' });

export interface RotationRoutesOptions {
  client: Client;
  rotations: RotationService;
}

const IdParams = z.object({ id: z.uuid() });

export const rotationRoutes: FastifyPluginCallbackZod<RotationRoutesOptions> = (app, options, done) => {
  const tags = ['rotations'];
  const { rotations } = options;
  const scopes = options.client === 'WALLET' ? (['OPERATIONS'] as const) : (['RECOVERY'] as const);
  const critical = { auth: 'account', idempotency: true, platformSession: { scopes, critical: true } } as const;

  app.get(
    '/wallets/:id/rotations',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'listWalletRotations',
        tags,
        summary: 'Rotaciones de la wallet (las 50 más recientes), con la typed data de cancelación si están pendientes',
        security: accountSecurity,
        params: IdParams,
        response: { 200: z.object({ items: z.array(RotationViewSchema) }), ...errorResponses(401, 404) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return { items: await rotations.list(session.userId, request.params.id) };
    },
  );

  app.post(
    '/wallets/:id/rotations',
    {
      config: critical,
      schema: {
        operationId: 'proposeRotation',
        tags,
        summary:
          'Prepara RotationTimelock.propose para firmar con U (Wallet) o R (Recovery); la clave nueva sale del material ya registrado',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: IdParams,
        body: z
          .object({
            role: z
              .enum(ROTATION_ROLES)
              .describe(
                "U: U' del reemplazo de U · R: R' del enrollment de reemplazo · S: S' del signer · GUARD/MODULE_GUARD: sucesor",
              ),
          })
          .strict(),
        response: { 200: RotationOperationSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      // [B-RL]: recovery / propuestas de rotación (3/día por usuario, 10/día por IP).
      await app.enforceRateLimit(request, 'recovery-sensitive', { user: actor.userId });
      return rotations.propose(actor, request.params.id, request.body);
    },
  );

  app.post(
    '/rotations/:id/execute/prepare',
    {
      config: critical,
      schema: {
        operationId: 'prepareRotationExecution',
        tags,
        summary:
          'Con la propuesta madura (48 h), prepara swapOwner (o setGuard/setModuleGuard) para firmar con U o R; la ejecuta la S vigente',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: IdParams,
        body: z.object({}).strict(),
        response: { 200: RotationOperationSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
      },
    },
    async (request) => {
      const actor = operationActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return rotations.executePrepare(actor, request.params.id);
    },
  );

  app.post(
    '/rotations/:id/cancel',
    {
      // Sin sesión ni CSRF: la autorización es la firma EIP-712 de U o R; cualquier relayer puede llamarla.
      config: { auth: 'public', csrf: false },
      schema: {
        operationId: 'relayRotationCancellation',
        tags,
        summary:
          'Sin autenticación: verifica la firma CancelRotation de la U o la R vigentes y la propuesta pendiente on-chain, y la retransmite por el gas tank',
        security: [],
        params: IdParams,
        body: z
          .object({
            signature: z
              .string()
              .regex(/^0x[0-9a-fA-F]{130}$/, { error: 'firma ECDSA de 65 bytes' })
              .describe('Firma EIP-712 CancelRotation(proposalId, safe) de U o R (dominio del RotationTimelock)'),
          })
          .strict(),
        response: {
          202: z.object({
            rotation: RotationViewSchema,
            relay: z.object({ status: z.literal('REQUESTED'), signer: Address, role: z.enum(['U', 'R']) }),
          }),
          ...errorResponses(404, 409, 415, 422),
        },
      },
    },
    async (request, reply) => {
      // [B-RL]: bucket propio por propuesta e IP (nunca compartido con las rutas autenticadas).
      await app.enforceRateLimit(request, 'rotation-cancel-relay', { proposal: request.params.id });
      const meta = requestMeta(request);
      const result = await rotations.requestCancelRelay(request.params.id, request.body.signature, {
        requestId: request.id,
        ipPrefix: meta.ipPrefix,
      });
      return reply.code(202).send(result);
    },
  );

  done();
};
