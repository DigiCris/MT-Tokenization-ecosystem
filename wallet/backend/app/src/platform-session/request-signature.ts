// Requests críticos firmados [B-PSES-05] y envelope de envío [B-PSES-06] (librería que reusa el worker; el signer tiene
// su propia implementación, P11). Formatos con vectores en contracts/test/vectors/wire/p256.json.
//
// Headers de un request crítico (además de `X-Platform-Session`):
//   X-Session-Timestamp   segundos Unix (±60 s del reloj del servidor)
//   X-Session-Nonce       16 bytes en hex (único por sesión durante 5 min, Valkey SET NX)
//   X-Session-Signature   ECDSA P-256 IEEE P1363 en base64url sobre
//                         MTW-REQ-V1\n{method}\n{path}\n{sha256hex(body)}\n{timestamp}\n{nonce}\n{sessionId}
// `path` es la URL del request tal como llega (ruta y query); `body` son los bytes exactos recibidos (vacío si no hay).
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { canonicalJson } from '../lib/jcs.ts';
import { verifyP256, type P256PublicJwk } from './keys.ts';
import type { PlatformSessionClaims } from './token.ts';

export const REQUEST_SIGNATURE_WINDOW_SECONDS = 60;
export const REQUEST_NONCE_TTL_SECONDS = 5 * 60;
/** Antigüedad máxima de una firma enviada hasta su ejecución ([B-PSES-06]). */
export const SUBMISSION_MAX_AGE_SECONDS = 24 * 3600;

export const SIGNATURE_HEADERS = {
  timestamp: 'x-session-timestamp',
  nonce: 'x-session-nonce',
  signature: 'x-session-signature',
} as const;

/**
 * Headers de un request crítico que no son esquemas de seguridad (para la spec OpenAPI: Swagger "Try it out" los muestra
 * como campos). El token y la firma son los esquemas `platformSession` y `sessionSignature`.
 */
export const CriticalRequestHeadersSchema = z.object({
  'x-session-timestamp': z.string().optional().describe('Segundos Unix del momento de la firma (±60 s)'),
  'x-session-nonce': z.string().optional().describe('16 bytes en hex, un solo uso por PlatformSession'),
});

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalRequest(input: {
  method: string;
  path: string;
  body: Buffer | string;
  timestamp: string;
  nonce: string;
  sessionId: string;
}): string {
  return [
    'MTW-REQ-V1',
    input.method.toUpperCase(),
    input.path,
    sha256Hex(input.body),
    input.timestamp,
    input.nonce,
    input.sessionId,
  ].join('\n');
}

export type RequestSignatureProblem = 'MISSING' | 'MALFORMED' | 'EXPIRED' | 'SIGNATURE' | 'REPLAYED';

export class RequestSignatureError extends Error {
  override name = 'RequestSignatureError';
  readonly problem: RequestSignatureProblem;

  constructor(problem: RequestSignatureProblem) {
    super(`firma de request inválida (${problem})`);
    this.problem = problem;
  }
}

/** Nonces de request ya usados (por sesión, 5 min). */
export class RequestNonceStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /** true si el nonce no se había usado (y queda reservado); false si es una repetición. */
  async claim(sessionId: string, nonce: string): Promise<boolean> {
    const key = `mtw:reqnonce:${sessionId}:${nonce}`;
    return (await this.#redis.set(key, '1', 'EX', REQUEST_NONCE_TTL_SECONDS, 'NX')) === 'OK';
  }
}

/**
 * Verifica un request crítico. El orden importa: formato y ventana de tiempo, firma, y recién con una firma válida se
 * consume el nonce (un request inválido no le quema el nonce al cliente legítimo).
 */
export async function verifyCriticalRequest(input: {
  method: string;
  path: string;
  body: Buffer | string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  sessionId: string;
  sessionPublicKey: P256PublicJwk;
  nonces: RequestNonceStore;
  now?: number;
}): Promise<void> {
  const header = (name: string) => {
    const value = input.headers[name];
    return typeof value === 'string' ? value : undefined;
  };
  const timestamp = header(SIGNATURE_HEADERS.timestamp);
  const nonce = header(SIGNATURE_HEADERS.nonce);
  const signature = header(SIGNATURE_HEADERS.signature);
  if (timestamp === undefined || nonce === undefined || signature === undefined)
    throw new RequestSignatureError('MISSING');
  if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{32}$/.test(nonce)) throw new RequestSignatureError('MALFORMED');
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestamp)) > REQUEST_SIGNATURE_WINDOW_SECONDS) throw new RequestSignatureError('EXPIRED');
  const message = canonicalRequest({
    method: input.method,
    path: input.path,
    body: input.body,
    timestamp,
    nonce,
    sessionId: input.sessionId,
  });
  if (!verifyP256(input.sessionPublicKey, message, signature)) throw new RequestSignatureError('SIGNATURE');
  if (!(await input.nonces.claim(input.sessionId, nonce))) throw new RequestSignatureError('REPLAYED');
}

// --- Envelope de envío [B-PSES-06] -------------------------------------------------------------------------------

export const SubmissionEnvelopeSchema = z
  .object({
    operationId: z.uuid(),
    safeTxHash: z.string().regex(/^0x[0-9a-f]{64}$/, { error: 'safeTxHash de 32 bytes en hex minúscula' }),
    sessionId: z.uuid(),
    submittedAt: z.number().int().positive(),
  })
  .strict()
  .meta({ id: 'SubmissionEnvelope' });

export type SubmissionEnvelope = z.infer<typeof SubmissionEnvelopeSchema>;

export function submissionCanonical(envelope: SubmissionEnvelope): string {
  return `MTW-SUBMIT-V1\n${canonicalJson(envelope)}`;
}

export type SubmissionProblem = 'SESSION_MISMATCH' | 'OUTSIDE_SESSION' | 'SIGNATURE' | 'STALE';

/**
 * Verifica el envelope contra la PlatformSession con la que se envió: misma sesión, `issuedAt ≤ submittedAt ≤ expiresAt`
 * y firma de su session key. Con `executionTime` además exige que no haya pasado la antigüedad máxima (24 h).
 */
export function submissionProblem(input: {
  envelope: SubmissionEnvelope;
  signature: string;
  claims: Pick<PlatformSessionClaims, 'sessionId' | 'issuedAt' | 'expiresAt' | 'sessionPublicKey'>;
  executionTime?: number;
}): SubmissionProblem | null {
  const { envelope, claims } = input;
  if (envelope.sessionId !== claims.sessionId) return 'SESSION_MISMATCH';
  if (envelope.submittedAt < claims.issuedAt || envelope.submittedAt > claims.expiresAt) return 'OUTSIDE_SESSION';
  if (!verifyP256(claims.sessionPublicKey, submissionCanonical(envelope), input.signature)) return 'SIGNATURE';
  if (
    input.executionTime !== undefined &&
    Math.floor(input.executionTime / 1000) - envelope.submittedAt > SUBMISSION_MAX_AGE_SECONDS
  ) {
    return 'STALE';
  }
  return null;
}
