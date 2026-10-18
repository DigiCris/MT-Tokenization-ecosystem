// Snapshot de policy firmado [B-POL-01]: `config/policy/<env>/policy-snapshot.json` + `.sig` (Ed25519 sobre los bytes
// exactos del archivo, base64). La clave pública de policy está fijada en la configuración del signer. El signer
// rechaza snapshots con firma inválida, de otro entorno o con versión menor a la vigente (anti-rollback, registrado en
// su DB: una misma versión no puede cambiar de contenido).
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { isAddress } from '../crypto/keccak.ts';
import type { SignerDatabase } from '../state/schema.ts';
import { OPERATION_TYPES } from './operations.ts';

const address = z
  .string()
  .refine((v) => isAddress(v), 'dirección inválida')
  .transform((v) => v.toLowerCase() as `0x${string}`);
const hash32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'hash de 32 bytes')
  .transform((v) => v.toLowerCase() as `0x${string}`);
const amount = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .transform((v) => BigInt(v));

export const PolicySnapshotSchema = z
  .object({
    format: z.literal('mtw-policy-snapshot'),
    formatVersion: z.literal(1),
    version: z.number().int().min(1).max(2_147_483_647),
    environment: z.enum(['local', 'staging', 'production']),
    platformId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    chainId: z.literal(8453),
    issuedAt: z.iso.datetime(),
    contracts: z
      .object({
        securityGuard: address,
        rotationTimelock: address,
        walletFactory: address,
        safeBootstrap: address,
        policyRegistry: address,
        destinationWhitelist: address,
        denyAllModuleGuard: address,
        swapExecutor: address,
        safeL2Singleton: address,
        safeProxyFactory: address,
      })
      .strict(),
    /** Runtime codehash esperado de cada contrato del sistema y de las piezas de Safe (verificación V9 §16). */
    codehashes: z
      .object({
        securityGuard: hash32,
        rotationTimelock: hash32,
        walletFactory: hash32,
        safeBootstrap: hash32,
        policyRegistry: hash32,
        destinationWhitelist: hash32,
        denyAllModuleGuard: hash32,
        swapExecutor: hash32,
        safeL2Singleton: hash32,
        safeProxyFactory: hash32,
        safeProxyRuntime: hash32,
      })
      .strict(),
    tokens: z.array(z.object({ symbol: z.enum(['USDC', 'USDT']), address, decimals: z.literal(6) }).strict()).length(2),
    operations: z.object({ U: z.array(z.enum(OPERATION_TYPES)), R: z.array(z.enum(OPERATION_TYPES)) }).strict(),
    limits: z
      .object({
        perOperationMax: amount,
        dailyOutflowMax: amount,
        twoFactorThreshold: amount,
        swapMax: amount,
        minPerOperation: amount,
      })
      .strict(),
    swap: z
      .object({
        defaultSlippageBps: z.number().int().min(0).max(50),
        maxSlippageBps: z.number().int().min(0).max(50),
        deadlineSeconds: z.number().int().min(60).max(3_600),
      })
      .strict(),
    session: z
      .object({
        maxSignatureAgeSeconds: z.number().int().min(60).max(86_400),
        clockSkewSeconds: z.number().int().min(0).max(300),
      })
      .strict(),
    gas: z
      .object({ maxFeePerGasWei: amount, maxPriorityFeePerGasWei: amount, maxGasLimit: z.number().int().min(21_000) })
      .strict(),
    gasTank: z
      .object({
        topupMaxWei: amount,
        dailyCapWei: amount,
        maxGasLimit: z.number().int().min(21_000),
      })
      .strict(),
    /**
     * Sucesores del Guard y del module guard ya registrados en el PolicyRegistry ([C-GRD-17], ADR-029): una Safe que
     * instaló uno sigue en modo asistido. Cada Guard sucesor trae su propio RotationTimelock. Opcional.
     */
    successors: z
      .object({
        guards: z.array(z.object({ guard: address, rotationTimelock: address }).strict()).max(8),
        moduleGuards: z.array(address).max(8),
      })
      .strict()
      .default({ guards: [], moduleGuards: [] }),
  })
  .strict()
  .superRefine((s, ctx) => {
    const symbols = new Set(s.tokens.map((t) => t.symbol));
    if (symbols.size !== 2) ctx.addIssue({ code: 'custom', message: 'tokens repetidos', path: ['tokens'] });
    if (s.swap.defaultSlippageBps > s.swap.maxSlippageBps) {
      ctx.addIssue({ code: 'custom', message: 'slippage por defecto mayor al máximo', path: ['swap'] });
    }
    if (s.limits.minPerOperation > s.limits.perOperationMax || s.limits.perOperationMax > s.limits.dailyOutflowMax) {
      ctx.addIssue({ code: 'custom', message: 'límites inconsistentes', path: ['limits'] });
    }
    if (s.gas.maxPriorityFeePerGasWei > s.gas.maxFeePerGasWei) {
      ctx.addIssue({ code: 'custom', message: 'priority fee mayor al max fee', path: ['gas'] });
    }
  });

