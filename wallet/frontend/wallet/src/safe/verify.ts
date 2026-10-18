// Verificación propia de la Safe (P18.T02, V9 §16, [C-FAC-05], [F-SEC-08]) con el RPC del frontend, independiente de lo
// que diga el backend: todo se lee en un mismo bloque y se compara con lo fijado en el build (contratos del sistema con
// sus codehashes, Safe 1.5.0 de chain.base.json) y con las claves que conoce la propia app. Al crearla se exige además
// la dirección calculada por la app (y la que devuelve la factory on-chain) y el nonce 0; en cada desbloqueo se
// re-verifica la configuración con los roles vigentes del Guard (las rotaciones cambian U, R o S) y que U sea la clave
// de este usuario. La Safe se muestra operativa sólo si no hay ningún ítem fallido.
import { getAddress, isAddressEqual, keccak256, type Address, type Hex } from 'viem';
import type { PinnedChain } from '../config/chain.ts';
import type { SystemContracts, SystemRole } from '../config/system-contracts.ts';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { walletFactoryAbi } from '../chain/abis/WalletFactory.ts';
import type { BaseClient } from '../chain/client.ts';
import { predictSafeAddress, SAFE_THRESHOLD, type WalletKeys } from './predict.ts';

/** Slots de Safe 1.5.0: singleton, guard, module guard y fallback handler. */
export const SAFE_SLOTS = {
  singleton: '0x0000000000000000000000000000000000000000000000000000000000000000',
  guard: '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8',
  moduleGuard: '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947',
  fallbackHandler: '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5',
} as const satisfies Record<string, Hex>;

const SENTINEL: Address = '0x0000000000000000000000000000000000000001';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const EMPTY_CODEHASH = keccak256('0x');

export type SafeReader = Pick<
  BaseClient,
  'getBlockNumber' | 'getChainId' | 'getCode' | 'getStorageAt' | 'readContract'
>;

export interface PinnedSystem {
  chain: Pick<PinnedChain, 'chainId' | 'safe'>;
  system: Pick<SystemContracts, 'contracts'>;
}

/** Lo leído on-chain en un bloque (serializable). */
export interface SafeState {
  blockNumber: string;
  chainId: number;
  safeCodehash: Hex;
  singleton: Address;
  singletonCodehash: Hex;
  owners: Address[];
  threshold: string;
  nonce: string;
  guard: Address;
  moduleGuard: Address;
  fallbackHandler: Address;
  modules: Address[];
  roles: { userKey: Address; recoveryKey: Address; executor: Address; initialized: boolean };
  registered: boolean;
  isWallet: boolean;
  factoryChainId: string;
  guardTimelock: Address;
  guardPolicyRegistry: Address;
  guardWhitelist: Address;
  guardModuleGuard: Address;
  systemCodehashes: Record<SystemRole, Hex>;
  /** `WalletFactory.predictWalletAddress` para las claves esperadas (sólo al crear). */
  factoryPrediction: Address | null;
}

export type Expectation =
  | { kind: 'creation'; safe: Address; keys: WalletKeys; saltNonce: bigint }
  | { kind: 'unlock'; safe: Address; userKey: Address };

export type VerificationResult =
  { ok: true; state: SafeState } | { ok: false; state: SafeState | null; failures: string[] };

const slotAddress = (word: Hex | undefined): Address =>
  getAddress(`0x${(word ?? '0x').replace(/^0x/, '').padStart(64, '0').slice(24)}`);

async function codehashOf(reader: SafeReader, address: Address, blockNumber: bigint): Promise<Hex> {
  const code = await reader.getCode({ address, blockNumber });
  return code === undefined || code === '0x' ? EMPTY_CODEHASH : keccak256(code);
}

