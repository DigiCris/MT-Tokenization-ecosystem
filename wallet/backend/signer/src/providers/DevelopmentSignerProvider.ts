// DevelopmentSignerProvider [B-SIG-04]: el MISMO SelfHostedSoftwareSignerProvider (así los tests ejercitan el código
// de producción) con guardas de desarrollo. Se niega a arrancar si:
//
// - APP_ENV no es `local`;
// - algún RPC del signer no es un fork de Anvil (`anvil_nodeInfo` sin `forkConfig.forkUrl`) o no es chainId 8453;
// - los keystores o la credencial no están bajo wallet/.secrets/signer/<shard>/ (o el directorio de tests).
//
// Además, si el shard local no existe lo inicializa (la credencial ya la generó `pnpm secrets:local`).
import { isAbsolute, relative, resolve } from 'node:path';
import { jsonRpc } from '../chain/json-rpc.ts';
import { sameAddress, type Address } from '../crypto/keccak.ts';
import { privateKeyToAddress } from '../crypto/secp256k1.ts';
import { SelfHostedSoftwareSignerProvider, type SoftwareProviderOptions } from './SelfHostedSoftwareSignerProvider.ts';

export const BASE_CHAIN_ID = 8453;

export class DevelopmentGuardError extends Error {
  override name = 'DevelopmentGuardError';
}

export interface DevelopmentGuardOptions {
  appEnv: string;
  rpcUrls: readonly string[];
  keystoreDir: string;
  credentialFile: string;
  /** Raíces permitidas para keystores y credencial (default: wallet/.secrets/signer). */
  allowedRoots: readonly string[];
}

interface AnvilNodeInfo {
  forkConfig?: { forkUrl?: string | null; forkBlockNumber?: number | null } | null;
}

function within(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Guardas del provider de desarrollo; lanza DevelopmentGuardError con el motivo. */
export async function assertDevelopmentEnvironment(options: DevelopmentGuardOptions): Promise<void> {
  if (options.appEnv !== 'local') {
    throw new DevelopmentGuardError(`SIGNER_PROVIDER=development sólo con APP_ENV=local (es ${options.appEnv})`);
  }
  for (const [label, path] of [
    ['keystores', options.keystoreDir],
    ['credencial', options.credentialFile],
  ] as const) {
    if (!options.allowedRoots.some((root) => within(path, root))) {
      throw new DevelopmentGuardError(`los ${label} del signer de desarrollo deben estar bajo .secrets/signer/`);
    }
  }
  if (options.rpcUrls.length === 0) throw new DevelopmentGuardError('sin RPC configurado');
  for (const url of new Set(options.rpcUrls)) {
    let info: AnvilNodeInfo;
    try {
      info = await jsonRpc<AnvilNodeInfo>(url, 'anvil_nodeInfo');
    } catch {
      throw new DevelopmentGuardError('el RPC del signer no es Anvil (anvil_nodeInfo no disponible)');
    }
    const forkUrl = info.forkConfig?.forkUrl;
    if (typeof forkUrl !== 'string' || forkUrl === '') {
      throw new DevelopmentGuardError('el RPC del signer es Anvil pero no un fork de Base (sin forkConfig)');
    }
    const chainId = Number.parseInt(await jsonRpc<string>(url, 'eth_chainId'), 16);
    if (chainId !== BASE_CHAIN_ID) {
      throw new DevelopmentGuardError(`el fork no es de Base (chainId ${chainId}, se esperaba ${BASE_CHAIN_ID})`);
    }
  }
}

export class DevelopmentSignerProvider extends SelfHostedSoftwareSignerProvider {
  /**
   * Sólo desarrollo local (P21.T04, `scripts/seed-executor.ts`): importa la S determinística del seed (derivada de
   * LOCAL_SEED, la misma que usa contracts/script/SeedLocal.s.sol) como clave EXECUTOR de la wallet del seed. Los
   * flujos de producto siguen creando S con el CSPRNG (createKey). Idempotente.
   */
  async importSeedKey(
    walletId: string,
    key: Uint8Array,
  ): Promise<{ keyRef: string; address: Address; created: boolean }> {
    const address = privateKeyToAddress(key);
    const existing = (await this.registry.forWallet(walletId)).find((k) => sameAddress(k.address, address));
    if (existing !== undefined) return { keyRef: existing.keyRef, address, created: false };
    return { ...(await this.storeKey(walletId, 'EXECUTOR', key)), created: true };
  }

  static async openDevelopment(
    options: SoftwareProviderOptions,
    guard: DevelopmentGuardOptions,
  ): Promise<DevelopmentSignerProvider> {
    await assertDevelopmentEnvironment(guard);
    const provider = new DevelopmentSignerProvider('development', options);
    await provider.initialize({ autoInitShard: true });
    return provider;
  }
}
