// Operaciones on-chain de los tests sobre un Anvil propio con el sistema desplegado: Safes creadas por la
// WalletFactory real, fondeo con USDC/USDT reales del fork (holders impersonados, como SeedLocal), firmas U/R de
// SafeTx y ejecuciones soberanas U+R (el Guard no aplica política en ese camino: sirve para preparar estado).
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  HttpRequestError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  type Hex as ViemHex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { setTimeout as sleep } from 'node:timers/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { bytesToHex, type Hex } from '../../src/crypto/bytes.ts';
import { checksumAddress, type Address } from '../../src/crypto/keccak.ts';
import { generatePrivateKey, privateKeyToAddress, signDigest } from '../../src/crypto/secp256k1.ts';
import { iSafeAbi, walletFactoryAbi } from '../../src/chain/abis/index.ts';
import { execTransactionData, packSignatures } from '../../src/chain/exec-tx.ts';
import { safeTxHash, type SafeTx } from '../../src/chain/safe-tx.ts';
import type { AnvilInstance } from './anvil.ts';

/**
 * Espera el receipt de una tx consultando `eth_getTransactionReceipt` cada 250 ms. No usa `waitForTransactionReceipt` de
 * viem: con Anvil bajo carga en CI, su watcher de bloques llegó a no volver a pedir el receipt de una tx ya minada. Una
 * consulta que vence o falla por HTTP mientras Anvil trae estado del fork se reintenta dentro del plazo total.
 */
async function waitForReceipt(
  client: Pick<PublicClient, 'getTransactionReceipt'>,
  hash: ViemHex,
  timeoutMs = 180_000,
): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await client.getTransactionReceipt({ hash }).catch((error: unknown) => {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      if (error instanceof TimeoutError || error instanceof HttpRequestError) return null;
      throw error;
    });
    if (receipt) return receipt;
    if (Date.now() > deadline) throw new Error(`sin receipt de ${hash} en ${String(timeoutMs)} ms`);
    await sleep(250);
  }
}

export const USDC_HOLDER = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;
export const USDT_HOLDER = '0x0D0707963952f2fBA59dD06f2b425ace40b492Fe' as Address;
export const ZERO = '0x0000000000000000000000000000000000000000' as Address;

export interface TestAccount {
  key: Uint8Array;
  address: Address;
}

export function testAccount(): TestAccount {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAddress(key) };
}

export function safeTx(to: Address, data: Hex, nonce: bigint): SafeTx {
  return {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce,
  };
}

/** JSON de una SafeTx para la API del signer (uint256 como string decimal). */
export function safeTxJson(tx: SafeTx): Record<string, unknown> {
  return {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: tx.nonce.toString(),
  };
}

export class TestChain {
  readonly anvil: AnvilInstance;
  readonly public;
  readonly relayer: TestAccount;

  constructor(anvil: AnvilInstance) {
    this.anvil = anvil;
    this.public = createPublicClient({ chain: base, transport: http(anvil.url) });
    this.relayer = testAccount();
  }

  async init(): Promise<this> {
    await this.setBalance(this.relayer.address, 10n ** 20n);
    return this;
  }

  async setBalance(address: Address, wei: bigint): Promise<void> {
    await this.anvil.rpc('anvil_setBalance', [address, `0x${wei.toString(16)}`]);
  }

  async send(account: TestAccount, tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint }): Promise<ViemHex> {
    const wallet = createWalletClient({
      account: privateKeyToAccount(bytesToHex(account.key)),
      chain: base,
      transport: http(this.anvil.url),
    });
    const hash = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data ?? '0x',
      value: tx.value ?? 0n,
      ...(tx.gas === undefined ? {} : { gas: tx.gas }),
    });
    const receipt = await waitForReceipt(this.public, hash);
    if (receipt.status !== 'success') throw new Error(`tx revertida: ${hash}`);
    return hash;
  }

  async sendRaw(raw: Hex): Promise<{ hash: ViemHex; status: 'success' | 'reverted'; gasUsed: bigint }> {
    const hash = await this.public.sendRawTransaction({ serializedTransaction: raw });
    const receipt = await waitForReceipt(this.public, hash);
    return { hash, status: receipt.status, gasUsed: receipt.gasUsed };
  }

  async impersonate(from: Address, tx: { to: Address; data: Hex }): Promise<void> {
    await this.setBalance(from, 10n ** 19n);
    await this.anvil.rpc('anvil_impersonateAccount', [from]);
    try {
      const hash = await this.anvil.rpc<ViemHex>('eth_sendTransaction', [{ from, to: tx.to, data: tx.data }]);
      const receipt = await waitForReceipt(this.public, hash);
      if (receipt.status !== 'success') throw new Error('tx impersonada revertida');
    } finally {
      await this.anvil.rpc('anvil_stopImpersonatingAccount', [from]);
    }
  }

  async createSafe(
    factory: Address,
    keys: { userKey: Address; recoveryKey: Address; executor: Address },
    salt = 0n,
  ): Promise<Address> {
    const args = [keys.userKey, keys.recoveryKey, keys.executor, salt] as const;
    const predicted = await this.public.readContract({
      address: factory,
      abi: walletFactoryAbi,
      functionName: 'predictWalletAddress',
      args,
    });
    await this.send(this.relayer, {
      to: factory,
      data: encodeFunctionData({ abi: walletFactoryAbi, functionName: 'createWallet', args }),
    });
    return checksumAddress(predicted);
  }

  async fundToken(token: Address, holder: Address, to: Address, amount: bigint): Promise<void> {
    const data = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'transfer',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
        },
      ] as const,
      functionName: 'transfer',
      args: [to, amount],
    });
    await this.impersonate(holder, { to: token, data });
  }

  async tokenBalance(token: Address, owner: Address): Promise<bigint> {
    return await this.public.readContract({
      address: token,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'a', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'balanceOf',
      args: [owner],
    });
  }

  async safeNonce(safe: Address): Promise<bigint> {
    return await this.public.readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce' });
  }

  async accountNonce(address: Address): Promise<bigint> {
    return BigInt(await this.public.getTransactionCount({ address, blockTag: 'latest' }));
  }

  /** Ejecución soberana U+R (sin S): el Guard la deja pasar sin política; la transmite el relayer. */
  async execSovereign(safe: Address, tx: SafeTx, owners: TestAccount[]): Promise<void> {
    const hash = safeTxHash(8453, safe, tx);
    const signatures = packSignatures(
      owners.map((o) => ({ signer: o.address, signature: signDigest(hash, o.key).bytes })),
    );
    await this.send(this.relayer, { to: safe, data: execTransactionData(tx, signatures), gas: 1_500_000n });
  }

  async increaseTime(seconds: number): Promise<void> {
    await this.anvil.rpc('evm_increaseTime', [seconds]);
    await this.anvil.rpc('evm_mine', []);
  }

  async now(): Promise<number> {
    return Number((await this.public.getBlock()).timestamp);
  }
}

export function signSafeTxAs(account: TestAccount, safe: Address, tx: SafeTx): { hash: Hex; signature: Hex } {
  const hash = safeTxHash(8453, safe, tx);
  return { hash: bytesToHex(hash), signature: signDigest(hash, account.key).bytes };
}