export async function readSafeState(
  reader: SafeReader,
  pinned: PinnedSystem,
  safe: Address,
  predictionFor?: { keys: WalletKeys; saltNonce: bigint },
): Promise<SafeState> {
  const c = pinned.system.contracts;
  const blockNumber = await reader.getBlockNumber();
  const at = { blockNumber } as const;
  const storage = (slot: Hex) => reader.getStorageAt({ address: safe, slot, ...at });
  const [chainId, safeCodehash, singletonWord, guardWord, moduleGuardWord, fallbackWord] = await Promise.all([
    reader.getChainId(),
    codehashOf(reader, safe, blockNumber),
    storage(SAFE_SLOTS.singleton),
    storage(SAFE_SLOTS.guard),
    storage(SAFE_SLOTS.moduleGuard),
    storage(SAFE_SLOTS.fallbackHandler),
  ]);
  // Sin código en la dirección no hay Safe que leer (las llamadas revertirían).
  const deployed = safeCodehash !== EMPTY_CODEHASH;
  const [owners, threshold, nonce, modules] = deployed
    ? await Promise.all([
        reader.readContract({ address: safe, abi: iSafeAbi, functionName: 'getOwners', ...at }),
        reader.readContract({ address: safe, abi: iSafeAbi, functionName: 'getThreshold', ...at }),
        reader.readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce', ...at }),
        reader.readContract({
          address: safe,
          abi: iSafeAbi,
          functionName: 'getModulesPaginated',
          args: [SENTINEL, 10n],
          ...at,
        }),
      ])
    : [[] as readonly Address[], 0n, 0n, [[] as readonly Address[], SENTINEL] as const];
  const guardRead = <
    F extends 'ROTATION_TIMELOCK' | 'POLICY_REGISTRY' | 'DESTINATION_WHITELIST' | 'DENY_ALL_MODULE_GUARD',
  >(
    functionName: F,
  ) => reader.readContract({ address: c.guard.address, abi: securityGuardAbi, functionName, ...at });
  const [roles, registered, isWallet, factoryChainId, timelock, registry, whitelist, guardModuleGuard, prediction] =
    await Promise.all([
      reader.readContract({
        address: c.guard.address,
        abi: securityGuardAbi,
        functionName: 'rolesOf',
        args: [safe],
        ...at,
      }),
      reader.readContract({
        address: c.guard.address,
        abi: securityGuardAbi,
        functionName: 'isRegistered',
        args: [safe],
        ...at,
      }),
      reader.readContract({
        address: c.factory.address,
        abi: walletFactoryAbi,
        functionName: 'isWallet',
        args: [safe],
        ...at,
      }),
      reader.readContract({ address: c.factory.address, abi: walletFactoryAbi, functionName: 'CHAIN_ID', ...at }),
      guardRead('ROTATION_TIMELOCK'),
      guardRead('POLICY_REGISTRY'),
      guardRead('DESTINATION_WHITELIST'),
      guardRead('DENY_ALL_MODULE_GUARD'),
      predictionFor === undefined
        ? Promise.resolve(null)
        : reader.readContract({
            address: c.factory.address,
            abi: walletFactoryAbi,
            functionName: 'predictWalletAddress',
            args: [
              predictionFor.keys.userKey,
              predictionFor.keys.recoveryKey,
              predictionFor.keys.executor,
              predictionFor.saltNonce,
            ],
            ...at,
          }),
    ]);
  const singleton = slotAddress(singletonWord);
  const roleNames = Object.keys(c) as SystemRole[];
  const [singletonCodehash, ...systemHashes] = await Promise.all([
    codehashOf(reader, singleton, blockNumber),
    ...roleNames.map((role) => codehashOf(reader, c[role].address, blockNumber)),
  ]);
  return {
    blockNumber: blockNumber.toString(),
    chainId,
    safeCodehash,
    singleton,
    singletonCodehash,
    owners: owners.map((o) => getAddress(o)),
    threshold: threshold.toString(),
    nonce: nonce.toString(),
    guard: slotAddress(guardWord),
    moduleGuard: slotAddress(moduleGuardWord),
    fallbackHandler: slotAddress(fallbackWord),
    modules: modules[0].map((m) => getAddress(m)),
    roles: {
      userKey: getAddress(roles.userKey),
      recoveryKey: getAddress(roles.recoveryKey),
      executor: getAddress(roles.executor),
      initialized: roles.initialized,
    },
    registered,
    isWallet,
    factoryChainId: factoryChainId.toString(),
    guardTimelock: getAddress(timelock),
    guardPolicyRegistry: getAddress(registry),
    guardWhitelist: getAddress(whitelist),
    guardModuleGuard: getAddress(guardModuleGuard),
    systemCodehashes: Object.fromEntries(
      roleNames.map((role, i) => [role, systemHashes[i] ?? EMPTY_CODEHASH]),
    ) as Record<SystemRole, Hex>,
    factoryPrediction: prediction === null ? null : getAddress(prediction),
  };
}

