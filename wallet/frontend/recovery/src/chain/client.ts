// Lecturas de Base con el RPC propio de Recovery (en local y ci, el Anvil del fork): todo lo que la app verifica
// on-chain (roles del Guard, nonce de la Safe, propuestas del timelock, saldos) sale de acá, nunca del backend. Funciona
// con el backend apagado (modo soberano).
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

function create(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 20_000, retryCount: 1 }) });
}

export type ChainReader = ReturnType<typeof create>;

let reader: ChainReader | null = null;

export function chainReader(rpcUrl: string): ChainReader {
  reader ??= create(rpcUrl);
  return reader;
}
