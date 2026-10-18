// Grupo `wallet` de [B-API] (P12): onboarding server-side en el listener de Wallet. Todas las escrituras son críticas
// (PlatformSession + firma del request, [B-PSES-05]) con scope ONBOARDING ([W-07]), salvo el reemplazo del registro
// OPAQUE (KEY_RESTORE) y el paso 1 del registro OPAQUE de U' (U_REPLACEMENT, P15). Las lecturas usan la sesión de cuenta.
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CriticalRequestHeadersSchema } from '../../../platform-session/request-signature.ts';
import { WALLET_STATUSES } from '../../../wallets/wallet-service.ts';
import type { KeyRestoreService } from '../../../wallets/key-restore.ts';
import type { WalletActor, WalletService } from '../../../wallets/wallet-service.ts';
import { AddressSchema, KdfParamsSchema, OpaqueMessageSchema, StorageFlagsSchema } from '../../../wallets/schemas.ts';
import { errorResponses } from '../../errors.ts';
import { requestMeta } from './auth.ts';

const accountSecurity = [{ sessionCookie: [], csrfToken: [] }];
const criticalSecurity = [{ sessionCookie: [], csrfToken: [], platformSession: [], sessionSignature: [] }];
const NullableAddress = z.string().nullable();

export const WalletViewSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(WALLET_STATUSES),
    chainId: z.number().int(),
    safe: z.string().nullable().describe('Safe operativa (sólo desde ACTIVE)'),
    createdAt: z.iso.datetime(),
    activatedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Wallet' });

export const DeploymentInfoSchema = z
  .object({
    walletId: z.uuid(),
    status: z.enum(WALLET_STATUSES),
    U: NullableAddress,
    R: NullableAddress,
    S: NullableAddress,
    saltNonce: z.string().describe('uint256 en decimal: keccak256(abi.encode("MTW_SALT_V1", platformId, walletId))'),
    factory: z.string(),
    singleton: z.string(),
    proxyFactory: z.string(),
    bootstrap: z.string(),
    guard: z.string(),
    moduleGuard: z.string(),
    timelock: z.string(),
    policyRegistry: z.string(),
    whitelist: z.string(),
    swapExecutor: z.string(),
    expectedSafe: NullableAddress,
    configHash: z.string().nullable().describe('keccak256 del initializer de la Safe'),
    deployTxHash: z.string().nullable(),
    failureReason: z.string().nullable(),
  })
  .meta({ id: 'DeploymentInfo', description: 'Datos para la verificación independiente del frontend ([B-API-SCH])' });

export const CreationPlanSchema = z
  .object({
    walletId: z.uuid(),
    userKey: z.string(),
    recoveryKey: z.string(),
    executor: z.string(),
    shardId: z.string(),
    executorAttestation: z.string().describe('SignerKeyAttestation (JWS EdDSA) que la Wallet verifica antes de firmar'),
    saltNonce: z.string(),
    expectedSafe: z.string(),
    configHash: z.string(),
    enrollmentId: z.uuid(),
    enrollmentNonce: z.string(),
    typedData: z.record(z.string(), z.unknown()).describe('WalletCreationAuthorization [W-01] a firmar por U'),
  })
  .meta({ id: 'WalletCreationPlan' });

export interface WalletRoutesOptions {
  wallets: WalletService;
  keyRestore: KeyRestoreService;
}

export function walletActor(request: FastifyRequest): WalletActor {
  const session = request.session;
  const platform = request.platformSession;
  if (!session || !platform) throw new Error('ruta crítica sin sesión de cuenta o PlatformSession');
  return { userId: session.userId, platform: platform.claims, meta: requestMeta(request) };
}

const WalletIdParams = z.object({ id: z.uuid() });