/** Ítems de V9 §16 que no coinciden (vacío = todo correcto). */
export function safeFailures(state: SafeState, pinned: PinnedSystem, expectation: Expectation): string[] {
  const c = pinned.system.contracts;
  const failures: string[] = [];
  const check = (ok: boolean, item: string) => {
    if (!ok) failures.push(item);
  };
  const same = (a: Address, b: Address) => isAddressEqual(a, b);
  check(state.chainId === pinned.chain.chainId && state.factoryChainId === String(pinned.chain.chainId), 'CHAIN_ID');
  for (const role of Object.keys(c) as SystemRole[]) {
    check(state.systemCodehashes[role] === c[role].codehash, `CODEHASH_${role.toUpperCase()}`);
  }
  check(state.isWallet, 'NOT_A_FACTORY_WALLET');
  check(state.safeCodehash === pinned.chain.safe.proxyRuntimeCodehash, 'SAFE_PROXY_CODEHASH');
  check(same(state.singleton, pinned.chain.safe.singletonL2), 'SINGLETON');
  check(state.singletonCodehash === pinned.chain.safe.singletonL2Codehash, 'SINGLETON_CODEHASH');
  check(state.threshold === SAFE_THRESHOLD.toString(), 'THRESHOLD');
  check(same(state.guard, c.guard.address), 'GUARD');
  check(same(state.moduleGuard, c.moduleGuard.address), 'MODULE_GUARD');
  check(same(state.fallbackHandler, ZERO), 'FALLBACK_HANDLER');
  check(state.modules.length === 0, 'MODULES');
  check(same(state.guardTimelock, c.timelock.address), 'ROTATION_TIMELOCK');
  check(same(state.guardPolicyRegistry, c.policyRegistry.address), 'POLICY_REGISTRY');
  check(same(state.guardWhitelist, c.whitelist.address), 'WHITELIST');
  check(same(state.guardModuleGuard, c.moduleGuard.address), 'GUARD_MODULE_GUARD');
  check(state.registered && state.roles.initialized, 'NOT_REGISTERED');
  const roles = state.roles;
  const owners = new Set(state.owners.map((o) => o.toLowerCase()));
  const ownersAre = (keys: readonly Address[]) =>
    state.owners.length === 3 && owners.size === 3 && keys.every((k) => owners.has(k.toLowerCase()));
  // Los owners son siempre exactamente los roles vigentes del Guard.
  check(ownersAre([roles.userKey, roles.recoveryKey, roles.executor]), 'OWNERS');
  if (expectation.kind === 'creation') {
    const { keys } = expectation;
    const predicted = predictSafeAddress(keys, expectation.saltNonce, {
      safeProxyFactory: pinned.chain.safe.proxyFactory,
      safeSingleton: pinned.chain.safe.singletonL2,
      safeBootstrap: c.bootstrap.address,
    });
    check(same(predicted, expectation.safe), 'ADDRESS_MISMATCH');
    check(state.factoryPrediction !== null && same(state.factoryPrediction, expectation.safe), 'FACTORY_PREDICTION');
    check(
      same(roles.userKey, keys.userKey) &&
        same(roles.recoveryKey, keys.recoveryKey) &&
        same(roles.executor, keys.executor),
      'ROLES',
    );
    check(state.nonce === '0', 'NONCE');
  } else {
    check(same(roles.userKey, expectation.userKey), 'USER_KEY');
  }
  return failures;
}

export async function verifySafe(
  reader: SafeReader,
  pinned: PinnedSystem,
  expectation: Expectation,
): Promise<VerificationResult> {
  const state = await readSafeState(
    reader,
    pinned,
    expectation.safe,
    expectation.kind === 'creation' ? { keys: expectation.keys, saltNonce: expectation.saltNonce } : undefined,
  );
  const failures = safeFailures(state, pinned, expectation);
  return failures.length === 0 ? { ok: true, state } : { ok: false, state, failures };
}
