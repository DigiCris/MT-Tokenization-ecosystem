// Chunk lazy de wallet externa de Recovery ([F-KEY-09], [F-CON-01], [F-SEC-07]): el único módulo que importa wagmi y
// los conectores; se carga sólo con src/external-wallet/load.ts. Cadena fija Base (8453; en local, el fork por el RPC
// propio). Cada conector carga su SDK con su propio import() recién al usarse.
import { coinbaseWallet, metaMask, walletConnect } from '@wagmi/connectors';
import { createConfig, http, injected, type Config } from '@wagmi/core';
import { base } from 'viem/chains';

export interface ExternalWalletOptions {
  rpcUrl: string;
  walletConnectProjectId: string | null;
  /** Origin de Recovery: metadata que las wallets muestran al conectar. */
  appUrl: string;
}

const APP_NAME = 'MT Recovery';

/**
 * Configuración completa para conectar R externa: EIP-6963 (MetaMask, Coinbase Wallet extension, Rabby…), MetaMask,
 * Coinbase Wallet sólo EOA y WalletConnect sin modal (QR propio desde `display_uri`). Sin persistencia de la conexión.
 */
export function createExternalWalletConfig(options: ExternalWalletOptions): Config {
  return createConfig({
    chains: [base],
    multiInjectedProviderDiscovery: true,
    storage: null,
    connectors: [
      injected(),
      metaMask({ dapp: { name: APP_NAME, url: options.appUrl } }),
      coinbaseWallet({ appName: APP_NAME, preference: { options: 'eoaOnly' } }),
      ...(options.walletConnectProjectId === null
        ? []
        : [
            walletConnect({
              projectId: options.walletConnectProjectId,
              showQrModal: false,
              metadata: {
                name: APP_NAME,
                description: 'Clave de recuperación de MT Wallet',
                url: options.appUrl,
                icons: [],
              },
            }),
          ]),
    ],
    transports: { [base.id]: http(options.rpcUrl) },
  });
}

/**
 * Wallets del navegador anunciadas por EIP-6963, sin conectar ni pedir permisos: una configuración sin conectores
 * propios (no inicializa ningún SDK ni abre conexiones) espera los anuncios y devuelve los encontrados.
 */
export async function discoverInjectedWallets(
  options: Pick<ExternalWalletOptions, 'rpcUrl'>,
  waitMs = 400,
): Promise<{ id: string; name: string }[]> {
  // Tipada como Config: sin conectores propios, los anunciados por EIP-6963 se agregan en tiempo de ejecución.
  const config: Config = createConfig({
    chains: [base],
    multiInjectedProviderDiscovery: true,
    storage: null,
    connectors: [],
    transports: { [base.id]: http(options.rpcUrl) },
  });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return config.connectors.map((connector) => ({ id: connector.id, name: connector.name }));
}
