// Token de PlatformSession [B-PSES-01/04], [W-03]: JWS compacto EdDSA (Ed25519, `jose`) firmado con
// SESSION_ISSUER_PRIVATE_KEY, con header `{alg, kid, typ}` y payload en JSON canónico JCS (mismos bytes que
// contracts/test/vectors/wire/jws.json). Audiencia `mtw-api` y `mtw-signer`; viaja en `X-Platform-Session`.
//
// El mismo emisor firma la atestación `ChallengeCompletion` (P14, [B-POL-02]): el usuario completó el challenge de
// alta de whitelist o el 2FA de alto valor ligado a una SafeTx exacta; el signer la verifica campo por campo con la
// clave pública del emisor fijada antes de co-firmar.
//
// `kid` = thumbprint RFC 7638 de la clave pública del emisor: no hace falta configurarlo y la rotación (ventana dual,
// P26) sólo agrega la clave pública vieja al mapa de verificación.
import type { KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, CompactSign, compactVerify, exportJWK } from 'jose';
import { isAddress } from 'viem';
import { z } from 'zod';
import type { Secret } from '../config/secret.ts';
import { canonicalJson } from '../lib/jcs.ts';
import { P256PublicJwkSchema } from './keys.ts';

export const PLATFORM_SCOPES = [
  'OPERATIONS',
  'ONBOARDING',
  'RECOVERY',
  'U_REPLACEMENT',
  'ENROLLMENT',
  'KEY_RESTORE',
] as const;
export type PlatformScope = (typeof PLATFORM_SCOPES)[number];
export type PlatformAuthMethod = 'OPAQUE_U' | 'STEP_UP';

/** 15 minutos, no renovable ([B-PSES-01]); el CHECK de `platform_sessions` impone el mismo máximo. */
export const PLATFORM_SESSION_TTL_SECONDS = 15 * 60;
export const PLATFORM_SESSION_AUDIENCE = ['mtw-api', 'mtw-signer'] as const;
/** Tolerancia de reloj entre el emisor y quien verifica. */
const CLOCK_SKEW_SECONDS = 30;

export const PlatformSessionClaimsSchema = z
  .object({
    userId: z.uuid(),
    /** Wallet a la que está atada la sesión (null en un onboarding que todavía no creó la wallet). */
    walletId: z.uuid().nullable(),
    /** Safe de la wallet (null hasta el deploy). */
    safe: z
      .string()
      .refine((v) => isAddress(v, { strict: true }), { error: 'dirección con checksum' })
      .nullable(),
    platformId: z.string().min(2),
    sessionPublicKey: P256PublicJwkSchema,
    sessionId: z.uuid(),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    scope: z.enum(PLATFORM_SCOPES),
    authMethod: z.enum(['OPAQUE_U', 'STEP_UP']),
    accountSessionId: z.uuid(),
    aud: z.array(z.string()).min(1),
  })
  .strict();

export type PlatformSessionClaims = z.infer<typeof PlatformSessionClaimsSchema>;

const checksummed = z.string().refine((v) => isAddress(v, { strict: true }), { error: 'dirección con checksum' });

export const CHALLENGE_COMPLETION_TYPES = ['HIGH_VALUE_TX', 'WHITELIST_ADD'] as const;

/** ChallengeCompletion [W-03]: los campos que el signer compara con la operación que va a co-firmar. */
export const ChallengeCompletionClaimsSchema = z
  .object({
    challengeId: z.string().min(1).max(128),
    type: z.enum(CHALLENGE_COMPLETION_TYPES),
    userId: z.uuid(),
    safe: checksummed,
    chainId: z.literal(8453),
    /** SEND (HIGH_VALUE_TX) o WHITELIST_ADD. */
    action: z.string().min(1).max(64),
    destination: checksummed.optional(),
    safeTxHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    token: checksummed.optional(),
    amount: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,77})$/)
      .optional(),
    /** Nonce de la Safe de la SafeTx. */
    nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    completedAt: z.number().int().positive(),
  })
  .strict();

export type ChallengeCompletionClaims = z.infer<typeof ChallengeCompletionClaimsSchema>;

export type TokenProblem = 'MALFORMED' | 'UNKNOWN_KEY' | 'SIGNATURE' | 'AUDIENCE' | 'EXPIRED' | 'NOT_YET_VALID';

export class PlatformSessionTokenError extends Error {
  override name = 'PlatformSessionTokenError';
  readonly problem: TokenProblem;

  constructor(problem: TokenProblem) {
    super(`token de PlatformSession inválido (${problem})`);
    this.problem = problem;
  }
}

