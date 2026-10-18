// Snapshot de policy firmado en el backend [B-POL-01] (implementación propia, independiente de la del signer): firma
// Ed25519 sobre los bytes exactos del archivo con la clave pública de policy fijada, formato, entorno y contenido
// completo (direcciones y codehashes del sistema, tokens, operaciones por rol, límites, swap, sesión y gas). El
// anti-rollback queda registrado en `policy_snapshots` (policy/store.ts). El backend envía `version` al signer en cada
// pedido (deben coincidir).
import { createHash, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

export const OPERATION_TYPES = [
  'SEND',
  'SWAP_APPROVE',
  'SWAP',
  'WHITELIST_ADD',
  'WHITELIST_REMOVE',
  'ROTATION_PROPOSE',
  'ROTATION_EXECUTE',
  'NOOP_CANCEL',
  'MIGRATION_TRANSFER',
  'APPROVE_REVOKE',
  'GUARD_UPGRADE',
] as const;
export type OperationKind = (typeof OPERATION_TYPES)[number];

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => getAddress(v));

const hash32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as Hex);

const amount = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .transform((v) => BigInt(v));

const SnapshotSchema = z.object({
  format: z.literal('mtw-policy-snapshot'),
  formatVersion: z.literal(1),
  version: z.number().int().min(1),
  environment: z.enum(['local', 'staging', 'production']),
  platformId: z.string(),
  chainId: z.literal(8453),
  issuedAt: z.string(),
  contracts: z.object({
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
  }),
  /** Runtime codehash esperado de cada contrato del sistema y de las piezas de Safe (verificación V9 §16). */
  codehashes: z.object({
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
  }),
  tokens: z
    .array(z.object({ symbol: z.enum(['USDC', 'USDT']), address, decimals: z.literal(6) }))
    .length(2)
    .refine((t) => new Set(t.map((x) => x.symbol)).size === 2, 'tokens repetidos'),
  /** Operaciones habilitadas por rol [B-POL-03]. */
  operations: z.object({ U: z.array(z.enum(OPERATION_TYPES)), R: z.array(z.enum(OPERATION_TYPES)) }),
  /** [B-POL-02] (ADR-025): montos en unidades de 6 decimales. */
  limits: z.object({
    perOperationMax: amount,
    dailyOutflowMax: amount,
    twoFactorThreshold: amount,
    swapMax: amount,
    minPerOperation: amount,
  }),
  swap: z.object({
    defaultSlippageBps: z.number().int().min(0).max(50),
    maxSlippageBps: z.number().int().min(0).max(50),
    deadlineSeconds: z.number().int().min(60).max(3_600),
  }),
  session: z.object({
    maxSignatureAgeSeconds: z.number().int().min(60).max(86_400),
    clockSkewSeconds: z.number().int().min(0).max(300),
  }),
  gas: z.object({ maxFeePerGasWei: amount, maxPriorityFeePerGasWei: amount, maxGasLimit: z.number().int() }),
  gasTank: z.object({ topupMaxWei: amount, dailyCapWei: amount, maxGasLimit: z.number().int() }),
  /**
   * Sucesores del Guard y del module guard ([C-GRD-17], ADR-029) ya registrados en el PolicyRegistry: una Safe que
   * instaló uno sigue operando en modo asistido. Cada Guard sucesor trae su propio RotationTimelock. Opcional: un
   * snapshot sin sucesores sólo acepta los contratos de `contracts`.
   */
  successors: z
    .object({
      guards: z.array(z.object({ guard: address, rotationTimelock: address })).max(8),
      moduleGuards: z.array(address).max(8),
    })
    .default({ guards: [], moduleGuards: [] }),
});

type ParsedSnapshot = z.infer<typeof SnapshotSchema>;

export interface BackendPolicySnapshot {
  version: number;
  environment: 'local' | 'staging' | 'production';
  platformId: string;
  chainId: 8453;
  contracts: Record<keyof ParsedSnapshot['contracts'], Address>;
  codehashes: Record<keyof ParsedSnapshot['codehashes'], Hex>;
  tokens: { USDC: Address; USDT: Address };
  operations: { U: readonly OperationKind[]; R: readonly OperationKind[] };
  limits: ParsedSnapshot['limits'];
  swap: ParsedSnapshot['swap'];
  session: ParsedSnapshot['session'];
  gas: ParsedSnapshot['gas'];
  successors: {
    guards: readonly { guard: Address; rotationTimelock: Address }[];
    moduleGuards: readonly Address[];
  };
  sha256: `0x${string}`;
}

export class PolicySnapshotError extends Error {
  override name = 'PolicySnapshotError';
}

/** Contenido del snapshot ya verificado (o de un vector): valida el formato y arma la vista del backend. */
export function parsePolicySnapshot(json: unknown, sha256: `0x${string}`): BackendPolicySnapshot {
  const parsed = SnapshotSchema.safeParse(json);
  if (!parsed.success) throw new PolicySnapshotError('snapshot de policy con formato inválido');
  const data = parsed.data;
  if (data.swap.defaultSlippageBps > data.swap.maxSlippageBps) {
    throw new PolicySnapshotError('snapshot de policy con slippage por defecto mayor al máximo');
  }
  const token = (symbol: 'USDC' | 'USDT') => {
    const entry = data.tokens.find((t) => t.symbol === symbol);
    if (!entry) throw new PolicySnapshotError(`snapshot de policy sin ${symbol}`);
    return entry.address;
  };
  return {
    version: data.version,
    environment: data.environment,
    platformId: data.platformId,
    chainId: data.chainId,
    contracts: data.contracts,
    codehashes: data.codehashes,
    tokens: { USDC: token('USDC'), USDT: token('USDT') },
    operations: data.operations,
    limits: data.limits,
    swap: data.swap,
    session: data.session,
    gas: data.gas,
    successors: data.successors,
    sha256,
  };
}

export interface LoadedPolicySnapshot extends BackendPolicySnapshot {
  /** Firma Ed25519 (64 bytes) sobre los bytes exactos del archivo. */
  signature: Buffer;
  /** Contenido JSON tal cual se firmó (para registrarlo en policy_snapshots). */
  payload: unknown;
}

export function loadPolicySnapshot(path: string, publicKey: KeyObject, environment: string): LoadedPolicySnapshot {
  let bytes: Buffer;
  let signature: Buffer;
  try {
    bytes = readFileSync(path);
    signature = Buffer.from(readFileSync(`${path}.sig`, 'utf8').trim(), 'base64');
  } catch {
    throw new PolicySnapshotError('no se puede leer el snapshot de policy o su firma (.sig)');
  }
  if (signature.length !== 64 || !verify(null, bytes, publicKey, signature)) {
    throw new PolicySnapshotError('firma del snapshot de policy inválida');
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new PolicySnapshotError('snapshot de policy con formato inválido');
  }
  const snapshot = parsePolicySnapshot(json, `0x${createHash('sha256').update(bytes).digest('hex')}`);
  if (snapshot.environment !== environment) throw new PolicySnapshotError(`el snapshot es de ${snapshot.environment}`);
  return { ...snapshot, signature, payload: json };
}
