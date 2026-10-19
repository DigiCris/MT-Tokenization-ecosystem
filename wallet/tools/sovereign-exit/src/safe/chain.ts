// Lecturas y transmisión por el RPC que indica el usuario (lo único con lo que habla la herramienta): cadena, owners,
// threshold, nonce y saldos de la Safe; envío de execTransaction firmado localmente por la cuenta que paga el gas.
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { bytesToHex } from '../crypto/encoding.ts';
import { TOKENS, type Asset } from './actions.ts';
import { SAFE_ABI } from './safe-tx.ts';

export class ChainError extends Error {
  override name = 'ChainError';
}

export interface SafeState {
  safe: Address;
  owners: Address[];
  threshold: bigint;
  nonce: bigint;
  balances: Record<Asset, bigint>;
}

export function client(rpcUrl: string) {
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ChainError('El RPC tiene que ser http(s).');
  return createPublicClient({ chain: base, transport: http(url.toString(), { timeout: 30_000, retryCount: 1 }) });
}

export async function readSafe(rpcUrl: string, safe: Address): Promise<SafeState> {
  const reader = client(rpcUrl);
  const chainId = await reader.getChainId();
  if (chainId !== 8453) throw new ChainError(`El RPC es de la cadena ${String(chainId)}, no de Base (8453).`);
  const code = await reader.getCode({ address: safe });
  if (code === undefined || code === '0x') throw new ChainError('No hay un contrato en esa dirección de Base.');
  const [owners, threshold, nonce, eth, usdc, usdt] = await Promise.all([
    reader.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }),
    reader.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getThreshold' }),
    reader.readContract({ address: safe, abi: SAFE_ABI, functionName: 'nonce' }),
    reader.getBalance({ address: safe }),
    reader.readContract({ address: TOKENS.USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [safe] }),
    reader.readContract({ address: TOKENS.USDT.address, abi: erc20Abi, functionName: 'balanceOf', args: [safe] }),
  ]);
  return {
    safe: getAddress(safe),
    owners: owners.map((o) => getAddress(o)),
    threshold,
    nonce,
    balances: { ETH: eth, USDC: usdc, USDT: usdt },
  };
}

/** Firma localmente y transmite execTransaction a la Safe con la clave que paga el gas; espera el receipt. */
export async function transmit(
  rpcUrl: string,
  payerKey: Uint8Array,
  tx: { to: Address; data: Hex },
): Promise<{ hash: Hex; status: 'success' | 'reverted'; blockNumber: bigint }> {
  const account = privateKeyToAccount(bytesToHex(payerKey));
  const transport = http(new URL(rpcUrl).toString(), { timeout: 30_000, retryCount: 1 });
  const wallet = createWalletClient({ account, chain: base, transport });
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data });
  const receipt = await client(rpcUrl).waitForTransactionReceipt({ hash, timeout: 180_000 });
  return { hash, status: receipt.status, blockNumber: receipt.blockNumber };
}
