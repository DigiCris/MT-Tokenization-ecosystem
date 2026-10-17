// API mTLS interna del signer [B-SIG-01] (P11.T02): HTTPS con certificado de cliente OBLIGATORIO (CA privada del
// entorno, TLS 1.3) y, además, nombre del cliente permitido (CN o SAN DNS `mtw-backend`). Sin puertos publicados en
// producción: sólo la red Docker `signer` (`internal: true`). Spec interna en backend/signer/openapi.json (nunca se
// publica).
//
// Rutas: GET /v1/health · POST /v1/keys · POST /v1/sign-safe-tx (shards de S) · POST /v1/sign-platform-tx y
// GET /v1/gas-tank (shard `platform`) · GET /v1/metrics.
import type { TLSSocket } from 'node:tls';
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SignerError } from './errors.ts';
import type { KeyAttestor } from '../attestation.ts';
import type { Logger } from '../observability/logger.ts';
import type { SignerMetrics } from '../observability/metrics.ts';
import type { PolicySnapshot } from '../policy/snapshot.ts';
import type { SelfHostedSoftwareSignerProvider } from '../providers/SelfHostedSoftwareSignerProvider.ts';
import { SignerProviderError } from '../providers/SignerProvider.ts';
import type { OnChainReader } from '../chain/reader.ts';
import { checksumAddress, isAddress, sameAddress } from '../crypto/keccak.ts';
import { retireKey } from '../lifecycle/retire.ts';
import { PlatformTxRequestSchema, type PlatformTxService } from '../sign/platform-tx.ts';
import { SignSafeTxRequestSchema, type SignSafeTxService } from '../sign/sign-safe-tx.ts';

export interface ServerDeps {
  tls: { key: Buffer; cert: Buffer; ca: Buffer };
  allowedClientNames: readonly string[];
  shardId: string;
  platform: boolean;
  provider: SelfHostedSoftwareSignerProvider;
  attestor: KeyAttestor;
  snapshot: () => PolicySnapshot;
  signSafeTx?: SignSafeTxService;
  platformTx?: PlatformTxService;
  /** Lecturas on-chain para verificar el retiro de una S. */
  reader?: OnChainReader;
  logger: Logger;
  metrics: SignerMetrics;
}

export const KeysRequestSchema = z
  .object({
    /** Wallet para la que se crea S (null sólo en el shard `platform`: cuenta gas tank). */
    walletId: z.uuid().nullable(),
    /** ONBOARDING devuelve la S activa existente si la hay (idempotente); ROTATION siempre crea una nueva. */
    reason: z.enum(['ONBOARDING', 'ROTATION', 'GAS_TANK']),
  })
  .strict();

const addressField = z
  .string()
  .refine((v) => isAddress(v), 'dirección inválida')
  .transform((v) => checksumAddress(v));

export const RetireRequestSchema = z.object({ walletId: z.uuid(), address: addressField, safe: addressField }).strict();

/** Nombres del certificado de cliente (CN y SAN DNS). */
export function clientNames(request: FastifyRequest): string[] {
  const socket = request.raw.socket as TLSSocket;
  const cert = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : undefined;
  if (cert === undefined || Object.keys(cert).length === 0) return [];
  const names: string[] = [];
  const cn = cert.subject.CN;
  if (typeof cn === 'string') names.push(cn);
  for (const entry of (cert.subjectaltname ?? '').split(',')) {
    const match = /^\s*DNS:(.+)$/.exec(entry);
    if (match?.[1]) names.push(match[1].trim());
  }
  return names;
}