export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;

export interface LoadedSnapshot {
  snapshot: PolicySnapshot;
  /** sha256 de los bytes exactos del archivo (0x…). */
  sha256: `0x${string}`;
}

export type SnapshotProblem = 'SIGNATURE' | 'FORMAT' | 'ENVIRONMENT' | 'ROLLBACK' | 'VERSION_REUSED';

export class PolicySnapshotError extends Error {
  override name = 'PolicySnapshotError';
  readonly problem: SnapshotProblem;

  constructor(problem: SnapshotProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

/** Clave pública de policy: SPKI DER en base64 (como la genera `pnpm secrets:local`). */
export function policyPublicKey(spkiBase64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('la clave de policy debe ser Ed25519');
  return key;
}

/** Verifica firma y formato de un snapshot (bytes exactos + firma base64). No consulta el anti-rollback. */
export function verifySnapshot(
  bytes: Uint8Array,
  signatureBase64: string,
  publicKey: KeyObject,
  expected?: { environment?: string },
): LoadedSnapshot {
  const signature = Buffer.from(signatureBase64.trim(), 'base64');
  if (signature.length !== 64 || !verify(null, bytes, publicKey, signature)) {
    throw new PolicySnapshotError('SIGNATURE', 'firma del snapshot de policy inválida');
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    throw new PolicySnapshotError('FORMAT', 'el snapshot de policy no es JSON');
  }
  const parsed = PolicySnapshotSchema.safeParse(json);
  if (!parsed.success) {
    throw new PolicySnapshotError('FORMAT', `snapshot de policy inválido: ${z.prettifyError(parsed.error)}`);
  }
  if (expected?.environment !== undefined && parsed.data.environment !== expected.environment) {
    throw new PolicySnapshotError('ENVIRONMENT', `el snapshot es de ${parsed.data.environment}`);
  }
  return {
    snapshot: parsed.data,
    sha256: `0x${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/**
 * Anti-rollback: la versión debe ser ≥ la mayor aceptada antes y, si es igual, con el mismo contenido. Una versión
 * nueva queda registrada (append-only) como vigente.
 */
export async function activateSnapshot(db: Kysely<SignerDatabase>, loaded: LoadedSnapshot): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Serializa activaciones concurrentes de shards que comparten la base (no debería pasar: una DB por shard).
    await sql`LOCK TABLE policy_state IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
    const latest = await trx
      .selectFrom('policy_state')
      .select(['version', 'sha256'])
      .orderBy('version', 'desc')
      .executeTakeFirst();
    const { version, environment } = loaded.snapshot;
    if (latest !== undefined) {
      if (version < latest.version) {
        throw new PolicySnapshotError('ROLLBACK', `versión ${version} menor que la vigente (${latest.version})`);
      }
      if (version === latest.version) {
        if (latest.sha256 !== loaded.sha256) {
          throw new PolicySnapshotError('VERSION_REUSED', `la versión ${version} ya existe con otro contenido`);
        }
        return;
      }
    }
    await trx.insertInto('policy_state').values({ version, sha256: loaded.sha256, environment }).execute();
  });
}
