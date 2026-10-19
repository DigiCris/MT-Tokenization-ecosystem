// Chunk lazy de wallet externa de Recovery ([F-KEY-09], [F-CON-01], [F-SEC-07]): el único módulo que importa wagmi y
// los conectores; se carga sólo con src/external-wallet/load.ts. Cadena fija Base (8453; en local, el fork por el RPC
// propio). Cada conector carga su SDK con su propio import() recién al usarse. Conectores y exclusiones (P19.T07):
// docs/CONNECTORS.md.
import { coinbaseWallet, walletConnect } from '@wagmi/connectors';
import {
  connect,
  createConfig,
  disconnect,
  getConnection,
  http,
  injected,
  sendTransaction,
  signTypedData,
  switchChain,
  type Config,
  type Connector,
} from '@wagmi/core';
import { recoverTypedDataAddress } from 'viem';
import { base } from 'viem/chains';
import type { ConnectorChoice, ExternalSession } from './types.ts';

export type { ConnectorChoice, ExternalSession } from './types.ts';

export interface ExternalWalletOptions {
  rpcUrl: string;
  walletConnectProjectId: string | null;
  /** Origin de Recovery: metadata que las wallets muestran al conectar. */
  appUrl: string;
}

const APP_NAME = 'MT Recovery';

export const WALLET_CONNECT_ID = 'walletConnect';

/** Coinbase Wallet por su SDK sólo con la extensión: sin ella abre un popup que la COOP de Recovery corta. */
function coinbaseExtensionInstalled(): boolean {
  return (window as { coinbaseWalletExtension?: unknown }).coinbaseWalletExtension !== undefined;
}

/**
 * Conectores del navegador: EIP-6963 (una por extensión anunciada: MetaMask, Coinbase Wallet, Rabby…), `injected` y
 * Coinbase Wallet sólo EOA si su extensión está instalada. Sin persistencia de la conexión. WalletConnect va en su propia
 * configuración (walletConnectConfig) para no inicializar su SDK ni abrir el relay hasta que el usuario lo elige.
 */
export function createExternalWalletConfig(options: ExternalWalletOptions): Config {
  return createConfig({
    chains: [base],
    multiInjectedProviderDiscovery: true,
    storage: null,
    connectors: [
      injected(),
      ...(coinbaseExtensionInstalled()
        ? [coinbaseWallet({ appName: APP_NAME, preference: { options: 'eoaOnly' } })]
        : []),
    ],
    transports: { [base.id]: http(options.rpcUrl) },
  });
}

let walletConnect_: { key: string; config: Config } | null = null;

/**
 * WalletConnect sin modal (QR propio desde `display_uri`), sin telemetría: sólo cuando el usuario lo elige, y una sola
 * configuración por página. Un segundo provider en la misma página inicializaría otro core de WalletConnect sobre el
 * mismo almacenamiento y relay, y los dos se pisarían las sesiones.
 */
