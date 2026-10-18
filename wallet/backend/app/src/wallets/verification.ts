// Verificación post-deploy de una Safe (P12.T07, V9 §16, [C-FAC-05]) por lectura directa on-chain con quórum: todos
// los valores se leen en el mismo bloque en ambos proveedores (deben coincidir) y se comparan con lo que fija el
// snapshot de policy firmado (direcciones y runtime codehashes del sistema y de Safe). Sólo si TODO coincide la wallet
// pasa a ACTIVE; cualquier diferencia es un FAILED con el ítem que falló (la Safe nunca se presenta como operativa).
import { getAddress, isAddressEqual, keccak256, type Abi, type Address, type Hex } from 'viem';
import { iSafeAbi, securityGuardAbi, walletFactoryAbi } from '../chain/abis/index.ts';
import type { BaseClient, RpcQuorumClient } from '../chain/rpc-quorum.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

/** Slots de Safe 1.5.0 (keccak256 del nombre): guard, module guard y fallback handler. */
export const SAFE_SLOTS = {
  singleton: '0x0000000000000000000000000000000000000000000000000000000000000000',
  guard: '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8',
  moduleGuard: '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947',
  fallbackHandler: '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5',
} as const satisfies Record<string, Hex>;

const SENTINEL: Address = '0x0000000000000000000000000000000000000001';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const EMPTY_CODEHASH = keccak256('0x');
export const SAFE_THRESHOLD = 2n;

export interface ExpectedWallet {
  safe: Address;
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
  saltNonce: bigint;
}

/** Lo leído en el bloque común (serializable: lo comparan los dos proveedores). */
export interface OnChainWalletState {
  chainId: number;
  factoryCodehash: Hex;
  factoryChainId: string;
  isWallet: boolean;
  predicted: Address;
  safeCodehash: Hex;
  singleton: Address;
  singletonCodehash: Hex;
  owners: Address[];
  threshold: string;
  nonce: string;
  guard: Address;
  guardCodehash: Hex;
  moduleGuard: Address;
  moduleGuardCodehash: Hex;
  fallbackHandler: Address;
  modules: Address[];
  roles: { userKey: Address; recoveryKey: Address; executor: Address; initialized: boolean };
  registered: boolean;
  guardTimelock: Address;
  timelockCodehash: Hex;
  guardPolicyRegistry: Address;
  policyRegistryCodehash: Hex;
  bootstrapCodehash: Hex;
}

export type VerificationResult =
  | { ok: true; blockNumber: bigint; state: OnChainWalletState }
  | { ok: false; blockNumber: bigint; state: OnChainWalletState; failures: string[] };

const slotAddress = (word: Hex | undefined): Address =>
  getAddress(`0x${(word ?? '0x').replace(/^0x/, '').padStart(64, '0').slice(24)}`);

async function codehashOf(client: BaseClient, address: Address, blockNumber: bigint): Promise<Hex> {
  const code = await client.getCode({ address, blockNumber });
  return code === undefined || code === '0x' ? EMPTY_CODEHASH : keccak256(code);
}

/** Todas las lecturas de la verificación, en un bloque fijo de un proveedor. */
export async function readWalletState(
  client: BaseClient,
  blockNumber: bigint,
  snapshot: BackendPolicySnapshot,
  expected: ExpectedWallet,
): Promise<OnChainWalletState> {
  const c = snapshot.contracts;
  // Los ABIs generados son `as const`; el tipo de cada resultado lo fija quien llama.
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args, blockNumber }) as Promise<T>;
  const storage = (slot: Hex) => client.getStorageAt({ address: expected.safe, slot, blockNumber });

  const [chainId, factoryCodehash, factoryChainId, isWallet, predicted, safeCodehash] = await Promise.all([
    client.getChainId(),
    codehashOf(client, c.walletFactory, blockNumber),
    read<bigint>(c.walletFactory, walletFactoryAbi, 'CHAIN_ID'),
    read<boolean>(c.walletFactory, walletFactoryAbi, 'isWallet', [expected.safe]),
    read<Address>(c.walletFactory, walletFactoryAbi, 'predictWalletAddress', [
      expected.userKey,
      expected.recoveryKey,
      expected.executor,
      expected.saltNonce,
    ]),
    codehashOf(client, expected.safe, blockNumber),
  ]);
  // Sin código en la dirección no hay nada más que leer (las llamadas a la Safe revertirían).
  const deployed = safeCodehash !== EMPTY_CODEHASH;
  const [singletonWord, guardWord, moduleGuardWord, fallbackWord] = await Promise.all([
    storage(SAFE_SLOTS.singleton),
    storage(SAFE_SLOTS.guard),
    storage(SAFE_SLOTS.moduleGuard),
    storage(SAFE_SLOTS.fallbackHandler),
  ]);
  const [owners, threshold, nonce, modules] = deployed
    ? await Promise.all([
        read<readonly Address[]>(expected.safe, iSafeAbi, 'getOwners'),
        read<bigint>(expected.safe, iSafeAbi, 'getThreshold'),
        read<bigint>(expected.safe, iSafeAbi, 'nonce'),
        read<readonly [readonly Address[], Address]>(expected.safe, iSafeAbi, 'getModulesPaginated', [SENTINEL, 10n]),
      ])
    : [[] as readonly Address[], 0n, 0n, [[] as readonly Address[], SENTINEL] as const];
  const singleton = slotAddress(singletonWord);
  const guard = slotAddress(guardWord);
  const moduleGuard = slotAddress(moduleGuardWord);
  const [roles, registered, guardTimelock, guardPolicyRegistry] = await Promise.all([
    read<{ userKey: Address; recoveryKey: Address; executor: Address; initialized: boolean }>(
      c.securityGuard,
      securityGuardAbi,
      'rolesOf',
      [expected.safe],
    ),
    read<boolean>(c.securityGuard, securityGuardAbi, 'isRegistered', [expected.safe]),
    read<Address>(c.securityGuard, securityGuardAbi, 'ROTATION_TIMELOCK'),
    read<Address>(c.securityGuard, securityGuardAbi, 'POLICY_REGISTRY'),
  ]);
  const [singletonCodehash, guardCodehash, moduleGuardCodehash, timelockCodehash, policyRegistryCodehash] =
    await Promise.all([
      codehashOf(client, singleton, blockNumber),
      codehashOf(client, guard, blockNumber),
      codehashOf(client, moduleGuard, blockNumber),
      codehashOf(client, guardTimelock, blockNumber),
      codehashOf(client, guardPolicyRegistry, blockNumber),
    ]);
  const bootstrapCodehash = await codehashOf(client, c.safeBootstrap, blockNumber);
  return {
    chainId,
    factoryCodehash,
    factoryChainId: factoryChainId.toString(),
    isWallet,
    predicted: getAddress(predicted),
    safeCodehash,
    singleton,
    singletonCodehash,
    owners: owners.map((o) => getAddress(o)),
    threshold: threshold.toString(),
    nonce: nonce.toString(),
    guard,
    guardCodehash,
    moduleGuard,
    moduleGuardCodehash,
    fallbackHandler: slotAddress(fallbackWord),
    modules: modules[0].map((m) => getAddress(m)),
    roles: {
      userKey: getAddress(roles.userKey),
      recoveryKey: getAddress(roles.recoveryKey),
      executor: getAddress(roles.executor),
      initialized: roles.initialized,
    },
    registered,
    guardTimelock: getAddress(guardTimelock),
    timelockCodehash,
    guardPolicyRegistry: getAddress(guardPolicyRegistry),
    policyRegistryCodehash,
    bootstrapCodehash,
  };
}