export const walletRoutes: FastifyPluginCallbackZod<WalletRoutesOptions> = (app, options, done) => {
  const tags = ['wallet'];
  const { wallets } = options;

  app.post(
    '/wallets',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['ONBOARDING'], critical: true } },
      schema: {
        operationId: 'createWallet',
        tags,
        summary: 'Inicia el onboarding: crea la wallet (CREATING) o devuelve la que está en curso',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        body: z.object({}).strict(),
        response: { 200: WalletViewSchema, 201: WalletViewSchema, ...errorResponses(401, 403, 409, 415, 422) },
      },
    },
    async (request, reply) => {
      const actor = walletActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      const { wallet, created } = await wallets.create(actor);
      return reply.code(created ? 201 : 200).send(wallet);
    },
  );

  app.get(
    '/wallets/me',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'getMyWallet',
        tags,
        summary: 'Wallet viva del usuario (la Safe sólo aparece cuando está ACTIVE)',
        security: accountSecurity,
        response: { 200: z.object({ wallet: WalletViewSchema.nullable() }), ...errorResponses(401) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return { wallet: await wallets.me(session.userId) };
    },
  );

  app.post(
    '/wallets/:id/user-key/opaque-registration',
    {
      config: {
        auth: 'account',
        platformSession: { scopes: ['ONBOARDING', 'KEY_RESTORE', 'U_REPLACEMENT', 'OPERATIONS'], critical: true },
      },
      schema: {
        operationId: 'startUserKeyOpaqueRegistration',
        tags,
        summary: 'Registro OPAQUE de U, paso 1: respuesta del servidor al pedido del cliente (sin estado)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z.object({ registrationRequest: OpaqueMessageSchema }).strict(),
        response: {
          200: z.object({ registrationResponse: z.string(), keyVersion: z.number().int() }),
          ...errorResponses(401, 403, 404, 409, 415),
        },
      },
    },
    async (request) => {
      const actor = walletActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return wallets.opaqueRegistration(actor, request.params.id, request.body.registrationRequest);
    },
  );

  app.post(
    '/wallets/:id/user-key',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['ONBOARDING'], critical: true } },
      schema: {
        operationId: 'registerUserKey',
        tags,
        summary: 'Registra U: dirección, KDF público, backups confirmados y registro OPAQUE (PENDING hasta ACTIVE)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z
          .object({
            userKey: AddressSchema,
            kdfParams: KdfParamsSchema,
            storageFlags: StorageFlagsSchema,
            registrationRecord: OpaqueMessageSchema,
          })
          .strict(),
        response: {
          201: z.object({ userKey: z.string(), keyVersion: z.number().int(), status: z.literal('PENDING') }),
          ...errorResponses(401, 403, 404, 409, 415, 422),
        },
      },
    },
    async (request, reply) => {
      const actor = walletActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return reply.code(201).send(await wallets.registerUserKey(actor, request.params.id, request.body));
    },
  );

  app.post(
    '/wallets/:id/user-key/restore',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['KEY_RESTORE'], critical: true } },
      schema: {
        operationId: 'restoreUserKey',
        tags,
        summary: 'KEY_RESTORE: reemplaza el registro OPAQUE de la misma U (dispositivo nuevo o rotación del setup)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z
          .object({
            registrationRecord: OpaqueMessageSchema,
            kdfParams: KdfParamsSchema.optional().describe('KDF del sobre nuevo (restaurada desde las 17 palabras)'),
            storageFlags: StorageFlagsSchema.optional().describe('Backups confirmados del sobre nuevo'),
          })
          .strict(),
        response: {
          200: z.object({ userKey: z.string(), keyVersion: z.number().int(), status: z.literal('ACTIVE') }),
          ...errorResponses(401, 403, 404, 409, 415, 422),
        },
      },
    },
    async (request) => {
      const actor = walletActor(request);
      await app.enforceRateLimit(request, 'recovery-sensitive', { user: actor.userId });
      return options.keyRestore.restore(actor, request.params.id, request.body);
    },
  );

  app.post(
    '/wallets/:id/user-key/password',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['OPERATIONS'], critical: true } },
      schema: {
        operationId: 'changeUserKeyPassword',
        tags,
        summary:
          'Cambio de Password U [F-KEY-08]: la misma U con un sobre nuevo → registro OPAQUE nuevo (el anterior se retira)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z
          .object({
            registrationRecord: OpaqueMessageSchema,
            kdfParams: KdfParamsSchema,
            storageFlags: StorageFlagsSchema,
          })
          .strict(),
        response: {
          200: z.object({ userKey: z.string(), keyVersion: z.number().int(), status: z.literal('ACTIVE') }),
          ...errorResponses(401, 403, 404, 409, 415, 422),
        },
      },
    },
    async (request) => {
      const actor = walletActor(request);
      await app.enforceRateLimit(request, 'recovery-sensitive', { user: actor.userId });
      return options.keyRestore.changePassword(actor, request.params.id, request.body);
    },
  );

  app.post(
    '/wallets/:id/executor',
    {
      config: { auth: 'account', platformSession: { scopes: ['ONBOARDING'], critical: true } },
      schema: {
        operationId: 'assignExecutor',
        tags,
        summary: 'Asigna S (shard del signer, con su atestación) y calcula la Safe esperada a autorizar por U',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z.object({}).strict(),
        response: { 200: CreationPlanSchema, ...errorResponses(401, 403, 404, 409, 415) },
      },
    },
    async (request) => {
      const actor = walletActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      return wallets.assignExecutor(actor, request.params.id);
    },
  );

  app.post(
    '/wallets/:id/deploy',
    {
      config: { auth: 'account', idempotency: true, platformSession: { scopes: ['ONBOARDING'], critical: true } },
      schema: {
        operationId: 'deployWallet',
        tags,
        summary: 'Pide el deploy de la Safe autorizada por U (DEPLOYING → VERIFYING → ACTIVE, asincrónico)',
        security: criticalSecurity,
        headers: CriticalRequestHeadersSchema,
        params: WalletIdParams,
        body: z.object({}).strict(),
        response: { 202: WalletViewSchema, ...errorResponses(401, 403, 404, 409, 415, 422) },
      },
    },
    async (request, reply) => {
      const actor = walletActor(request);
      await app.enforceRateLimit(request, 'operation-create', { user: actor.userId });
      const { wallet } = await wallets.requestDeploy(actor, request.params.id);
      return reply.code(202).send(wallet);
    },
  );

  app.get(
    '/wallets/:id/deployment',
    {
      config: { auth: 'account' },
      schema: {
        operationId: 'getWalletDeployment',
        tags,
        summary: 'Estado del onboarding y datos para verificar la Safe de forma independiente',
        security: accountSecurity,
        params: WalletIdParams,
        response: { 200: DeploymentInfoSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new Error('ruta de cuenta sin sesión');
      return wallets.deployment({ userId: session.userId }, request.params.id);
    },
  );

  done();
};