function walletConnectConfig(options: ExternalWalletOptions & { walletConnectProjectId: string }): Config {
  const key = `${options.walletConnectProjectId}|${options.rpcUrl}|${options.appUrl}`;
  if (walletConnect_?.key === key) return walletConnect_.config;
  const config = createConfig({
    chains: [base],
    multiInjectedProviderDiscovery: false,
    storage: null,
    connectors: [
      walletConnect({
        projectId: options.walletConnectProjectId,
        showQrModal: false,
        // Sin la telemetría de Reown (pulse.walletconnect.org): Recovery no habla con terceros que no necesita.
        telemetryEnabled: false,
        metadata: {
          name: APP_NAME,
          description: 'Clave de recuperación de MT Wallet',
          url: options.appUrl,
          icons: [],
        },
      }),
    ],
    transports: { [base.id]: http(options.rpcUrl) },
  });
  walletConnect_ = { key, config };
  return config;
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

/** Conectores ofrecidos: los del navegador (EIP-6963, injected, Coinbase con extensión) y WalletConnect si hay projectId. */
export async function listConnectors(options: ExternalWalletOptions, waitMs = 400): Promise<ConnectorChoice[]> {
  const config = createExternalWalletConfig(options);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return [
    ...config.connectors.map((connector) => ({ id: connector.id, name: connector.name })),
    ...(options.walletConnectProjectId === null ? [] : [{ id: WALLET_CONNECT_ID, name: 'WalletConnect' }]),
  ];
}

export class ExternalWalletError extends Error {
  override name = 'ExternalWalletError';
}

interface WalletConnectInternals {
  signer?: { client?: { core?: { verify?: { register: (input: unknown) => Promise<string | undefined> } } } };
}

/**
 * Verify API de WalletConnect: el SDK embebe un iframe oculto de verify.walletconnect.org para atestar el dominio ante
 * la wallet. La CSP de Recovery (frame-src 'none') y COEP require-corp no lo permiten: se desactiva el registro para
 * que el emparejamiento no espere su timeout ni genere violaciones. La wallet ve la sesión sin atestación de dominio;
 * el usuario compara la dirección de R completa (docs/CONNECTORS.md).
 */
async function withoutVerifyIframe(connector: Connector): Promise<void> {
  if (connector.id !== 'walletConnect') return;
  const provider = (await connector.getProvider()) as WalletConnectInternals | undefined;
  const verify = provider?.signer?.client?.core?.verify;
  if (verify) verify.register = () => Promise.resolve(undefined);
}

/**
 * Conecta la wallet elegida en Base ([F-CON-02]: si reporta otra cadena se le pide cambiar y, si no cambia, no se usa).
 * Con WalletConnect el URI de emparejamiento llega por `onDisplayUri` para el QR propio (sin el modal de Reown).
 */
export async function connectExternal(
  options: ExternalWalletOptions,
  connectorId: string,
  onDisplayUri?: (uri: string) => void,
): Promise<ExternalSession> {
  const projectId = options.walletConnectProjectId;
  const config =
    connectorId === WALLET_CONNECT_ID && projectId !== null
      ? walletConnectConfig({ ...options, walletConnectProjectId: projectId })
      : createExternalWalletConfig(options);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const connector = config.connectors.find((c) => c.id === connectorId);
  if (!connector) throw new ExternalWalletError('Esa wallet ya no está disponible en este navegador.');
  const onMessage = (message: { type: string; data?: unknown }) => {
    if (message.type === 'display_uri' && typeof message.data === 'string') onDisplayUri?.(message.data);
  };
  connector.emitter.on('message', onMessage);
  // Cada conexión desde la UI empieza una sesión nueva: si este conector quedó conectado desde otra pantalla de la misma
  // página (p. ej. el enrollment), esa sesión se cierra primero.
  if (config.state.connections.has(connector.uid)) await disconnect(config, { connector }).catch(() => undefined);
  await withoutVerifyIframe(connector);
  const result = await connect(config, { connector, chainId: base.id }).finally(() => {
    connector.emitter.off('message', onMessage);
  });
  if (result.chainId !== base.id) {
    await switchChain(config, { chainId: base.id }).catch(() => {
      throw new ExternalWalletError('La wallet no está en Base (8453) y no cambió de red: no se usa.');
    });
  }
  const address = result.accounts[0];
  const onBase = () => {
    if (getConnection(config).chainId !== base.id) {
      throw new ExternalWalletError('La wallet cambió de red: firmá sólo en Base (8453).');
    }
  };
  return {
    connectorId: connector.id,
    connectorName: connector.name,
    address,
    signTypedData: async (definition) => {
      onBase();
      const signature = await signTypedData(config, { account: address, ...definition });
      // La firma tiene que recuperar exactamente a la cuenta conectada (EOA, [F-KEY-09]).
      const recovered = await recoverTypedDataAddress({ ...definition, signature });
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        throw new ExternalWalletError(
          'La firma no es de la cuenta conectada (¿es una smart-contract wallet?): no se acepta.',
        );
      }
      return signature;
    },
    sendTransaction: async (tx) => {
      onBase();
      return sendTransaction(config, {
        account: address,
        chainId: base.id,
        to: tx.to,
        data: tx.data,
        ...(tx.gas === undefined ? {} : { gas: tx.gas }),
      });
    },
    disconnect: async () => {
      await disconnect(config).catch(() => undefined);
    },
  };
}
