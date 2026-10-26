// Estado del stack que levantó scripts/test-e2e.mjs (MTW_STACK_STATE): URLs de las APIs, Mailpit y el fork, el
// deployment de los contratos del sistema y la plataforma, y los orígenes de las dos vistas previas. También los
// contadores de rate limiting del stack ([B-RL], en su Valkey: toda la suite sale de una sola IP y una cuenta nueva se
// modela como un cliente con su propia IP; una ventana de tiempo se adelanta como se adelanta la cadena) y la plataforma
// apagada y vuelta a levantar (modo soberano con el backend detenido).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';

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

const STACK_CLI = resolve(import.meta.dirname, '../../scripts/stack/stack.mjs');
let cached: StackState | null = null;

export function stackFile(): string {
  const file = process.env.MTW_STACK_STATE;
  if (!file)
    throw new Error('falta MTW_STACK_STATE: el E2E corre con `pnpm test` (scripts/test-e2e.mjs levanta el stack)');
  return file;
}

export function stack(): StackState {
  cached ??= JSON.parse(readFileSync(stackFile(), 'utf8')) as StackState;
  return cached;
}

export function deployment(): { contracts: Record<string, { address: Address; codehash: string }> } {
  return JSON.parse(readFileSync(stack().deploymentFile, 'utf8')) as {
    contracts: Record<string, { address: Address; codehash: string }>;
  };
}

export function contract(name: string): Address {
  const address = deployment().contracts[name]?.address;
  if (!address) throw new Error(`el deployment del stack no tiene ${name}`);
  return address;
}

export function walletFactory(): Address {
  return contract('WalletFactory');
}

/** Origen de la vista previa de la Wallet (el WALLET_ORIGIN del backend del stack). */
export function walletOrigin(): string {
  return `http://localhost:${process.env.MTW_E2E_WALLET_PORT ?? '4274'}`;
}

/** Origen de la vista previa de Recovery (el RECOVERY_ORIGIN del backend del stack). */
export function recoveryOrigin(): string {
  return `http://localhost:${process.env.MTW_E2E_RECOVERY_PORT ?? '5274'}`;
}

/** URL absoluta de una ruta de la app Recovery (el baseURL de los specs es el de la Wallet). */
export function recoveryUrl(path: string): string {
  return new URL(path, recoveryOrigin()).toString();
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

function stackCommand(command: 'backend-stop' | 'backend-start'): void {
  const result = spawnSync('node', [STACK_CLI, command, '--state', stackFile()], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`stack ${command} falló: ${result.stderr}`);
}

/** Apaga la plataforma (API de Wallet y de Recovery, worker y gas tank): la base, el fork y el signer siguen. */
export function stopBackend(): void {
  stackCommand('backend-stop');
}

export function startBackend(): void {
  stackCommand('backend-start');
}
