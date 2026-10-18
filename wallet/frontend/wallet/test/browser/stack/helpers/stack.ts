// Estado del stack que levantó scripts/test-browser.mjs (MTW_STACK_STATE): URLs de las APIs, Mailpit y el fork, el
// deployment de los contratos del sistema y la plataforma.
import { readFileSync } from 'node:fs';

export interface StackState {
  platformId: string;
  deploymentFile: string;
  signerAttestationPublicKey: string;
  urls: { apiWallet: string; apiRecovery: string; mailpit: string; anvil: string };
  gasTank: string;
}

let cached: StackState | null = null;

export function stack(): StackState {
  if (cached) return cached;
  const file = process.env.MTW_STACK_STATE;
  if (!file) throw new Error('falta MTW_STACK_STATE: estos tests corren con `pnpm test:browser` (levanta el stack)');
  cached = JSON.parse(readFileSync(file, 'utf8')) as StackState;
  return cached;
}

export function deployment(): { contracts: Record<string, { address: `0x${string}`; codehash: string }> } {
  return JSON.parse(readFileSync(stack().deploymentFile, 'utf8')) as {
    contracts: Record<string, { address: `0x${string}`; codehash: string }>;
  };
}

export function walletFactory(): `0x${string}` {
  const factory = deployment().contracts.WalletFactory?.address;
  if (!factory) throw new Error('el deployment del stack no tiene WalletFactory');
  return factory;
}

/** Origin del frontend que sirve la vista previa (es el WALLET_ORIGIN del backend del stack). */
export function walletOrigin(): string {
  return `http://localhost:${process.env.MTW_STACK_PREVIEW_PORT ?? '4174'}`;
}
