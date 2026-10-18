// El fork del stack desde los tests: fondeo de la Safe con USDC/USDT reales del fork (cuentas con saldo suplantadas en
// Anvil), viaje en el tiempo para la activación de destinos (24 h) y la madurez de rotaciones (48 h), y ejecución
// soberana U + R por un relayer cualquiera (sin el backend ni el signer), como la transmitiría la app Recovery.
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { iSafeAbi } from '../../../../src/chain/abis/ISafe.ts';
import { assistedCall, safeTxHash } from '../../../../src/chain/safe-tx.ts';
import { signDigest } from '../../../../src/crypto/sign.ts';
import { fromHex } from '../../../../src/crypto/bytes.ts';
import { stack } from './stack.ts';

/** Cuentas del fork con saldo de USDC y USDT (las mismas que usan los tests del backend). */
export const USDC_HOLDER: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
export const USDT_HOLDER: Address = '0x0D0707963952f2fBA59dD06f2b425ace40b492Fe';
export const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDT: Address = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';

export function chain() {
  return createPublicClient({ chain: base, transport: http(stack().urls.anvil) });
}

export async function anvil<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(stack().urls.anvil, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Receipt consultado directamente (el Anvil del stack mina cada 2 s). */
export async function receipt(hash: Hex, timeoutMs = 120_000): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await chain()
      .getTransactionReceipt({ hash })
      .catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`sin receipt de ${hash}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Transfiere tokens reales del fork desde una cuenta con saldo, suplantada en Anvil. */
export async function fund(token: Address, holder: Address, to: Address, amount: bigint): Promise<void> {
  await anvil('anvil_setBalance', [holder, `0x${(10n ** 19n).toString(16)}`]);
  await anvil('anvil_impersonateAccount', [holder]);
  try {
    const hash = await anvil<Hex>('eth_sendTransaction', [
      {
        from: holder,
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
      },
    ]);
    const mined = await receipt(hash);
    if (mined.status !== 'success') throw new Error('fondeo revertido');
  } finally {
    await anvil('anvil_stopImpersonatingAccount', [holder]);
  }
}

export function tokenBalance(token: Address, owner: Address): Promise<bigint> {
  return chain().readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

/** Adelanta el reloj de la cadena y mina un bloque con el timestamp nuevo. */
export async function increaseTime(seconds: number): Promise<void> {
  await anvil('evm_increaseTime', [seconds]);
  await anvil('evm_mine', []);
}

/** Ejecución soberana U + R de una llamada de la Safe, transmitida por un relayer cualquiera (paga el gas). */
export interface OwnerSigner {
  address: Address;
  sign: (hash: Hex) => Hex | Promise<Hex>;
}

/** U con su clave en bytes (la que la app descifra para firmar). */
export function userSigner(address: Address, key: Uint8Array): OwnerSigner {
  return { address, sign: (hash) => signDigest(fromHex(hash), key) };
}

/** R como cuenta de viem (la que tendría la app Recovery). */
export function accountSigner(account: PrivateKeyAccount): OwnerSigner {
  return { address: account.address, sign: (hash) => account.sign({ hash }) };
}

export async function execSovereign(
  safe: Address,
  call: { to: Address; data: Hex },
  owners: OwnerSigner[],
  relayer: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey()),
): Promise<TransactionReceipt> {
  const nonce = await chain().readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce' });
  const tx = assistedCall(call.to, call.data, nonce);
  const hash = safeTxHash(8453, safe, tx);
  const signatures = (
    await Promise.all(owners.map(async (o) => ({ address: o.address, signature: await o.sign(hash) })))
  ).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  await anvil('anvil_setBalance', [relayer.address, `0x${(10n ** 18n).toString(16)}`]);
  const wallet = createWalletClient({ account: relayer, chain: base, transport: http(stack().urls.anvil) });
  const txHash = await wallet.writeContract({
    address: safe,
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args: [
      tx.to,
      0n,
      tx.data,
      0,
      0n,
      0n,
      0n,
      tx.gasToken,
      tx.refundReceiver,
      concat(signatures.map((s) => s.signature)),
    ],
    gas: 1_500_000n,
  });
  return receipt(txHash);
}
