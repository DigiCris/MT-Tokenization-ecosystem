// Cliente de lectura de Base de la app con el RPC propio del frontend (en local y ci, el Anvil del fork): todo lo que
// la app verifica on-chain (Safe, roles, saldos, cotizaciones, rotaciones) sale de acá y nunca del backend.
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

function baseClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 20_000, retryCount: 1 }) });
}

export type BaseClient = ReturnType<typeof baseClient>;
let client: BaseClient | null = null;

/** Cliente de lectura de Base con el RPC del frontend (uno por pestaña). */
export function frontendClient(rpcUrl: string): BaseClient {
  client ??= baseClient(rpcUrl);
  return client;
}
