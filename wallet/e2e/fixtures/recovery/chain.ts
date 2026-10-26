// El fork del stack desde los tests de Recovery: fondeo con USDC/USDT reales del fork (cuentas con saldo suplantadas en
// Anvil), viaje en el tiempo (madurez de 48 h de las rotaciones) y transacciones de cuentas de prueba (el relayer que
// transmite una calldata exportada, la wallet externa que paga el gas).
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { iSafeAbi } from '../../../frontend/recovery/src/chain/abis/ISafe.ts';
import { securityGuardAbi } from '../../../frontend/recovery/src/chain/abis/SecurityGuard.ts';
import { contract, stack } from '../stack.ts';

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
    if ((await receipt(hash)).status !== 'success') throw new Error('fondeo revertido');
  } finally {
    await anvil('anvil_stopImpersonatingAccount', [holder]);
  }
}

/** Una llamada hecha por la propia Safe (suplantada): sólo para preparar estado on-chain, sin pasar por el Guard. */
export async function asSafe(safe: Address, call: { to: Address; data: Hex }): Promise<void> {
  await anvil('anvil_setBalance', [safe, `0x${(10n ** 18n).toString(16)}`]);
  await anvil('anvil_impersonateAccount', [safe]);
  try {
    const hash = await anvil<Hex>('eth_sendTransaction', [{ from: safe, to: call.to, data: call.data }]);
    if ((await receipt(hash)).status !== 'success') throw new Error('llamada de la Safe revertida');
  } finally {
    await anvil('anvil_stopImpersonatingAccount', [safe]);
  }
}

export function tokenBalance(token: Address, owner: Address): Promise<bigint> {
  return chain().readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

/**
 * Adelanta el reloj de la cadena y mina los bloques que la plataforma espera para dar por confirmado un evento
 * (CONFIRMATION_DEPTH, 3 en `.env.example`): en Anvil sólo hay bloques nuevos con transacciones; en Base llegan solos.
 */
export async function increaseTime(seconds: number): Promise<void> {
  await anvil('evm_increaseTime', [seconds]);
  await anvil('anvil_mine', ['0x3']);
}

/** Cuenta nueva con ETH del fork para pagar gas (relayer o wallet externa). */
export async function fundedAccount(key: Hex = generatePrivateKey()): Promise<PrivateKeyAccount> {
  const account = privateKeyToAccount(key);
  await anvil('anvil_setBalance', [account.address, `0x${(10n ** 18n).toString(16)}`]);
  return account;
}

/** Transmite una transacción firmada por una cuenta de prueba (el relayer de una calldata exportada). */
export async function relay(account: PrivateKeyAccount, tx: { to: Address; data: Hex }): Promise<TransactionReceipt> {
  const wallet = createWalletClient({ account, chain: base, transport: http(stack().urls.anvil) });
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, gas: 2_000_000n });
  return receipt(hash);
}

/** Owners de la Safe y roles del Guard del sistema, leídos del fork. */
export async function safeState(safe: Address): Promise<{
  owners: Address[];
  roles: { userKey: Address; recoveryKey: Address; executor: Address };
  nonce: bigint;
}> {
  const [owners, roles, nonce] = await Promise.all([
    chain().readContract({ address: safe, abi: iSafeAbi, functionName: 'getOwners' }),
    chain().readContract({
      address: contract('SecurityGuard'),
      abi: securityGuardAbi,
      functionName: 'rolesOf',
      args: [safe],
    }),
    chain().readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce' }),
  ]);
  return {
    owners: owners.map((o) => getAddress(o)),
    roles: {
      userKey: getAddress(roles.userKey),
      recoveryKey: getAddress(roles.recoveryKey),
      executor: getAddress(roles.executor),
    },
    nonce,
  };
}
