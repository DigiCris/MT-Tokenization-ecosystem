// Grupo `recovery` de [B-API] (P12, P15): enrollment de la clave de recuperación R y reemplazo de U. Cada listener
// expone sólo sus rutas ([B-AUTHZ] 3): Wallet crea el enrollment (ONBOARDING, o OPERATIONS para reemplazar R), incorpora
// la autorización de U y registra U' (U_REPLACEMENT, [W-07]); Recovery registra la Enrollment Key y envía R (o R') con
// su prueba de control; ambos consultan el estado.
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Client } from '../../../db/schema.ts';
import { P256PublicJwkSchema } from '../../../platform-session/keys.ts';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import { RecoveryEnrollmentSchema, type EnrollmentService } from '../../../recovery/enrollment.ts';
import type { UReplacementService } from '../../../recovery/u-replacement.ts';
import {
  AddressSchema,
  Bytes32Schema,
  EcdsaSignatureSchema,
  KdfParamsSchema,
  OpaqueMessageSchema,
  StorageFlagsSchema,
} from '../../../wallets/schemas.ts';
import { errorResponses } from '../../errors.ts';
import { walletActor } from './wallets.ts';

/** KeyAcceptance [W-01] de una clave nueva (U' o R'): nonce de 32 bytes y firma EIP-712 de la clave nueva. */
export const KeyAcceptanceSchema = z.object({ nonce: Bytes32Schema, signature: EcdsaSignatureSchema }).strict().meta({
  id: 'KeyAcceptance',
  description:
    'Firma EIP-712 KeyAcceptance(walletId, role, newKey, nonce) de la clave nueva (dominio de la plataforma)',
});

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];
const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];

export const EnrollmentViewSchema = z
  .object({
    id: z.uuid(),
    walletId: z.uuid(),
    purpose: z.enum(['ONBOARDING', 'REPLACEMENT']).describe('REPLACEMENT: R nueva de una wallet activa (perdí R)'),
    status: z.enum(['REQUESTED', 'SUBMITTED', 'CONFIRMED', 'EXPIRED', 'REJECTED', 'RETIRED']),
    expiresAt: z.iso.datetime(),
    enrollmentKeyRegistered: z.boolean(),
    recoveryKey: z.string().nullable(),
    rType: z.enum(['INTERNAL', 'EXTERNAL']).nullable(),
    submittedAt: z.iso.datetime().nullable(),
    confirmedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'RecoveryEnrollmentStatus' });

const EnrollmentIdParams = z.object({ id: z.uuid() });

export interface RecoveryRoutesOptions {
  client: Client;
  enrollments: EnrollmentService;
  uReplacement: UReplacementService;
}

