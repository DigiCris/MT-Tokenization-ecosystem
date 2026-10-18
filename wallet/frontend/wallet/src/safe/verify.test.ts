// P18.T02: la verificación propia de la Safe falla con el ítem exacto ante cualquier diferencia con lo fijado en el
// build o con las claves que conoce la app, y sólo da ok con todo en orden. El lector es un mundo on-chain consistente
// en memoria (códigos, storage y vistas); la lectura real contra el fork la cubre test/browser/stack/safe-creation.
import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES, type SystemRole } from '../config/system-contracts.ts';
import { predictSafeAddress, walletSaltNonce, type WalletKeys } from './predict.ts';
import {
  readSafeState,
  SAFE_SLOTS,
  verifySafe,
  type Expectation,
  type PinnedSystem,
  type SafeReader,
} from './verify.ts';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const code = (label: string): Hex => toHex(new TextEncoder().encode(`code:${label}`));
const word = (a: Address): Hex => encodeAbiParameters([{ type: 'address' }], [a]);

const ROLE_ADDRESSES: Record<SystemRole, Address> = {
  guard: addr(0x1001),
  timelock: addr(0x1002),
  policyRegistry: addr(0x1003),
  whitelist: addr(0x1004),
  swapExecutor: addr(0x1005),
  bootstrap: addr(0x1006),
  factory: addr(0x1007),
  moduleGuard: addr(0x1008),
};
const SINGLETON = addr(0x2001);
const PROXY_FACTORY = addr(0x2002);
const KEYS: WalletKeys = { userKey: addr(0xaa01), recoveryKey: addr(0xaa02), executor: addr(0xaa03) };
const SALT_NONCE = walletSaltNonce('mt-default', '11111111-2222-4333-8444-555555555555');

const pinned: PinnedSystem = {
  chain: {
    chainId: 8453,
    safe: {
      singletonL2: SINGLETON,
      singletonL2Codehash: keccak256(code('singleton')),
      proxyFactory: PROXY_FACTORY,
      proxyCreationCodeHash: keccak256('0x01'),
      proxyRuntimeCodehash: keccak256(code('proxy')),
    },
  },
  system: {
    contracts: Object.fromEntries(
      SYSTEM_ROLES.map((role) => [
        role,
        { name: role, address: ROLE_ADDRESSES[role], codehash: keccak256(code(role)) },
      ]),
    ) as PinnedSystem['system']['contracts'],
  },
};
const SAFE = predictSafeAddress(KEYS, SALT_NONCE, {
  safeProxyFactory: PROXY_FACTORY,
  safeSingleton: SINGLETON,
  safeBootstrap: ROLE_ADDRESSES.bootstrap,
});

interface World {
  chainId: number;
  codes: Map<string, Hex>;
  slots: Record<keyof typeof SAFE_SLOTS, Address>;
  owners: Address[];
  threshold: bigint;
  nonce: bigint;
  modules: Address[];
  roles: WalletKeys & { initialized: boolean };
  registered: boolean;
  isWallet: boolean;
  guardViews: Record<
    'ROTATION_TIMELOCK' | 'POLICY_REGISTRY' | 'DESTINATION_WHITELIST' | 'DENY_ALL_MODULE_GUARD',
    Address
  >;
  factoryPrediction: Address;
}

function healthyWorld(): World {
  const codes = new Map<string, Hex>(SYSTEM_ROLES.map((role) => [ROLE_ADDRESSES[role].toLowerCase(), code(role)]));
  codes.set(SINGLETON.toLowerCase(), code('singleton'));
  codes.set(SAFE.toLowerCase(), code('proxy'));
  return {
    chainId: 8453,
    codes,
    slots: {
      singleton: SINGLETON,
      guard: ROLE_ADDRESSES.guard,
      moduleGuard: ROLE_ADDRESSES.moduleGuard,
      fallbackHandler: addr(0),
    },
    owners: [KEYS.userKey, KEYS.recoveryKey, KEYS.executor],
    threshold: 2n,
    nonce: 0n,
    modules: [],
    roles: { ...KEYS, initialized: true },
    registered: true,
    isWallet: true,
    guardViews: {
      ROTATION_TIMELOCK: ROLE_ADDRESSES.timelock,
      POLICY_REGISTRY: ROLE_ADDRESSES.policyRegistry,
      DESTINATION_WHITELIST: ROLE_ADDRESSES.whitelist,
      DENY_ALL_MODULE_GUARD: ROLE_ADDRESSES.moduleGuard,
    },
    factoryPrediction: SAFE,
  };
}