function sendError(reply: FastifyReply, error: SignerError): FastifyReply {
  return reply.code(error.status).type('application/json').send(error.toJSON());
}

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({
    https: {
      key: deps.tls.key,
      cert: deps.tls.cert,
      ca: deps.tls.ca,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    },
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    bodyLimit: 64 * 1024,
    requestIdHeader: 'x-request-id',
    return503OnClosing: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    const socket = request.raw.socket as TLSSocket;
    // rejectUnauthorized ya cortó el handshake sin certificado válido; esto es una segunda barrera por identidad.
    if (!socket.authorized || !clientNames(request).some((n) => deps.allowedClientNames.includes(n))) {
      deps.metrics.rejections.inc({ reason: 'UNAUTHORIZED_CLIENT' });
      return sendError(reply, new SignerError('UNAUTHORIZED_CLIENT'));
    }
    return undefined;
  });

  app.addHook('onResponse', async (request, reply) => {
    deps.metrics.requestDuration.observe(
      { route: request.routeOptions.url ?? 'desconocida', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    request.log.info(
      { route: request.routeOptions.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request mTLS',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SignerError) return sendError(reply, error);
    if (error instanceof SignerProviderError) {
      const code =
        error.code === 'NOT_READY' || error.code === 'KEY_UNAVAILABLE' ? 'SIGNER_NOT_READY' : 'KEY_NOT_FOUND';
      return sendError(reply, new SignerError(code, error.code));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return sendError(reply, new SignerError('BAD_REQUEST', (error as { code?: string }).code));
    }
    request.log.error({ err: error }, 'error interno del signer');
    return sendError(reply, new SignerError('INTERNAL'));
  });

  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join('.') || '(cuerpo)');
      throw new SignerError('BAD_REQUEST', [...new Set(fields)].slice(0, 5).join(','));
    }
    return parsed.data;
  };

  app.get('/v1/health', async () => {
    const health = await deps.provider.health();
    return {
      ...health,
      platform: deps.platform,
      policyVersion: deps.snapshot().version,
      attestationKid: deps.attestor.kid,
    };
  });

  app.get('/v1/metrics', async (_request, reply) => {
    return reply.type(deps.metrics.registry.contentType).send(await deps.metrics.registry.metrics());
  });

  app.post('/v1/keys', async (request) => {
    const body = parse(KeysRequestSchema, request.body);
    if (deps.platform !== (body.reason === 'GAS_TANK') || (body.walletId === null) !== (body.reason === 'GAS_TANK')) {
      throw new SignerError('BAD_REQUEST', 'reason');
    }
    if (body.reason === 'GAS_TANK') {
      const existing = await deps.provider.registry.gasTankKey();
      const created = existing ?? (await deps.provider.createKey(null, 'GAS_TANK'));
      return { keyRef: created.keyRef, address: created.address, shardId: deps.shardId, purpose: 'GAS_TANK' };
    }
    const walletId = body.walletId ?? '';
    if (body.reason === 'ONBOARDING') {
      const active = (await deps.provider.registry.forWallet(walletId)).find(
        (k) => k.purpose === 'EXECUTOR' && k.status === 'ACTIVE' && k.attestation !== null,
      );
      if (active !== undefined && active.attestation !== null) {
        return {
          keyRef: active.keyRef,
          address: active.address,
          shardId: deps.shardId,
          attestation: active.attestation,
        };
      }
    }
    const created = await deps.provider.createKey(walletId, 'EXECUTOR');
    const attestation = deps.attestor.issue({ walletId, executor: created.address });
    await deps.provider.registry.setAttestation(created.keyRef, attestation);
    return { keyRef: created.keyRef, address: created.address, shardId: deps.shardId, attestation };
  });

  // Retiro de una S tras su rotación on-chain [B-SIG-08]: sólo si la Safe de esa wallet (vinculada por SafeTx ya
  // co-firmadas por este shard) tiene hoy otra S; la clave deja de firmar y su keystore se destruye a los 30 días.
  app.post('/v1/keys/retire', async (request) => {
    const body = parse(RetireRequestSchema, request.body);
    if (deps.reader === undefined) throw new SignerError('NOT_FOUND', 'el shard no retira claves');
    const key = (await deps.provider.registry.forWallet(body.walletId)).find(
      (k) => k.purpose === 'EXECUTOR' && sameAddress(k.address, body.address),
    );
    if (key === undefined) throw new SignerError('KEY_NOT_FOUND');
    if (key.status !== 'ACTIVE') return { keyRef: key.keyRef, status: key.status, destroyAfter: key.destroyAfter };
    const linked = await deps.provider.registry.db
      .selectFrom('signed_safe_txs')
      .select('id')
      .where('wallet_id', '=', body.walletId)
      .where('safe', '=', body.safe.toLowerCase())
      .executeTakeFirst();
    if (linked === undefined) throw new SignerError('BAD_REQUEST', 'la Safe no corresponde a la wallet en este shard');
    const block = await deps.reader.block();
    const roles = await deps.reader.roles(body.safe, block);
    if (sameAddress(roles.executor, body.address))
      throw new SignerError('BAD_REQUEST', 'la clave sigue siendo la S de la Safe');
    const destroyAfter = await retireKey(deps.provider.registry, key.keyRef);
    return { keyRef: key.keyRef, status: 'RETIRED', destroyAfter };
  });

  app.post('/v1/sign-safe-tx', async (request) => {
    if (deps.signSafeTx === undefined) throw new SignerError('NOT_FOUND', 'el shard platform no firma SafeTx');
    return deps.signSafeTx.sign(parse(SignSafeTxRequestSchema, request.body));
  });

  app.post('/v1/sign-platform-tx', async (request) => {
    if (deps.platformTx === undefined) throw new SignerError('NOT_FOUND', 'sólo el shard platform');
    return deps.platformTx.sign(parse(PlatformTxRequestSchema, request.body));
  });

  app.get('/v1/gas-tank', async () => {
    if (deps.platformTx === undefined) throw new SignerError('NOT_FOUND', 'sólo el shard platform');
    const address = await deps.platformTx.gasTankAddress();
    if (address === undefined) throw new SignerError('KEY_NOT_FOUND', 'sin cuenta gas tank');
    return { address, shardId: deps.shardId };
  });

  await app.ready();
  return app;
}

export type SignerServer = Awaited<ReturnType<typeof buildServer>>;
