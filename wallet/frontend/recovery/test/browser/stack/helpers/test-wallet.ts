// Wallet externa de prueba para Playwright (P19.TST, [F-CON]): un provider EIP-1193 anunciado por EIP-6963 —como lo
// inyecta una extensión, antes de los scripts de la página— que reenvía cada request a Node (page.exposeFunction).
// Node firma con una clave de prueba (eth_signTypedData_v4), transmite por el Anvil del stack (eth_sendTransaction) y
// reenvía las lecturas al fork. Sólo existe en los tests: la app no sabe que no es una extensión real.
import type { Page } from '@playwright/test';
import { createWalletClient, http, type Hex, type TypedDataDefinition } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { anvil } from './chain.ts';
import { stack } from './stack.ts';

export interface TestWalletOptions {
  /** Cómo se presenta: EIP-6963 genérica, MetaMask o Coinbase Wallet (flags y rdns de cada extensión). */
  flavor?: 'generic' | 'metamask' | 'coinbase';
  /** Métodos pedidos por la app (para verificar que nunca use eth_sign/personal_sign). */
  log?: string[];
}

/** Los uint/int del typed data llegan como texto en el JSON de `eth_signTypedData_v4`: viem los firma como bigint. */
function normalize(
  types: Record<string, readonly { name: string; type: string }[]>,
  type: string,
  value: unknown,
): unknown {
  const array = /^(.*)\[\d*\]$/.exec(type);
  if (array?.[1] && Array.isArray(value)) return value.map((v) => normalize(types, array[1] ?? '', v));
  if (/^u?int\d*$/.test(type) && (typeof value === 'string' || typeof value === 'number')) return BigInt(value);
  const fields = types[type];
  if (fields && typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(fields.map((f) => [f.name, normalize(types, f.type, record[f.name])]));
  }
  return value;
}

const INFO = {
  generic: { name: 'MTW Test Wallet', rdns: 'test.mtw.wallet' },
  metamask: { name: 'MetaMask', rdns: 'io.metamask' },
  coinbase: { name: 'Coinbase Wallet', rdns: 'com.coinbase.wallet' },
} as const;

export async function installTestWallet(page: Page, account: PrivateKeyAccount, options: TestWalletOptions = {}) {
  const flavor = options.flavor ?? 'generic';
  const wallet = createWalletClient({ account, chain: base, transport: http(stack().urls.anvil) });
  await page.exposeFunction('__mtwTestWallet', async (raw: string): Promise<string> => {
    const { method, params = [] } = JSON.parse(raw) as { method: string; params?: unknown[] };
    options.log?.push(method);
    try {
      let result: unknown;
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          result = [account.address];
          break;
        case 'eth_chainId':
          result = '0x2105';
          break;
        case 'net_version':
          result = '8453';
          break;
        case 'wallet_switchEthereumChain':
        case 'wallet_requestPermissions':
          result = null;
          break;
        case 'wallet_getPermissions':
          result = [{ parentCapability: 'eth_accounts' }];
          break;
        case 'eth_signTypedData_v4': {
          const typed = JSON.parse(String(params[1])) as {
            domain: Record<string, unknown>;
            types: Record<string, { name: string; type: string }[]>;
            primaryType: string;
            message: Record<string, unknown>;
          };
          const { EIP712Domain: _domain, ...types } = typed.types;
          result = await account.signTypedData({
            domain: normalize(typed.types, 'EIP712Domain', typed.domain),
            types,
            primaryType: typed.primaryType,
            message: normalize(types, typed.primaryType, typed.message),
          } as unknown as TypedDataDefinition);
          break;
        }
        case 'eth_sendTransaction': {
          const [tx] = params as [{ to: Hex; data?: Hex; gas?: Hex; value?: Hex }];
          await anvil('anvil_setBalance', [account.address, `0x${(10n ** 18n).toString(16)}`]);
          result = await wallet.sendTransaction({
            to: tx.to,
            data: tx.data ?? '0x',
            value: tx.value === undefined ? 0n : BigInt(tx.value),
            ...(tx.gas === undefined ? {} : { gas: BigInt(tx.gas) }),
          });
          break;
        }
        case 'eth_sign':
        case 'personal_sign':
          throw Object.assign(new Error(`${method} no está permitido en Recovery`), { code: 4200 });
        default:
          result = await anvil(method, params);
      }
      return JSON.stringify({ result });
    } catch (error) {
      const { message, code } = error as { message?: string; code?: number };
      return JSON.stringify({ error: { message: message ?? String(error), code: code ?? -32603 } });
    }
  });
  await page.addInitScript(
    ({ info, flavor: kind }) => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const bridge = (window as unknown as { __mtwTestWallet: (raw: string) => Promise<string> }).__mtwTestWallet;
      const provider = {
        isMetaMask: kind === 'metamask',
        isCoinbaseWallet: kind === 'coinbase',
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const reply = JSON.parse(await bridge(JSON.stringify({ method, params }))) as {
            result?: unknown;
            error?: { message: string; code: number };
          };
          if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
          return reply.result;
        },
        on(event: string, listener: (...args: unknown[]) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(listener);
          return provider;
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener);
          return provider;
        },
      };
      const detail = Object.freeze({
        info: Object.freeze({
          uuid: crypto.randomUUID(),
          name: info.name,
          rdns: info.rdns,
          icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/%3E',
        }),
        provider,
      });
      const announce = () => {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
      };
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
      Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });
      if (kind === 'coinbase') {
        Object.defineProperty(window, 'coinbaseWalletExtension', { value: provider, configurable: true });
      }
    },
    { info: INFO[flavor], flavor },
  );
}
