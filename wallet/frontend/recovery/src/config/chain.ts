// Direcciones fijadas de Base que usa Recovery (copia propia de config/chains/base-mainnet.json en chain.base.json,
// verificada byte a byte por test/unit/chain-config.test.ts): USDC y USDT (dirección, símbolo y decimales), Safe v1.5.0
// (SafeL2 y proxy: direcciones y codehash, para verificar la Safe por el RPC propio) y el explorer para los links.
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import chainFile from './chain.base.json' with { type: 'json' };

export interface PinnedToken {
  symbol: 'USDC' | 'USDT';
  address: Address;
  decimals: number;
}

export interface PinnedChain {
  chainId: 8453;
  explorer: { address: string; tx: string };
  tokens: { USDC: PinnedToken; USDT: PinnedToken };
  safe: { singletonL2: Address; singletonL2Codehash: Hex; proxyFactory: Address; proxyRuntimeCodehash: Hex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entry(contracts: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = contracts[name];
  if (!isRecord(value)) throw new Error(`config de cadena: falta ${name}`);
  return value;
}

function address(record: Record<string, unknown>, name: string): Address {
  const value = record.address;
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`config de cadena: dirección inválida (${name})`);
  return getAddress(value);
}

function hash(record: Record<string, unknown>, field: string, name: string): Hex {
  const value = record[field];
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value))
    throw new Error(`config de cadena: ${field} de ${name}`);
  return value as Hex;
}

function token(contracts: Record<string, unknown>, name: 'usdc' | 'usdt', symbol: 'USDC' | 'USDT'): PinnedToken {
  const record = entry(contracts, name);
  if (record.symbol !== symbol || record.decimals !== 6)
    throw new Error(`config de cadena: ${symbol} no es de 6 decimales`);
  return { symbol, address: address(record, name), decimals: 6 };
}

export function parseChain(value: unknown): PinnedChain {
  if (!isRecord(value) || value.chainId !== 8453 || value.network !== 'base-mainnet') {
    throw new Error('config de cadena: no es Base mainnet (8453)');
  }
  const { explorer, contracts } = value;
  if (!isRecord(explorer) || typeof explorer.address !== 'string' || typeof explorer.tx !== 'string') {
    throw new Error('config de cadena: explorer inválido');
  }
  if (!isRecord(contracts)) throw new Error('config de cadena: faltan los contratos');
  const singleton = entry(contracts, 'safeL2Singleton');
  const factory = entry(contracts, 'safeProxyFactory');
  return {
    chainId: 8453,
    explorer: { address: explorer.address, tx: explorer.tx },
    tokens: { USDC: token(contracts, 'usdc', 'USDC'), USDT: token(contracts, 'usdt', 'USDT') },
    safe: {
      singletonL2: address(singleton, 'safeL2Singleton'),
      singletonL2Codehash: hash(singleton, 'codehash', 'safeL2Singleton'),
      proxyFactory: address(factory, 'safeProxyFactory'),
      proxyRuntimeCodehash: hash(factory, 'proxyRuntimeCodehash', 'safeProxyFactory'),
    },
  };
}

export const pinnedChain = parseChain(chainFile);

export function explorerTx(txHash: string): string {
  return `${pinnedChain.explorer.tx}${txHash}`;
}

export function explorerAddress(value: string): string {
  return `${pinnedChain.explorer.address}${value}`;
}
