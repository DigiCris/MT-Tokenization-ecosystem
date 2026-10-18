// Construcción del snapshot de policy [B-POL-01] desde las direcciones y los codehashes de un deploy
// (contracts/deployments/<red>.json) y config/chains/base-mainnet.json, con los valores por defecto de V1 ([B-POL-02],
// ADR-025). La firma la agrega `pnpm policy:sign` (Ed25519 sobre los bytes exactos del archivo).
import { sign, type KeyObject } from 'node:crypto';
import { checksumAddress } from '../crypto/keccak.ts';
import { PolicySnapshotSchema, type PolicySnapshot } from './snapshot.ts';

export const V1_OPERATIONS = {
  U: [
    'SEND',
    'SWAP_APPROVE',
    'SWAP',
    'APPROVE_REVOKE',
    'WHITELIST_ADD',
    'WHITELIST_REMOVE',
    'ROTATION_PROPOSE',
    'ROTATION_EXECUTE',
    'NOOP_CANCEL',
    'MIGRATION_TRANSFER',
    'GUARD_UPGRADE',
  ],
  R: [
    'NOOP_CANCEL',
    'APPROVE_REVOKE',
    'WHITELIST_REMOVE',
    'ROTATION_PROPOSE',
    'ROTATION_EXECUTE',
    'MIGRATION_TRANSFER',
  ],
} as const;

/** Montos en unidades de 6 decimales (USDC/USDT). */
export const V1_LIMITS = {
  perOperationMax: '10000000000',
  dailyOutflowMax: '20000000000',
  twoFactorThreshold: '1000000000',
  swapMax: '10000000000',
  minPerOperation: '1000000',
} as const;

export interface BuildSnapshotInput {
  environment: 'local' | 'staging' | 'production';
  version: number;
  platformId: string;
  issuedAt?: Date;
  /** Direcciones del deploy (claves de contracts/deployments/<red>.json → contracts). */
  deployment: Record<string, string>;
  /** Runtime codehash de cada contrato del deploy (mismas claves). */
  deploymentCodehashes: Record<string, string>;
  /** config/chains/base-mainnet.json → contracts (direcciones y codehashes fijados de Safe). */
  chain: ChainContracts;
  gas?: { maxFeePerGasWei: string; maxPriorityFeePerGasWei: string; maxGasLimit: number };
  gasTank: { topupMaxWei: string; dailyCapWei: string; maxGasLimit?: number };
  /**
   * Sucesores del Guard y del module guard ya activos en el PolicyRegistry ([C-GRD-17], runbook guard-upgrade.md).
   * Sin sucesores el snapshot no lleva el campo (los snapshots anteriores no cambian).
   */
  successors?: { guards: { guard: string; rotationTimelock: string }[]; moduleGuards: string[] };
}

export interface ChainContracts {
  safeL2Singleton: string;
  safeProxyFactory: string;
  usdc: string;
  usdt: string;
  safeL2SingletonCodehash: string;
  safeProxyFactoryCodehash: string;
  safeProxyRuntimeCodehash: string;
}

function pick(deployment: Record<string, string>, name: string): string {
  const value = deployment[name];
  if (value === undefined) throw new Error(`el deploy no tiene ${name}`);
  return checksumAddress(value);
}

function codehash(codehashes: Record<string, string>, name: string): string {
  const value = codehashes[name];
  if (value === undefined) throw new Error(`el deploy no tiene el codehash de ${name}`);
  return value.toLowerCase();
}

export function buildSnapshot(input: BuildSnapshotInput): Record<string, unknown> {
  const d = input.deployment;
  const h = input.deploymentCodehashes;
  const snapshot = {
    format: 'mtw-policy-snapshot',
    formatVersion: 1,
    version: input.version,
    environment: input.environment,
    platformId: input.platformId,
    chainId: 8453,
    issuedAt: (input.issuedAt ?? new Date()).toISOString(),
    contracts: {
      securityGuard: pick(d, 'SecurityGuard'),
      rotationTimelock: pick(d, 'RotationTimelock'),
      walletFactory: pick(d, 'WalletFactory'),
      safeBootstrap: pick(d, 'SafeBootstrap'),
      policyRegistry: pick(d, 'PolicyRegistry'),
      destinationWhitelist: pick(d, 'DestinationWhitelist'),
      denyAllModuleGuard: pick(d, 'DenyAllModuleGuard'),
      swapExecutor: pick(d, 'SwapExecutorV3'),
      safeL2Singleton: checksumAddress(input.chain.safeL2Singleton),
      safeProxyFactory: checksumAddress(input.chain.safeProxyFactory),
    },
    codehashes: {
      securityGuard: codehash(h, 'SecurityGuard'),
      rotationTimelock: codehash(h, 'RotationTimelock'),
      walletFactory: codehash(h, 'WalletFactory'),
      safeBootstrap: codehash(h, 'SafeBootstrap'),
      policyRegistry: codehash(h, 'PolicyRegistry'),
      destinationWhitelist: codehash(h, 'DestinationWhitelist'),
      denyAllModuleGuard: codehash(h, 'DenyAllModuleGuard'),
      swapExecutor: codehash(h, 'SwapExecutorV3'),
      safeL2Singleton: input.chain.safeL2SingletonCodehash.toLowerCase(),
      safeProxyFactory: input.chain.safeProxyFactoryCodehash.toLowerCase(),
      safeProxyRuntime: input.chain.safeProxyRuntimeCodehash.toLowerCase(),
    },
    tokens: [
      { symbol: 'USDC', address: checksumAddress(input.chain.usdc), decimals: 6 },
      { symbol: 'USDT', address: checksumAddress(input.chain.usdt), decimals: 6 },
    ],
    operations: V1_OPERATIONS,
    limits: V1_LIMITS,
    swap: { defaultSlippageBps: 30, maxSlippageBps: 50, deadlineSeconds: 600 },
    session: { maxSignatureAgeSeconds: 86_400, clockSkewSeconds: 60 },
    gas: input.gas ?? { maxFeePerGasWei: '10000000000', maxPriorityFeePerGasWei: '2000000000', maxGasLimit: 1_500_000 },
    gasTank: {
      topupMaxWei: input.gasTank.topupMaxWei,
      dailyCapWei: input.gasTank.dailyCapWei,
      maxGasLimit: input.gasTank.maxGasLimit ?? 3_000_000,
    },
    ...(input.successors === undefined ||
    (input.successors.guards.length === 0 && input.successors.moduleGuards.length === 0)
      ? {}
      : {
          successors: {
            guards: input.successors.guards.map((g) => ({
              guard: checksumAddress(g.guard),
              rotationTimelock: checksumAddress(g.rotationTimelock),
            })),
            moduleGuards: input.successors.moduleGuards.map((m) => checksumAddress(m)),
          },
        }),
  };
  // Validación con el mismo schema que usa el signer al cargarlo.
  PolicySnapshotSchema.parse(snapshot);
  return snapshot;
}

export function serializeSnapshot(snapshot: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

/** Firma Ed25519 (base64) de los bytes exactos del archivo. */
export function signSnapshotBytes(bytes: Uint8Array, privateKey: KeyObject): string {
  return sign(null, bytes, privateKey).toString('base64');
}

export type { PolicySnapshot };
