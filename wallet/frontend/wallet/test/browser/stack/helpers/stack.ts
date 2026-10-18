// Estado del stack que levantó scripts/test-browser.mjs (MTW_STACK_STATE): URLs de las APIs, Mailpit y el fork, el
// deployment de los contratos del sistema y la plataforma. También los contadores de rate limiting del stack ([B-RL],
// en su Valkey): toda la suite sale de una sola IP (localhost) y una cuenta nueva se modela como un cliente con su
// propia IP; una ventana de tiempo se adelanta como se adelanta la cadena.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface StackState {
  dir: string;
  /** Proyecto de Docker Compose del stack (contenedores `<project>-<servicio>-1`). */
  project: string;
  /** .env propio del stack (secretos locales nuevos): lo usa la CLI de operadores. */
  envFile: string;
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

/** Borra en el Valkey del stack las claves de rate limiting que coinciden (el contenedor ya tiene la credencial). */
function deleteRateLimitKeys(pattern: string): void {
  const result = spawnSync(
    'docker',
    [
      'exec',
      `${stack().project}-valkey-1`,
      'sh',
      '-c',
      `valkey-cli --no-auth-warning --scan --pattern '${pattern}' | xargs -r valkey-cli --no-auth-warning del`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`no se pudieron borrar las claves ${pattern}: ${result.stderr}`);
}

/** Cada cuenta nueva llega como un cliente distinto: sin los contadores por IP que dejaron las anteriores. */
export function freshClientIp(): void {
  deleteRateLimitKeys('mtw:rl:*:ip=*');
}

/** Adelanta las ventanas de rate limiting (p. ej. los 10 min de los códigos por email de una misma cuenta). */
export function advanceRateLimitWindows(): void {
  deleteRateLimitKeys('mtw:rl:*');
}
