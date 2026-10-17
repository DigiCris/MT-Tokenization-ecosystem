// Rutas y valores de entorno de los tests del signer. El upstream del fork (BASE_RPC_URL) llega del entorno (secret
// de CI) o, en local, de wallet/.env; nunca se imprime.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDotenv } from '../../src/config/dotenv.ts';

export const SIGNER_ROOT = resolve(import.meta.dirname, '../..');
export const WALLET_ROOT = resolve(SIGNER_ROOT, '../..');

let dotenv: Record<string, string> | undefined;

export function walletEnvValue(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const file = resolve(WALLET_ROOT, '.env');
  dotenv ??= existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : {};
  const value = dotenv[name];
  return value === '' ? undefined : value;
}

export function forkUpstreamUrl(): string {
  const value = walletEnvValue('FORK_RPC_URL') ?? walletEnvValue('BASE_RPC_URL');
  if (value === undefined) throw new Error('falta BASE_RPC_URL (o FORK_RPC_URL) para levantar Anvil sobre el fork');
  return value;
}

export function forkBlockNumber(): number {
  const chain = JSON.parse(readFileSync(resolve(WALLET_ROOT, 'config/chains/base-mainnet.json'), 'utf8')) as {
    fork: { blockNumber: number };
  };
  return chain.fork.blockNumber;
}

export interface PinnedImages {
  postgres: string;
}

export function pinnedImages(): PinnedImages {
  return (
    JSON.parse(readFileSync(resolve(WALLET_ROOT, 'scripts/tools/versions.json'), 'utf8')) as { images: PinnedImages }
  ).images;
}
