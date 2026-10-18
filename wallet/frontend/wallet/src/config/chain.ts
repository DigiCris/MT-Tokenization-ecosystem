// Direcciones fijadas de Base que usa la app (copia propia de config/chains/base-mainnet.json en chain.base.json, con
// test de igualdad byte a byte en test/unit/chain-config.test.ts): tokens USDC/USDT con sus decimales y la Safe
// (singleton L2 y proxy factory). Lo que lea on-chain o informe el backend se compara contra esto (P18: activos).
import { getAddress, isAddress, type Address } from 'viem';
import chainFile from './chain.base.json';

export interface PinnedToken {
  address: Address;
  symbol: string;
  decimals: number;
  codehash: `0x${string}`;
}

export interface PinnedChain {
  chainId: 8453;
  explorer: { address: string; token: string; tx: string };
  tokens: { usdc: PinnedToken; usdt: PinnedToken };
  safe: { singletonL2: Address; proxyFactory: Address };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function address(contracts: Record<string, unknown>, name: string): Address {
  const entry = contracts[name];
  if (!isRecord(entry) || typeof entry.address !== 'string' || !isAddress(entry.address)) {
    throw new Error(`config de cadena: dirección inválida para ${name}`);
  }
  return getAddress(entry.address);
}

function token(contracts: Record<string, unknown>, name: 'usdc' | 'usdt'): PinnedToken {
  const entry = contracts[name];
  if (
    !isRecord(entry) ||
    typeof entry.symbol !== 'string' ||
    typeof entry.decimals !== 'number' ||
    typeof entry.codehash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(entry.codehash)
  ) {
    throw new Error(`config de cadena: token ${name} inválido`);
  }
  return {
    address: address(contracts, name),
    symbol: entry.symbol,
    decimals: entry.decimals,
    codehash: entry.codehash as `0x${string}`,
  };
}

export function parseChain(value: unknown): PinnedChain {
  if (!isRecord(value) || value.chainId !== 8453 || value.network !== 'base-mainnet') {
    throw new Error('config de cadena: no es Base mainnet (8453)');
  }
  const { explorer, contracts } = value;
  if (
    !isRecord(explorer) ||
    typeof explorer.address !== 'string' ||
    typeof explorer.token !== 'string' ||
    typeof explorer.tx !== 'string'
  ) {
    throw new Error('config de cadena: explorer inválido');
  }
  if (!isRecord(contracts)) throw new Error('config de cadena: faltan los contratos');
  return {
    chainId: 8453,
    explorer: { address: explorer.address, token: explorer.token, tx: explorer.tx },
    tokens: { usdc: token(contracts, 'usdc'), usdt: token(contracts, 'usdt') },
    safe: { singletonL2: address(contracts, 'safeL2Singleton'), proxyFactory: address(contracts, 'safeProxyFactory') },
  };
}

export const pinnedChain = parseChain(chainFile);
