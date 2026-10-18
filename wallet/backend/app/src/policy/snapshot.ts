// Snapshot de policy firmado en el backend [B-POL-01] (implementación propia, independiente de la del signer; P13.T10
// le agrega la evaluación completa): firma Ed25519 sobre los bytes exactos del archivo con la clave pública de policy
// fijada, formato y entorno. El backend envía `version` al signer en cada pedido (deben coincidir).
import { createHash, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => getAddress(v));

const hash32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as Hex);

const SnapshotSchema = z.object({
  format: z.literal('mtw-policy-snapshot'),
  formatVersion: z.literal(1),
  version: z.number().int().min(1),
  environment: z.enum(['local', 'staging', 'production']),
  platformId: z.string(),
  chainId: z.literal(8453),
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
  tokens: z.array(z.object({ symbol: z.string(), address, decimals: z.number().int() })),
});

export interface BackendPolicySnapshot {
  version: number;
  environment: 'local' | 'staging' | 'production';
  platformId: string;
  chainId: 8453;
  contracts: Record<keyof z.infer<typeof SnapshotSchema>['contracts'], Address>;
  codehashes: Record<keyof z.infer<typeof SnapshotSchema>['codehashes'], Hex>;
  sha256: `0x${string}`;
}

export class PolicySnapshotError extends Error {
  override name = 'PolicySnapshotError';
}

export function loadPolicySnapshot(path: string, publicKey: KeyObject, environment: string): BackendPolicySnapshot {
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
  const parsed = SnapshotSchema.safeParse(json);
  if (!parsed.success) throw new PolicySnapshotError('snapshot de policy con formato inválido');
  if (parsed.data.environment !== environment)
    throw new PolicySnapshotError(`el snapshot es de ${parsed.data.environment}`);
  return {
    version: parsed.data.version,
    environment: parsed.data.environment,
    platformId: parsed.data.platformId,
    chainId: parsed.data.chainId,
    contracts: parsed.data.contracts,
    codehashes: parsed.data.codehashes,
    sha256: `0x${createHash('sha256').update(bytes).digest('hex')}`,
  };
}
