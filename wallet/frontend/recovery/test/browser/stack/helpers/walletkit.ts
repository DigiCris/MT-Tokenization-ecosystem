// Wallet headless de WalletConnect para el test live (P19.MAN): @reown/walletkit (versión fijada) en Node, conectada al
// relay real de Reown con WALLETCONNECT_PROJECT_ID. Aprueba la sesión en Base con una cuenta de prueba, firma typed data
// (eth_signTypedData_v4) y transmite transacciones por el Anvil del stack; rechaza eth_sign y personal_sign.
import { resolve } from 'node:path';
import { WalletKit } from '@reown/walletkit';
import { Core } from '@walletconnect/core';
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils';
import { createWalletClient, http, type Hex, type TypedDataDefinition } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { WALLET_ROOT } from '../../../../build/config.ts';
import { readEnvFile } from '../../../../build/env-file.ts';
import { anvil } from './chain.ts';
import { stack } from './stack.ts';

type CoreStorage = NonNullable<NonNullable<ConstructorParameters<typeof Core>[0]>['storage']>;

/** Storage en memoria (sin archivos en el disco del runner). */
function memoryStorage(): CoreStorage {
  const items = new Map<string, unknown>();
  const storage = {
    getKeys: () => Promise.resolve([...items.keys()]),
    getEntries: () => Promise.resolve([...items.entries()]),
    getItem: (key: string) => Promise.resolve(items.get(key)),
    setItem: (key: string, value: unknown) => {
      items.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      items.delete(key);
      return Promise.resolve();
    },
  };
  // Los métodos genéricos de IKeyValueStorage (getItem<T>) devuelven lo que se guardó: el mismo contrato.
  return storage as unknown as CoreStorage;
}

export function walletConnectProjectId(): string {
  const value =
    process.env.WALLETCONNECT_PROJECT_ID || (readEnvFile(resolve(WALLET_ROOT, '.env')) ?? {}).WALLETCONNECT_PROJECT_ID;
  if (!value)
    throw new Error('falta WALLETCONNECT_PROJECT_ID (test live obligatorio, docs/SETUP_EXTERNAL_SERVICES.md)');
  return value;
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

export interface HeadlessWallet {
  pair: (uri: string) => Promise<void>;
  log: string[];
  close: () => Promise<void>;
}

export async function headlessWallet(account: PrivateKeyAccount): Promise<HeadlessWallet> {
  const core = new Core({ projectId: walletConnectProjectId(), storage: memoryStorage() });
  const kit = await WalletKit.init({
    // Core 2.25 de la misma versión que pide walletkit; sus tipos opcionales chocan con exactOptionalPropertyTypes.
    core: core as unknown as Parameters<typeof WalletKit.init>[0]['core'],
    metadata: {
      name: 'MTW Test WalletKit',
      description: 'Wallet headless de los tests de Recovery',
      url: 'https://wallet.mtw-browser.test',
      icons: [],
    },
  });
  const log: string[] = [];
  const wallet = createWalletClient({ account, chain: base, transport: http(stack().urls.anvil) });

  kit.on('session_proposal', (proposal) => {
    void (async () => {
      try {
        const namespaces = buildApprovedNamespaces({
          proposal: proposal.params,
          supportedNamespaces: {
            eip155: {
              chains: ['eip155:8453'],
              methods: [
                'eth_signTypedData_v4',
                'eth_sendTransaction',
                'eth_accounts',
                'eth_requestAccounts',
                'eth_chainId',
                'wallet_switchEthereumChain',
                'personal_sign',
                'eth_sign',
              ],
              events: ['accountsChanged', 'chainChanged'],
              accounts: [`eip155:8453:${account.address}`],
            },
          },
        });
        await kit.approveSession({ id: proposal.id, namespaces });
      } catch {
        await kit.rejectSession({ id: proposal.id, reason: getSdkError('UNSUPPORTED_CHAINS') });
      }
    })();
  });

  kit.on('session_request', (event) => {
    void (async () => {
      const { topic, id, params } = event;
      const { method, params: args } = params.request as { method: string; params: unknown[] };
      log.push(method);
      try {
        let result: unknown;
        if (method === 'eth_signTypedData_v4') {
          const typed = JSON.parse(String(args[1])) as {
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
        } else if (method === 'eth_sendTransaction') {
          const [tx] = args as [{ to: Hex; data?: Hex; gas?: Hex }];
          await anvil('anvil_setBalance', [account.address, `0x${(10n ** 18n).toString(16)}`]);
          result = await wallet.sendTransaction({
            to: tx.to,
            data: tx.data ?? '0x',
            ...(tx.gas === undefined ? {} : { gas: BigInt(tx.gas) }),
          });
        } else if (method === 'eth_chainId') {
          result = '0x2105';
        } else if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
          result = [account.address];
        } else {
          throw new Error(`${method} no está permitido en Recovery`);
        }
        await kit.respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', result } });
      } catch (error) {
        await kit.respondSessionRequest({
          topic,
          response: {
            id,
            jsonrpc: '2.0',
            error: { code: 5000, message: error instanceof Error ? error.message : String(error) },
          },
        });
      }
    })();
  });

  return {
    log,
    pair: async (uri) => {
      await kit.pair({ uri });
    },
    close: async () => {
      for (const session of Object.values(kit.getActiveSessions())) {
        await kit
          .disconnectSession({ topic: session.topic, reason: getSdkError('USER_DISCONNECTED') })
          .catch(() => undefined);
      }
      await core.relayer.transportClose().catch(() => undefined);
    },
  };
}
