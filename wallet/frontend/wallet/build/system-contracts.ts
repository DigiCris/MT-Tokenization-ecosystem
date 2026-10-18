// Contratos del sistema fijados por entorno ([F-SEC-08], P16.T09): genera system-contracts.<env>.json desde
// contracts/deployments/<env>.json (address + codehash de Guard, Timelock, PolicyRegistry, Whitelist, SwapExecutor,
// Bootstrap, Factory y DenyAllModuleGuard) más la clave pública de atestación del signer ([B-SIG-07]). El archivo se
// emite en dist/ (cubierto por el manifest firmado) y el mismo contenido se embebe en la app como el módulo virtual
// `virtual:mtw-system-contracts`: si el backend informa direcciones distintas, la app se niega a operar.
import { existsSync, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import type { BuildConfig } from './config.ts';
import { canonicalize } from './jcs.ts';

/** Nombre en el deployment → rol en la app (el mismo nombre que usa el backend al informarlos). */
export const SYSTEM_CONTRACTS = {
  SecurityGuard: 'guard',
  RotationTimelock: 'timelock',
  PolicyRegistry: 'policyRegistry',
  DestinationWhitelist: 'whitelist',
  SwapExecutorV3: 'swapExecutor',
  SafeBootstrap: 'bootstrap',
  WalletFactory: 'factory',
  DenyAllModuleGuard: 'moduleGuard',
} as const;

export type SystemRole = (typeof SYSTEM_CONTRACTS)[keyof typeof SYSTEM_CONTRACTS];

export interface SystemContractsFile {
  format: 'mtw-system-contracts';
  formatVersion: 1;
  environment: string;
  chainId: number;
  deploymentBlock: number;
  contracts: Record<SystemRole, { name: string; address: string; codehash: string }>;
  signerAttestationPublicKey: string;
}

interface Deployment {
  chainId?: unknown;
  block?: unknown;
  contracts?: Record<string, { address?: unknown; codehash?: unknown } | undefined>;
}

const VIRTUAL_ID = 'virtual:mtw-system-contracts';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export function systemContractsFileName(environment: string): string {
  return `system-contracts.${environment}.json`;
}

export function systemContractsOf(
  config: Pick<BuildConfig, 'environment' | 'deploymentFile' | 'signerAttestationPublicKey'>,
): SystemContractsFile {
  if (!existsSync(config.deploymentFile)) {
    throw new Error(
      `falta el deployment del entorno ${config.environment} (${config.deploymentFile}): ` +
        'en local `pnpm deploy-local`; en CI `bash ci/scripts/deploy-ephemeral.sh`',
    );
  }
  const deployment = JSON.parse(readFileSync(config.deploymentFile, 'utf8')) as Deployment;
  if (deployment.chainId !== 8453) throw new Error('el deployment no es de Base (chainId 8453)');
  if (typeof deployment.block !== 'number' || !Number.isSafeInteger(deployment.block)) {
    throw new Error('el deployment no declara el bloque');
  }
  const contracts = {} as SystemContractsFile['contracts'];
  for (const [name, role] of Object.entries(SYSTEM_CONTRACTS)) {
    const entry = deployment.contracts?.[name];
    const address = entry?.address;
    const codehash = entry?.codehash;
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`el deployment no tiene la dirección de ${name}`);
    }
    if (typeof codehash !== 'string' || !/^0x[0-9a-f]{64}$/.test(codehash)) {
      throw new Error(`el deployment no tiene el codehash de ${name}`);
    }
    contracts[role] = { name, address, codehash };
  }
  return {
    format: 'mtw-system-contracts',
    formatVersion: 1,
    environment: config.environment,
    chainId: 8453,
    deploymentBlock: deployment.block,
    contracts,
    signerAttestationPublicKey: config.signerAttestationPublicKey,
  };
}

export function serializeSystemContracts(file: SystemContractsFile): string {
  return canonicalize({ ...file, contracts: { ...file.contracts } });
}

export function systemContractsPlugin(config: BuildConfig): Plugin {
  let file: SystemContractsFile | null = null;
  const load = (): SystemContractsFile => (file ??= systemContractsOf(config));
  return {
    name: 'mtw:system-contracts',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      return id === RESOLVED_ID ? `export default Object.freeze(${serializeSystemContracts(load())});` : null;
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: systemContractsFileName(config.environment),
        source: serializeSystemContracts(load()),
      });
    },
  };
}