function reader(world: World): SafeReader {
  const slotOf = (slot: Hex) => {
    const entry = (Object.entries(SAFE_SLOTS) as [keyof typeof SAFE_SLOTS, Hex][]).find(([, s]) => s === slot);
    if (!entry) throw new Error(`slot inesperado ${slot}`);
    return word(world.slots[entry[0]]);
  };
  const views: Record<string, (args: readonly unknown[]) => unknown> = {
    getOwners: () => world.owners,
    getThreshold: () => world.threshold,
    nonce: () => world.nonce,
    getModulesPaginated: () => [world.modules, addr(1)],
    rolesOf: () => world.roles,
    isRegistered: () => world.registered,
    isWallet: () => world.isWallet,
    CHAIN_ID: () => BigInt(world.chainId),
    predictWalletAddress: () => world.factoryPrediction,
    ROTATION_TIMELOCK: () => world.guardViews.ROTATION_TIMELOCK,
    POLICY_REGISTRY: () => world.guardViews.POLICY_REGISTRY,
    DESTINATION_WHITELIST: () => world.guardViews.DESTINATION_WHITELIST,
    DENY_ALL_MODULE_GUARD: () => world.guardViews.DENY_ALL_MODULE_GUARD,
  };
  const fake = {
    getBlockNumber: () => Promise.resolve(123n),
    getChainId: () => Promise.resolve(world.chainId),
    getCode: ({ address }: { address: Address }) => Promise.resolve(world.codes.get(address.toLowerCase())),
    getStorageAt: ({ slot }: { slot: Hex }) => Promise.resolve(slotOf(slot)),
    readContract: ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      const view = views[functionName];
      if (!view) throw new Error(`vista inesperada ${functionName}`);
      return Promise.resolve(view(args ?? []));
    },
  };
  return fake as unknown as SafeReader;
}

const creation = { kind: 'creation', safe: SAFE, keys: KEYS, saltNonce: SALT_NONCE } as const;
const unlock = { kind: 'unlock', safe: SAFE, userKey: KEYS.userKey } as const;

async function failuresFor(mutate: (w: World) => void, expectation: Expectation = creation) {
  const world = healthyWorld();
  mutate(world);
  const result = await verifySafe(reader(world), pinned, expectation);
  return result.ok ? [] : result.failures;
}

