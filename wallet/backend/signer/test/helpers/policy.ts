// Snapshot de policy de prueba sobre el deploy real del global setup, firmado con una clave de policy de prueba.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inject } from 'vitest';
import { buildSnapshot, serializeSnapshot, signSnapshotBytes, type ChainContracts } from '../../src/policy/build.ts';
import type { TestEdKey } from './keys.ts';
import { WALLET_ROOT } from './paths.ts';

export function chainContracts(): ChainContracts {
  const chain = JSON.parse(readFileSync(resolve(WALLET_ROOT, 'config/chains/base-mainnet.json'), 'utf8')) as {
    contracts: Record<string, { address: string; codehash: string; proxyRuntimeCodehash?: string }>;
  };
  const c = chain.contracts;
  return {
    safeL2Singleton: c.safeL2Singleton!.address,
    safeProxyFactory: c.safeProxyFactory!.address,
    usdc: c.usdc!.address,
    usdt: c.usdt!.address,
    safeL2SingletonCodehash: c.safeL2Singleton!.codehash,
    safeProxyFactoryCodehash: c.safeProxyFactory!.codehash,
    safeProxyRuntimeCodehash: c.safeProxyFactory!.proxyRuntimeCodehash!,
  };
}

export function testSnapshot(version = 1, overrides: Partial<Parameters<typeof buildSnapshot>[0]> = {}) {
  return buildSnapshot({
    environment: 'local',
    version,
    platformId: 'mtw',
    deployment: inject('chain').system.contracts,
    deploymentCodehashes: inject('chain').system.codehashes,
    chain: chainContracts(),
    gasTank: { topupMaxWei: '1000000000000000', dailyCapWei: '3000000000000000' },
    ...overrides,
  });
}

/** Escribe el snapshot y su .sig en `dir`; devuelve la ruta del JSON. */
export function writeSignedSnapshot(
  dir: string,
  snapshot: Record<string, unknown>,
  key: TestEdKey,
  name = 'policy-snapshot.json',
): string {
  const path = join(dir, name);
  const bytes = serializeSnapshot(snapshot);
  writeFileSync(path, bytes);
  writeFileSync(`${path}.sig`, signSnapshotBytes(bytes, key.privateKey));
  return path;
}
