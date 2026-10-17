// Spec OpenAPI 3.1 interna de la API mTLS del signer [B-API] (backend/signer/openapi.json): se genera desde los mismos
// schemas Zod que validan los pedidos y NUNCA se publica (el signer no expone Swagger ni puertos públicos).
//   node scripts/openapi.ts          escribe openapi.json
//   node scripts/openapi.ts --check  falla si el archivo no está al día
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { KeysRequestSchema, RetireRequestSchema } from '../src/api/server.ts';
import { SIGNER_ERRORS } from '../src/api/errors.ts';
import { PlatformTxRequestSchema } from '../src/sign/platform-tx.ts';
import { SignSafeTxRequestSchema } from '../src/sign/sign-safe-tx.ts';

const OUT = resolve(import.meta.dirname, '../openapi.json');
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
const address = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const hex = { type: 'string', pattern: '^0x([0-9a-fA-F]{2})*$' };
const ErrorSchema = {
  type: 'object',
  required: ['code', 'retryable'],
  properties: {
    code: { type: 'string', enum: Object.keys(SIGNER_ERRORS) },
    reason: { type: 'string', description: 'Detalle estable: regla estática, código de policy, motivo del Guard.' },
    retryable: { type: 'boolean' },
  },
};
const errors = {
  '400': {
    description: 'Pedido inválido',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '403': {
    description: 'Certificado de cliente no autorizado',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '409': {
    description: 'Conflicto (nonce, versión de policy, tope)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '422': {
    description: 'Rechazo definitivo (reglas estáticas, sesión, policy, Guard, simulación)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '503': {
    description: 'No disponible (RPC, shard no listo, pausa por integridad)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
};
const body = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } });

export function buildSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'MT Wallet — signer-service (API interna mTLS)',
      version: '1',
      description:
        'API interna de cada shard del signer [B-SIG]. Sólo por mTLS (CA privada del entorno, TLS 1.3, cliente `mtw-backend`) dentro de la red Docker `signer`. No se publica.',
    },
    servers: [{ url: 'https://signer-{shard}:8090', variables: { shard: { default: 'dev-1' } } }],
    security: [{ mtls: [] }],
    paths: {
      '/v1/health': {
        get: {
          summary: 'Estado del shard (provider, claves, versión de policy, kid de atestación)',
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                provider: { type: 'string', enum: ['development', 'selfhosted', 'hardware'] },
                shardId: { type: 'string' },
                ready: { type: 'boolean' },
                problems: { type: 'array', items: { type: 'string' } },
                keys: { type: 'object', properties: { active: { type: 'integer' }, broken: { type: 'integer' } } },
                platform: { type: 'boolean' },
                policyVersion: { type: 'integer' },
                attestationKid: { type: 'string' },
              },
            }),
            '403': errors['403'],
          },
        },
      },
      '/v1/keys': {
        post: {
          summary:
            'Crear S para una wallet (o la cuenta gas tank del shard platform) con su SignerKeyAttestation [B-SIG-07]',
          requestBody: body(json(KeysRequestSchema)),
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                keyRef: { type: 'string' },
                address,
                shardId: { type: 'string' },
                attestation: { type: 'string', description: 'JWS EdDSA [W-03]' },
                purpose: { type: 'string' },
              },
            }),
            '400': errors['400'],
            '403': errors['403'],
            '503': errors['503'],
          },
        },
      },
      '/v1/keys/retire': {
        post: {
          summary:
            'Retirar una S que ya no es la de su Safe (verificado on-chain); se destruye a los 30 días [B-SIG-08]',
          requestBody: body(json(RetireRequestSchema)),
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                keyRef: { type: 'string' },
                status: { type: 'string' },
                destroyAfter: { type: 'string', format: 'date-time' },
              },
            }),
            '400': errors['400'],
            '403': errors['403'],
            '422': errors['422'],
          },
        },
      },
      '/v1/sign-safe-tx': {
        post: {
          summary: 'Co-firma de una SafeTx por S tras repetir los pasos 2–8 y 7b de [B-Q-02] [B-SIG-02]',
          requestBody: body(json(SignSafeTxRequestSchema)),
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                operationId: { type: 'string', format: 'uuid' },
                safeTxHash: hex,
                executor: address,
                sSignature: hex,
                signedTx: hex,
                txHash: hex,
                accountNonce: { type: 'string' },
                gasLimit: { type: 'string' },
              },
            }),
            ...errors,
          },
        },
      },
      '/v1/sign-platform-tx': {
        post: {
          summary:
            'Firma de la cuenta gas tank (shard platform): recarga, deploy de Safe o relay de cancelación [B-SIG-05]',
          requestBody: body(json(PlatformTxRequestSchema)),
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                from: address,
                signedTx: hex,
                txHash: hex,
                accountNonce: { type: 'string' },
                gasLimit: { type: 'string' },
              },
            }),
            ...errors,
          },
        },
      },
      '/v1/gas-tank': {
        get: {
          summary: 'Dirección de la cuenta gas tank (shard platform)',
          responses: {
            '200': ok({ type: 'object', properties: { address, shardId: { type: 'string' } } }),
            '403': errors['403'],
          },
        },
      },
      '/v1/metrics': {
        get: {
          summary: 'Métricas Prometheus del shard',
          responses: {
            '200': {
              description: 'text/plain; version=0.0.4',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        mtls: {
          type: 'mutualTLS',
          description: 'Certificado de cliente de la CA del entorno (CN o SAN DNS mtw-backend).',
        },
      },
      schemas: { Error: ErrorSchema },
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = `${JSON.stringify(buildSpec(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
      process.stderr.write('openapi.json desactualizado: pnpm --dir backend/signer openapi\n');
      process.exit(1);
    }
    process.stdout.write('OPENAPI OK\n');
  } else {
    writeFileSync(OUT, text);
    process.stdout.write('openapi.json escrito\n');
  }
}