describe('verificación propia de la Safe (V9 §16)', () => {
  it('una Safe recién creada con todo en orden verifica', async () => {
    const result = await verifySafe(reader(healthyWorld()), pinned, creation);
    expect(result).toMatchObject({ ok: true });
    expect(await failuresFor(() => undefined, unlock)).toEqual([]);
  });

  it.each<[string, (w: World) => void, string[]]>([
    ['otra cadena', (w) => (w.chainId = 1), ['CHAIN_ID']],
    [
      'código de la factory distinto',
      (w) => w.codes.set(ROLE_ADDRESSES.factory.toLowerCase(), code('otra')),
      ['CODEHASH_FACTORY'],
    ],
    [
      'whitelist con otro código',
      (w) => w.codes.set(ROLE_ADDRESSES.whitelist.toLowerCase(), code('x')),
      ['CODEHASH_WHITELIST'],
    ],
    ['no la creó la factory', (w) => (w.isWallet = false), ['NOT_A_FACTORY_WALLET']],
    ['proxy con otro runtime', (w) => w.codes.set(SAFE.toLowerCase(), code('otro')), ['SAFE_PROXY_CODEHASH']],
    ['otra singleton', (w) => (w.slots.singleton = addr(0x9999)), ['SINGLETON', 'SINGLETON_CODEHASH']],
    ['threshold 1', (w) => (w.threshold = 1n), ['THRESHOLD']],
    ['otro guard', (w) => (w.slots.guard = addr(0x9998)), ['GUARD']],
    ['otro module guard', (w) => (w.slots.moduleGuard = addr(0x9997)), ['MODULE_GUARD']],
    ['fallback handler', (w) => (w.slots.fallbackHandler = addr(0x9996)), ['FALLBACK_HANDLER']],
    ['un módulo habilitado', (w) => (w.modules = [addr(0x9995)]), ['MODULES']],
    ['timelock del guard distinto', (w) => (w.guardViews.ROTATION_TIMELOCK = addr(0x9994)), ['ROTATION_TIMELOCK']],
    ['registry del guard distinto', (w) => (w.guardViews.POLICY_REGISTRY = addr(0x9993)), ['POLICY_REGISTRY']],
    ['whitelist del guard distinta', (w) => (w.guardViews.DESTINATION_WHITELIST = addr(0x9992)), ['WHITELIST']],
    [
      'module guard del guard distinto',
      (w) => (w.guardViews.DENY_ALL_MODULE_GUARD = addr(0x9991)),
      ['GUARD_MODULE_GUARD'],
    ],
    ['no registrada en el guard', (w) => (w.registered = false), ['NOT_REGISTERED']],
    ['un owner de más', (w) => (w.owners = [...w.owners, addr(0x9990)]), ['OWNERS']],
    ['la factory predice otra dirección', (w) => (w.factoryPrediction = addr(0x998f)), ['FACTORY_PREDICTION']],
    ['nonce usado', (w) => (w.nonce = 1n), ['NONCE']],
    [
      'roles con otra R (y owners iguales a esos roles)',
      (w) => {
        w.roles = { ...w.roles, recoveryKey: addr(0x998e) };
        w.owners = [KEYS.userKey, addr(0x998e), KEYS.executor];
      },
      ['ROLES'],
    ],
  ])('al crear: %s', async (_label, mutate, expected) => {
    expect(await failuresFor(mutate)).toEqual(expected);
  });

  it('al crear: una dirección que no es la calculada por la app', async () => {
    const result = await verifySafe(reader(healthyWorld()), pinned, { ...creation, saltNonce: SALT_NONCE + 1n });
    expect(result.ok ? [] : result.failures).toContain('ADDRESS_MISMATCH');
  });

  it('sin código en la dirección: no es una Safe del sistema', async () => {
    const failures = await failuresFor((w) => w.codes.delete(SAFE.toLowerCase()));
    expect(failures).toEqual(expect.arrayContaining(['SAFE_PROXY_CODEHASH', 'THRESHOLD', 'OWNERS']));
  });

  it('al desbloquear: los owners siguen los roles vigentes tras una rotación de S', async () => {
    const rotated = addr(0xbb03);
    const failures = await failuresFor((w) => {
      w.roles = { ...w.roles, executor: rotated };
      w.owners = [KEYS.userKey, KEYS.recoveryKey, rotated];
      w.nonce = 7n;
    }, unlock);
    expect(failures).toEqual([]);
  });

  it('al desbloquear: U on-chain que no es la de este usuario, u owners que no son los roles', async () => {
    expect(await failuresFor((w) => (w.roles = { ...w.roles, userKey: addr(0xcc01) }), unlock)).toEqual([
      'OWNERS',
      'USER_KEY',
    ]);
    expect(await failuresFor((w) => (w.owners = [KEYS.userKey, KEYS.recoveryKey, addr(0xcc02)]), unlock)).toEqual([
      'OWNERS',
    ]);
  });

  it('lee todo en un mismo bloque y sin la predicción de la factory al desbloquear', async () => {
    const world = healthyWorld();
    const state = await readSafeState(reader(world), pinned, SAFE);
    expect(state.blockNumber).toBe('123');
    expect(state.factoryPrediction).toBeNull();
    expect(state.owners).toEqual(world.owners);
  });
});