/** Ítems de V9 §16 / [C-FAC-05] que no coinciden (vacío = todo correcto). */
export function walletStateFailures(
  state: OnChainWalletState,
  snapshot: BackendPolicySnapshot,
  expected: ExpectedWallet,
  options: { requireFreshNonce: boolean },
): string[] {
  const c = snapshot.contracts;
  const h = snapshot.codehashes;
  const failures: string[] = [];
  const check = (ok: boolean, item: string) => {
    if (!ok) failures.push(item);
  };
  const same = (a: Address, b: Address) => isAddressEqual(a, b);
  check(state.chainId === snapshot.chainId && state.factoryChainId === String(snapshot.chainId), 'CHAIN_ID');
  check(state.factoryCodehash === h.walletFactory, 'FACTORY_CODEHASH');
  check(state.isWallet, 'NOT_A_FACTORY_WALLET');
  check(same(state.predicted, expected.safe), 'ADDRESS_MISMATCH');
  check(state.safeCodehash === h.safeProxyRuntime, 'SAFE_PROXY_CODEHASH');
  check(same(state.singleton, c.safeL2Singleton), 'SINGLETON');
  check(state.singletonCodehash === h.safeL2Singleton, 'SINGLETON_CODEHASH');
  const owners = new Set(state.owners.map((o) => o.toLowerCase()));
  const wanted = [expected.userKey, expected.recoveryKey, expected.executor].map((o) => o.toLowerCase());
  check(state.owners.length === 3 && owners.size === 3 && wanted.every((o) => owners.has(o)), 'OWNERS');
  check(state.threshold === SAFE_THRESHOLD.toString(), 'THRESHOLD');
  if (options.requireFreshNonce) check(state.nonce === '0', 'NONCE');
  check(same(state.guard, c.securityGuard), 'GUARD');
  check(state.guardCodehash === h.securityGuard, 'GUARD_CODEHASH');
  check(same(state.moduleGuard, c.denyAllModuleGuard), 'MODULE_GUARD');
  check(state.moduleGuardCodehash === h.denyAllModuleGuard, 'MODULE_GUARD_CODEHASH');
  check(same(state.fallbackHandler, ZERO), 'FALLBACK_HANDLER');
  check(state.modules.length === 0, 'MODULES');
  check(
    state.registered &&
      state.roles.initialized &&
      same(state.roles.userKey, expected.userKey) &&
      same(state.roles.recoveryKey, expected.recoveryKey) &&
      same(state.roles.executor, expected.executor),
    'ROLES',
  );
  check(same(state.guardTimelock, c.rotationTimelock), 'ROTATION_TIMELOCK');
  check(state.timelockCodehash === h.rotationTimelock, 'ROTATION_TIMELOCK_CODEHASH');
  check(same(state.guardPolicyRegistry, c.policyRegistry), 'POLICY_REGISTRY');
  check(state.policyRegistryCodehash === h.policyRegistry, 'POLICY_REGISTRY_CODEHASH');
  check(state.bootstrapCodehash === h.safeBootstrap, 'BOOTSTRAP_CODEHASH');
  return failures;
}

/** Verificación completa con quórum (un bloque común para todas las lecturas). */
export async function verifyDeployedWallet(
  rpc: RpcQuorumClient,
  snapshot: BackendPolicySnapshot,
  expected: ExpectedWallet,
  options: { requireFreshNonce?: boolean } = {},
): Promise<VerificationResult> {
  const { value: state, blockNumber } = await rpc.readSensitive('wallet-verification', (client, block) =>
    readWalletState(client, block, snapshot, expected),
  );
  const failures = walletStateFailures(state, snapshot, expected, {
    requireFreshNonce: options.requireFreshNonce ?? true,
  });
  return failures.length === 0 ? { ok: true, blockNumber, state } : { ok: false, blockNumber, state, failures };
}
