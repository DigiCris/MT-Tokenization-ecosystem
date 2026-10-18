// Activos (P18.T03/T04): USDC y USDT leídos por el RPC propio (saldo, símbolo y decimales) y comparados con lo fijado
// en el build: si el símbolo o los decimales on-chain difieren de la config, error bloqueante (la app no opera con ese
// token). El saldo que informa el backend se cruza con el propio; si difiere se avisa, y manda el de la cadena.
import { erc20Abi, type Address } from 'viem';
import type { Balances, TokenSymbol } from '../api/wallet-api.ts';
import type { BaseClient } from '../chain/client.ts';
import type { PinnedChain, PinnedToken } from '../config/chain.ts';

export interface AssetView {
  symbol: TokenSymbol;
  address: Address;
  decimals: number;
  balance: bigint;
  /** Saldo según el backend (null si no se pudo leer). */
  backendBalance: bigint | null;
  /** El backend informa otro saldo que la cadena. */
  backendMismatch: boolean;
}

export class TokenConfigError extends Error {
  override name = 'TokenConfigError';
}

export type TokenReader = Pick<BaseClient, 'readContract'>;

async function readToken(reader: TokenReader, token: PinnedToken, safe: Address) {
  const [symbol, decimals, balance] = await Promise.all([
    reader.readContract({ address: token.address, abi: erc20Abi, functionName: 'symbol' }),
    reader.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' }),
    reader.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [safe] }),
  ]);
  if (symbol !== token.symbol || decimals !== token.decimals) {
    throw new TokenConfigError(
      `El contrato ${token.address} informa ${symbol} con ${String(decimals)} decimales y esta app lo tiene fijado como ` +
        `${token.symbol} con ${String(token.decimals)}: no se opera con ese token.`,
    );
  }
  return balance;
}

export async function readAssets(
  reader: TokenReader,
  chain: Pick<PinnedChain, 'tokens'>,
  safe: Address,
  backend: Balances | null,
): Promise<AssetView[]> {
  const entries = [
    ['USDC', chain.tokens.usdc],
    ['USDT', chain.tokens.usdt],
  ] as const;
  return Promise.all(
    entries.map(async ([symbol, token]) => {
      const balance = await readToken(reader, token, safe);
      const reported = backend?.tokens.find((t) => t.symbol === symbol);
      const backendBalance = reported === undefined ? null : BigInt(reported.balance);
      return {
        symbol,
        address: token.address,
        decimals: token.decimals,
        balance,
        backendBalance,
        backendMismatch: backendBalance !== null && backendBalance !== balance,
      };
    }),
  );
}
