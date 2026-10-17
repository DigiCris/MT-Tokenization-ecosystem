// Atestaciones que el signer verifica antes de co-firmar (implementación propia):
// - ChallengeCompletion (emisor de sesiones) [W-03]/[B-POL-02]: 2FA de alto valor (HIGH_VALUE_TX) y alta de whitelist
//   (WHITELIST_ADD), ligadas a la Safe, la SafeTx, el nonce y los datos decodificados de la operación;
// - IntegrityAttestation (integrity monitor) para la pausa por integridad (INTEGRITY_REQUIRED);
// - SignerKeyAttestation (clave de atestación del propio signer) para rotar S sólo hacia claves de un signer.
import { z } from 'zod';
import { isAddress, sameAddress, type Address } from '../crypto/keccak.ts';
import { JwsError, verifyJws, type PinnedKeys } from '../crypto/jws.ts';

const address = z.string().refine((v) => isAddress(v));

export const ChallengeCompletionSchema = z.object({
  challengeId: z.string().min(1).max(128),
  type: z.enum(['HIGH_VALUE_TX', 'WHITELIST_ADD']),
  userId: z.uuid(),
  safe: address,
  chainId: z.literal(8453),
  action: z.string().min(1).max(64),
  destination: address.optional(),
  safeTxHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  token: address.optional(),
  amount: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,77})$/)
    .optional(),
  nonce: z.number().int().nonnegative(),
  completedAt: z.number().int().positive(),
});
export type ChallengeCompletion = z.infer<typeof ChallengeCompletionSchema>;

export class AttestationError extends Error {
  override name = 'AttestationError';
}

export interface ChallengeExpectation {
  type: ChallengeCompletion['type'];
  action: string;
  userId: string;
  safe: Address;
  safeTxHash: string;
  nonce: bigint;
  destination: Address;
  token?: Address;
  amount?: bigint;
  now: number;
  maxAgeSeconds: number;
  clockSkewSeconds: number;
}

/** true si la atestación es válida y coincide campo por campo con la operación que se va a co-firmar. */
export async function verifyChallengeCompletion(
  token: string,
  issuerKeys: PinnedKeys,
  expected: ChallengeExpectation,
): Promise<boolean> {
  let payload: unknown;
  try {
    ({ payload } = await verifyJws(token, issuerKeys));
  } catch (error) {
    if (error instanceof JwsError) return false;
    throw error;
  }
  const parsed = ChallengeCompletionSchema.safeParse(payload);
  if (!parsed.success) return false;
  const c = parsed.data;
  return (
    c.type === expected.type &&
    c.action === expected.action &&
    c.userId === expected.userId &&
    sameAddress(c.safe, expected.safe) &&
    c.safeTxHash === expected.safeTxHash.toLowerCase() &&
    BigInt(c.nonce) === expected.nonce &&
    c.destination !== undefined &&
    sameAddress(c.destination, expected.destination) &&
    (expected.token === undefined || (c.token !== undefined && sameAddress(c.token, expected.token))) &&
    (expected.amount === undefined || (c.amount !== undefined && BigInt(c.amount) === expected.amount)) &&
    c.completedAt <= expected.now + expected.clockSkewSeconds &&
    expected.now - c.completedAt <= expected.maxAgeSeconds
  );
}

export const IntegrityAttestationSchema = z.object({
  platformId: z.string(),
  app: z.enum(['WALLET', 'RECOVERY']),
  environment: z.enum(['local', 'staging', 'production']),
  releaseId: z.string().min(1).max(128),
  manifestSha256: z.string().regex(/^0x[0-9a-f]{64}$/),
  status: z.enum(['OK', 'MISMATCH', 'UNREACHABLE']),
  observedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});

/** Pausa por integridad: hace falta una IntegrityAttestation OK y vigente de la app que originó la sesión. */
export async function verifyIntegrity(
  token: string | undefined,
  monitorKeys: PinnedKeys,
  expected: {
    platformId: string;
    environment: string;
    app: 'WALLET' | 'RECOVERY';
    now: number;
    clockSkewSeconds: number;
  },
): Promise<boolean> {
  if (token === undefined) return false;
  let payload: unknown;
  try {
    ({ payload } = await verifyJws(token, monitorKeys));
  } catch (error) {
    if (error instanceof JwsError) return false;
    throw error;
  }
  const parsed = IntegrityAttestationSchema.safeParse(payload);
  if (!parsed.success) return false;
  const a = parsed.data;
  return (
    a.platformId === expected.platformId &&
    a.environment === expected.environment &&
    a.app === expected.app &&
    a.status === 'OK' &&
    a.observedAt <= expected.now + expected.clockSkewSeconds &&
    a.expiresAt > expected.now
  );
}

export const SignerKeyAttestationSchema = z
  .object({
    walletId: z.uuid(),
    shardId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    executor: address,
    chainId: z.literal(8453),
    issuedAt: z.number().int().positive(),
  })
  .strict();
export type SignerKeyAttestation = z.infer<typeof SignerKeyAttestationSchema>;

/** La nueva S fue creada por un signer para esta wallet (atestación firmada con la clave de atestación del signer). */
export async function verifySignerKeyAttestation(
  token: string | undefined,
  attestationKeys: PinnedKeys,
  expected: { walletId: string; executor: Address },
): Promise<SignerKeyAttestation | undefined> {
  if (token === undefined) return undefined;
  let payload: unknown;
  try {
    ({ payload } = await verifyJws(token, attestationKeys));
  } catch (error) {
    if (error instanceof JwsError) return undefined;
    throw error;
  }
  const parsed = SignerKeyAttestationSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  return parsed.data.walletId === expected.walletId && sameAddress(parsed.data.executor, expected.executor)
    ? parsed.data
    : undefined;
}

export function assertAttestation(ok: boolean, message: string): void {
  if (!ok) throw new AttestationError(message);
}