export const recoveryRoutes: FastifyPluginCallbackZod<RecoveryRoutesOptions> = (app, options, done) => {
  const tags = ['recovery'];
  const { enrollments } = options;

  app.get(
    '/recovery/enrollments/:id',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'getRecoveryEnrollment',
        tags,
        summary: 'Estado del enrollment de la clave de recuperación',
        security: accountSecurity,
        params: EnrollmentIdParams,
        response: { 200: EnrollmentViewSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return enrollments.view(session.userId, request.params.id);
    },
  );

  if (options.client === 'WALLET') {
    app.post(
      '/wallets/:id/recovery/enrollments',
      {
        config: {
          auth: 'account',
          idempotency: true,
          platformSession: { scopes: ['ONBOARDING', 'OPERATIONS'], critical: true },
        },
        schema: {
          operationId: 'createRecoveryEnrollment',
          tags,
          summary:
            'Crea el enrollment de R (nonce de 32 bytes, 15 min; con OPERATIONS, el de R nueva de una wallet activa): el QR/link a Recovery lleva id y nonce',
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          params: z.object({ id: z.uuid() }),
          body: z.object({}).strict(),
          response: {
            201: z.object({
              enrollmentId: z.uuid(),
              nonce: z.string(),
              expiresAt: z.iso.datetime(),
              status: z.literal('REQUESTED'),
              purpose: z.enum(['ONBOARDING', 'REPLACEMENT']),
            }),
            ...errorResponses(401, 403, 404, 409, 415, 422),
          },
        },
      },
      async (request, reply) => {
        const actor = walletActor(request);
        await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
        return reply.code(201).send(await enrollments.request(actor, request.params.id));
      },
    );

    app.post(
      '/recovery/enrollments/:id/incorporate',
      {
        config: { auth: 'account', platformSession: { scopes: ['ONBOARDING'], critical: true } },
        schema: {
          operationId: 'incorporateRecoveryKey',
          tags,
          summary: 'WalletCreationAuthorization firmada por U: incorpora R y autoriza la creación de la Safe',
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          params: EnrollmentIdParams,
          body: z
            .object({
              authorization: z
                .object({
                  userId: z.uuid(),
                  platformId: z.string(),
                  walletId: z.uuid(),
                  userKey: AddressSchema,
                  recoveryKey: AddressSchema,
                  executor: AddressSchema,
                  saltNonce: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
                  expectedSafe: AddressSchema,
                  enrollmentNonce: Bytes32Schema,
                })
                .strict(),
              signature: EcdsaSignatureSchema,
            })
            .strict(),
          response: { 200: EnrollmentViewSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
        },
      },
      async (request) => {
        const actor = walletActor(request);
        await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
        return enrollments.incorporate(actor, request.params.id, request.body);
      },
    );

    app.post(
      '/recovery/u-replacement',
      {
        config: { auth: 'account', idempotency: true, platformSession: { scopes: ['U_REPLACEMENT'], critical: true } },
        schema: {
          operationId: 'registerReplacementUserKey',
          tags,
          summary:
            "Perdí U: registra U' (dirección, KDF, backups, registro OPAQUE PENDING y KeyAcceptance) para que R proponga la rotación",
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          body: z
            .object({
              userKey: AddressSchema,
              kdfParams: KdfParamsSchema,
              storageFlags: StorageFlagsSchema,
              registrationRecord: OpaqueMessageSchema,
              keyAcceptance: KeyAcceptanceSchema,
            })
            .strict(),
          response: {
            201: z
              .object({
                rotationId: z.uuid(),
                walletId: z.uuid(),
                userKey: z.string(),
                keyVersion: z.number().int(),
                status: z.literal('DRAFT'),
              })
              .meta({ id: 'UReplacement' }),
            ...errorResponses(401, 403, 404, 409, 415, 422),
          },
        },
      },
      async (request, reply) => {
        const actor = walletActor(request);
        // El step-up U_REPLACEMENT ya consumió el cupo de recovery ([B-RL]); acá sólo el total de operaciones.
        await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
        return reply.code(201).send(await options.uReplacement.register(actor, request.body));
      },
    );
  } else {
    app.post(
      '/recovery/enrollments/:id/enrollment-key',
      {
        config: { auth: 'account', platformSession: { scopes: ['ENROLLMENT'], critical: true } },
        schema: {
          operationId: 'registerEnrollmentKey',
          tags,
          summary: 'Registra la Enrollment Key P-256 de Recovery (una sola vez por enrollment)',
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          params: EnrollmentIdParams,
          body: z.object({ enrollmentKey: P256PublicJwkSchema }).strict(),
          response: { 200: EnrollmentViewSchema, ...errorResponses(401, 403, 404, 409, 415) },
        },
      },
      async (request) => {
        const actor = walletActor(request);
        await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
        return enrollments.registerKey(actor, request.params.id, request.body.enrollmentKey);
      },
    );

    app.post(
      '/recovery/enrollments/:id/submit',
      {
        config: { auth: 'account', platformSession: { scopes: ['ENROLLMENT'], critical: true } },
        schema: {
          operationId: 'submitRecoveryEnrollment',
          tags,
          summary: "Envía R (o R'): RecoveryEnrollment firmado por la Enrollment Key y prueba de control EIP-712 de R",
          security: criticalSecurity,
          headers: CriticalRequestHeadersSchema,
          params: EnrollmentIdParams,
          body: z
            .object({
              enrollment: RecoveryEnrollmentSchema,
              enrollmentKeySignature: z
                .string()
                .regex(/^[A-Za-z0-9_-]{86}$/, { error: 'firma P-256 IEEE P1363 en base64url' }),
              rType: z.enum(['INTERNAL', 'EXTERNAL']),
              connectorId: z
                .string()
                .regex(/^[a-z0-9][a-z0-9.-]{1,62}$/)
                .optional(),
              proofOfControl: EcdsaSignatureSchema,
              storageFlags: StorageFlagsSchema.optional(),
              keyAcceptance: KeyAcceptanceSchema.optional().describe(
                "Sólo en el reemplazo de R: KeyAcceptance de R' con el nonce del enrollment",
              ),
            })
            .strict(),
          response: { 200: EnrollmentViewSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
        },
      },
      async (request) => {
        const actor = walletActor(request);
        await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
        return enrollments.submit(actor, request.params.id, request.body);
      },
    );
  }

  done();
};
