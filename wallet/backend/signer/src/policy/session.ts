// PlatformSession y envelope de envío en el signer [B-PSES-04/06] (implementación propia; paso 2 de [B-Q-02] repetido
// por el signer). El token es un JWS EdDSA del emisor de sesiones (clave pública fijada), con audiencia `mtw-signer`;
// el envelope `MTW-SUBMIT-V1\n` + JCS({operationId, safeTxHash, sessionId, submittedAt}) está firmado con la session key
// P-256 del token. La validez se evalúa AL MOMENTO DEL ENVÍO (issuedAt ≤ submittedAt ≤ expiresAt) y la operación no
// puede superar la antigüedad máxima (24 h) desde submittedAt.
import { z } from 'zod';
import { canonicalJson } from '../crypto/jcs.ts';
import { isAddress, sameAddress } from '../crypto/keccak.ts';
import { JwsError, verifyJws, type PinnedKeys } from '../crypto/jws.ts';
import { P256JwkSchema, verifyP256 } from '../crypto/p256.ts';
import { PLATFORM_SCOPES } from './operations.ts';

const uuid = z.uuid();
const MAX_SESSION_SECONDS = 900;

export const PlatformSessionClaimsSchema = z.object({
  userId: uuid,
  walletId: uuid.nullable(),
  safe: z
    .string()
    .refine((v) => isAddress(v))
    .nullable(),
  platformId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  sessionPublicKey: P256JwkSchema,
  sessionId: uuid,
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  scope: z.enum(PLATFORM_SCOPES),
  authMethod: z.enum(['OPAQUE_U', 'STEP_UP']),
  accountSessionId: uuid,
  aud: z.array(z.string()).min(1),
});
export type PlatformSessionClaims = z.infer<typeof PlatformSessionClaimsSchema>;

export const SubmissionEnvelopeSchema = z
  .object({
    operationId: uuid,
    safeTxHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    sessionId: uuid,
    submittedAt: z.number().int().positive(),
  })
  .strict();
export type SubmissionEnvelope = z.infer<typeof SubmissionEnvelopeSchema>;

export const SUBMISSION_PREFIX = 'MTW-SUBMIT-V1\n';

export function submissionCanonical(envelope: SubmissionEnvelope): string {
  return `${SUBMISSION_PREFIX}${canonicalJson(envelope)}`;
}

export type SessionProblem =
  | 'TOKEN_INVALID'
  | 'AUDIENCE'
  | 'PLATFORM'
  | 'WALLET_MISMATCH'
  | 'ENVELOPE_MISMATCH'
  | 'ENVELOPE_SIGNATURE'
  | 'OUTSIDE_SESSION'
  | 'SIGNATURE_STALE'
  | 'FUTURE_SUBMISSION';

export class SessionError extends Error {
  override name = 'SessionError';
  readonly problem: SessionProblem;

  constructor(problem: SessionProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

export async function verifyPlatformSessionToken(
  token: string,
  issuerKeys: PinnedKeys,
  platformId: string,
): Promise<PlatformSessionClaims> {
  let payload: unknown;
  try {
    ({ payload } = await verifyJws(token, issuerKeys));
  } catch (error) {
    if (error instanceof JwsError)
      throw new SessionError('TOKEN_INVALID', `PlatformSession inválida: ${error.message}`);
    throw error;
  }
  const parsed = PlatformSessionClaimsSchema.safeParse(payload);
  if (!parsed.success) throw new SessionError('TOKEN_INVALID', 'claims de PlatformSession inválidos');
  const claims = parsed.data;
  if (!claims.aud.includes('mtw-signer')) throw new SessionError('AUDIENCE', 'la PlatformSession no es para el signer');
  if (claims.platformId !== platformId) throw new SessionError('PLATFORM', 'PlatformSession de otra plataforma');
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > MAX_SESSION_SECONDS) {
    throw new SessionError('TOKEN_INVALID', 'vigencia de PlatformSession fuera de rango');
  }
  return claims;
}

export interface SubmissionCheck {
  claims: PlatformSessionClaims;
  envelope: SubmissionEnvelope;
  envelopeSignature: string;
  operationId: string;
  walletId: string;
  safe: string;
  safeTxHash: string;
  now: number;
  maxAgeSeconds: number;
  clockSkewSeconds: number;
}

/** Envelope de envío [B-PSES-06]: ligado a la operación, a la SafeTx, a la sesión y firmado por su session key. */
export function verifySubmission(check: SubmissionCheck): void {
  const { claims, envelope } = check;
  if (claims.walletId !== check.walletId || claims.safe === null || !sameAddress(claims.safe, check.safe)) {
    throw new SessionError('WALLET_MISMATCH', 'la PlatformSession es de otra wallet o Safe');
  }
  if (
    envelope.operationId !== check.operationId ||
    envelope.sessionId !== claims.sessionId ||
    envelope.safeTxHash !== check.safeTxHash.toLowerCase()
  ) {
    throw new SessionError('ENVELOPE_MISMATCH', 'el envelope no corresponde a la operación, la SafeTx o la sesión');
  }
  if (!verifyP256(claims.sessionPublicKey, submissionCanonical(envelope), check.envelopeSignature)) {
    throw new SessionError('ENVELOPE_SIGNATURE', 'firma del envelope inválida');
  }
  if (envelope.submittedAt < claims.issuedAt || envelope.submittedAt > claims.expiresAt) {
    throw new SessionError('OUTSIDE_SESSION', 'el envío no ocurrió dentro de la vigencia de la PlatformSession');
  }
  if (envelope.submittedAt > check.now + check.clockSkewSeconds) {
    throw new SessionError('FUTURE_SUBMISSION', 'envío con fecha futura');
  }
  if (check.now - envelope.submittedAt > check.maxAgeSeconds) {
    throw new SessionError('SIGNATURE_STALE', 'la firma supera la antigüedad máxima desde el envío');
  }
}
