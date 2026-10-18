// Estado on-chain de una Safe para el pipeline de operaciones (P13), leído por el backend con su propio RPC y su
// propia implementación (el signer repite todo con la suya): nonce, roles del Guard, configuración completa (paso 7b
// de [B-Q-02]) y timestamp, todo en un mismo bloque de un proveedor; el quórum lo aplica quien llama
// (RpcQuorumClient.readSensitive compara el resultado completo de los dos proveedores).
import { getAddress, isAddressEqual, type Abi, type Address, type Hex } from 'viem';
import { iSafeAbi, securityGuardAbi, walletFactoryAbi } from './abis/index.ts';
import type { BaseClient } from './rpc-quorum.ts';
import { SAFE_SLOTS, SAFE_THRESHOLD } from '../wallets/verification.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

const SENTINEL: Address = '0x0000000000000000000000000000000000000001';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Serializable (bigint como string): lo comparan los dos proveedores. */
export interface SafeChainState {
  blockNumber: string;
  timestamp: number;
  registered: boolean;
  isWallet: boolean;
  roles: { userKey: Address; recoveryKey: Address; executor: Address; initialized: boolean };
  nonce: string;
  threshold: string;
  owners: Address[];
  singleton: Address;
  guard: Address;
  moduleGuard: Address;
  fallbackHandler: Address;
  modules: Address[];
}

const slotAddress = (word: Hex | undefined): Address =>
  getAddress(`0x${(word ?? '0x').replace(/^0x/, '').padStart(64, '0').slice(24)}`);

export async function readSafeState(
  client: BaseClient,
  blockNumber: bigint,
  snapshot: BackendPolicySnapshot,
  safe: Address,
): Promise<SafeChainState> {
  const c = snapshot.contracts;
  // Los ABIs generados son `as const`; el tipo de cada resultado lo fija quien llama.
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args, blockNumber }) as Promise<T>;
  const storage = (slot: Hex) => client.getStorageAt({ address: safe, slot, blockNumber });
  const [
    block,
    registered,
    isWallet,
    roles,
    nonce,
    threshold,
    owners,
    singleton,
    guard,
    moduleGuard,
    fallback,
    modules,
  ] = await Promise.all([
    client.getBlock({ blockNumber }),
    read<boolean>(c.securityGuard, securityGuardAbi, 'isRegistered', [safe]),
    read<boolean>(c.walletFactory, walletFactoryAbi, 'isWallet', [safe]),
    read<{ userKey: Address; recoveryKey: Address; executor: Address; initialized: boolean }>(
      c.securityGuard,
      securityGuardAbi,
      'rolesOf',
      [safe],
    ),
    read<bigint>(safe, iSafeAbi, 'nonce'),
    read<bigint>(safe, iSafeAbi, 'getThreshold'),
    read<readonly Address[]>(safe, iSafeAbi, 'getOwners'),
    storage(SAFE_SLOTS.singleton),
    storage(SAFE_SLOTS.guard),
    storage(SAFE_SLOTS.moduleGuard),
    storage(SAFE_SLOTS.fallbackHandler),
    read<readonly [readonly Address[], Address]>(safe, iSafeAbi, 'getModulesPaginated', [SENTINEL, 10n]),
  ]);
  return {
    blockNumber: blockNumber.toString(),
    timestamp: Number(block.timestamp),
    registered,
    isWallet,
    roles: {
      userKey: getAddress(roles.userKey),
      recoveryKey: getAddress(roles.recoveryKey),
      executor: getAddress(roles.executor),
      initialized: roles.initialized,
    },
    nonce: nonce.toString(),
    threshold: threshold.toString(),
    owners: owners.map((o) => getAddress(o)),
    singleton: slotAddress(singleton),
    guard: slotAddress(guard),
    moduleGuard: slotAddress(moduleGuard),
    fallbackHandler: slotAddress(fallback),
    modules: modules[0].map((m) => getAddress(m)),
  };
}

/** Ítems de configuración que ya no son los de una wallet asistida (paso 7b, [B-FIN-03]); vacío = intacta. */
export type ConfigDriftItem =
  'NOT_REGISTERED' | 'SINGLETON' | 'GUARD' | 'MODULE_GUARD' | 'FALLBACK_HANDLER' | 'MODULES' | 'THRESHOLD' | 'OWNERS';

export function safeConfigDrift(state: SafeChainState, snapshot: BackendPolicySnapshot): ConfigDriftItem[] {
  const c = snapshot.contracts;
  const drift: ConfigDriftItem[] = [];
  if (!state.registered || !state.isWallet || !state.roles.initialized) drift.push('NOT_REGISTERED');
  if (!isAddressEqual(state.singleton, c.safeL2Singleton)) drift.push('SINGLETON');
  if (!isAddressEqual(state.guard, c.securityGuard)) drift.push('GUARD');
  if (!isAddressEqual(state.moduleGuard, c.denyAllModuleGuard)) drift.push('MODULE_GUARD');
  if (!isAddressEqual(state.fallbackHandler, ZERO)) drift.push('FALLBACK_HANDLER');
  if (state.modules.length > 0) drift.push('MODULES');
  if (state.threshold !== SAFE_THRESHOLD.toString()) drift.push('THRESHOLD');
  const roles = [state.roles.userKey, state.roles.recoveryKey, state.roles.executor].map((a) => a.toLowerCase()).sort();
  const owners = state.owners.map((a) => a.toLowerCase()).sort();
  if (owners.length !== 3 || owners.some((o, i) => o !== roles[i])) drift.push('OWNERS');
  return drift;
}