export class PlatformSessionIssuer {
  readonly kid: string;
  readonly #privateKey: Secret<KeyObject>;
  readonly #verificationKeys: ReadonlyMap<string, KeyObject>;
  readonly #audience: string;

  private constructor(
    kid: string,
    privateKey: Secret<KeyObject>,
    verificationKeys: ReadonlyMap<string, KeyObject>,
    audience: string,
  ) {
    this.kid = kid;
    this.#privateKey = privateKey;
    this.#verificationKeys = verificationKeys;
    this.#audience = audience;
  }

  static async thumbprint(publicKey: KeyObject): Promise<string> {
    return calculateJwkThumbprint(await exportJWK(publicKey), 'sha256');
  }

  /**
   * `audience`: quién verifica (la API exige `mtw-api`; el signer, `mtw-signer`). `kid` explícito sólo para reproducir
   * vectores; por defecto, el thumbprint de la clave pública.
   */
  static async create(
    privateKey: Secret<KeyObject>,
    publicKey: KeyObject,
    options: { audience?: string; kid?: string } = {},
  ): Promise<PlatformSessionIssuer> {
    const kid = options.kid ?? (await PlatformSessionIssuer.thumbprint(publicKey));
    return new PlatformSessionIssuer(kid, privateKey, new Map([[kid, publicKey]]), options.audience ?? 'mtw-api');
  }

  async #signCanonical(json: string): Promise<string> {
    // Header en orden alfabético (alg, kid, typ): JSON.stringify de jose produce exactamente el JCS.
    return new CompactSign(new TextEncoder().encode(json))
      .setProtectedHeader({ alg: 'EdDSA', kid: this.kid, typ: 'JWT' })
      .sign(this.#privateKey.reveal());
  }

  /** Firma y kid de un JWS compacto del emisor; devuelve el payload ya decodificado como JSON. */
  async #verifyCompact(token: string): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(token) || token.length > 4096) {
      throw new PlatformSessionTokenError('MALFORMED');
    }
    let header: { alg?: unknown; kid?: unknown; typ?: unknown };
    try {
      header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as typeof header;
    } catch {
      throw new PlatformSessionTokenError('MALFORMED');
    }
    const key = typeof header.kid === 'string' ? this.#verificationKeys.get(header.kid) : undefined;
    if (!key) throw new PlatformSessionTokenError('UNKNOWN_KEY');
    let payload: Uint8Array;
    try {
      ({ payload } = await compactVerify(token, key, { algorithms: ['EdDSA'] }));
    } catch {
      throw new PlatformSessionTokenError('SIGNATURE');
    }
    if (header.typ !== 'JWT') throw new PlatformSessionTokenError('MALFORMED');
    try {
      return JSON.parse(new TextDecoder().decode(payload)) as unknown;
    } catch {
      throw new PlatformSessionTokenError('MALFORMED');
    }
  }

  async sign(claims: PlatformSessionClaims): Promise<string> {
    return this.#signCanonical(canonicalJson(PlatformSessionClaimsSchema.parse(claims)));
  }

  /** ChallengeCompletion firmada por el emisor de sesiones (la verifica el signer con la clave pública fijada). */
  async signChallengeCompletion(claims: ChallengeCompletionClaims): Promise<string> {
    return this.#signCanonical(canonicalJson(ChallengeCompletionClaimsSchema.parse(claims)));
  }

  /** Firma, kid y formato de una ChallengeCompletion (el chequeo de vínculo con la operación es del llamador). */
  async verifyChallengeCompletion(token: string): Promise<ChallengeCompletionClaims> {
    const payload = await this.#verifyCompact(token);
    const parsed = ChallengeCompletionClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new PlatformSessionTokenError('MALFORMED');
    return parsed.data;
  }

  /** Verifica firma, kid, audiencia y vigencia; no consulta la base (eso lo hace PlatformSessionService). */
  async verify(token: string, now = Date.now()): Promise<PlatformSessionClaims> {
    const payload = await this.#verifyCompact(token);
    let claims: PlatformSessionClaims;
    try {
      claims = PlatformSessionClaimsSchema.parse(payload);
    } catch {
      throw new PlatformSessionTokenError('MALFORMED');
    }
    if (!claims.aud.includes(this.#audience)) throw new PlatformSessionTokenError('AUDIENCE');
    const seconds = Math.floor(now / 1000);
    if (claims.expiresAt <= seconds) throw new PlatformSessionTokenError('EXPIRED');
    if (claims.issuedAt > seconds + CLOCK_SKEW_SECONDS) throw new PlatformSessionTokenError('NOT_YET_VALID');
    if (claims.expiresAt - claims.issuedAt > PLATFORM_SESSION_TTL_SECONDS)
      throw new PlatformSessionTokenError('MALFORMED');
    return claims;
  }
}
