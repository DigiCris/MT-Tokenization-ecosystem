// Direcciones fijadas de Base que usa la app (copia propia de config/chains/base-mainnet.json en chain.base.json, con
// test de igualdad byte a byte en test/unit/chain-config.test.ts): tokens USDC/USDT con sus decimales y la Safe
// (singleton L2 y proxy factory). Lo que lea on-chain o informe el backend se compara contra esto (P18: activos).
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import chainFile from './chain.base.json' with { type: 'json' };

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
  safe: {
    singletonL2: Address;
    singletonL2Codehash: Hex;
    proxyFactory: Address;
    proxyCreationCodeHash: Hex;
    proxyRuntimeCodehash: Hex;
  };
  /** Cotización propia de los swaps (P18.T07): QuoterV2 por eth_call sobre el pool del SwapExecutor. */
  uniswap: { quoterV2: Address; pool: { address: Address; fee: number; token0: Address; token1: Address } };
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

function hash32(contracts: Record<string, unknown>, name: string, field: string): Hex {
  const entry = contracts[name];
  const value = isRecord(entry) ? entry[field] : undefined;
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`config de cadena: ${field} inválido para ${name}`);
  }
  return value as Hex;
}

function pool(contracts: Record<string, unknown>): PinnedChain['uniswap']['pool'] {
  const entry = contracts.uniswapV3PoolUsdcUsdt100;
  if (
    !isRecord(entry) ||
    typeof entry.fee !== 'number' ||
    typeof entry.token0 !== 'string' ||
    typeof entry.token1 !== 'string' ||
    !isAddress(entry.token0) ||
    !isAddress(entry.token1)
  ) {
    throw new Error('config de cadena: pool USDC/USDT inválido');
  }
  return {
    address: address(contracts, 'uniswapV3PoolUsdcUsdt100'),
    fee: entry.fee,
    token0: getAddress(entry.token0),
    token1: getAddress(entry.token1),
  };
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
    safe: {
      singletonL2: address(contracts, 'safeL2Singleton'),
      singletonL2Codehash: hash32(contracts, 'safeL2Singleton', 'codehash'),
      proxyFactory: address(contracts, 'safeProxyFactory'),
      proxyCreationCodeHash: hash32(contracts, 'safeProxyFactory', 'proxyCreationCodeHash'),
      proxyRuntimeCodehash: hash32(contracts, 'safeProxyFactory', 'proxyRuntimeCodehash'),
    },
    uniswap: { quoterV2: address(contracts, 'uniswapQuoterV2'), pool: pool(contracts) },
  };
}

export const pinnedChain = parseChain(chainFile);
