// P19: verificación propia de la Safe por el RPC de Recovery antes de que R firme. Con todo lo fijado en el build no
// hay fallas; cada desvío (contrato del sistema con otro código, proxy o singleton distintos, threshold, guards, Safe no
// registrada, owners ≠ roles, R que no es la recoveryKey) aparece como su ítem y requireSafe se niega a seguir. También
// las propuestas pendientes del timelock y el nonce leídos on-chain.
import { getAddress, keccak256, padHex, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { PinnedChain } from '../config/chain.ts';
import { SYSTEM_ROLES, type SystemContracts } from '../config/system-contracts.ts';
import { pendingProposals, safeNonce } from './rotations.ts';
import { checkSafe, requireSafe, SAFE_SLOTS, SafeCheckError, safeFailureText } from './safe-check.ts';

const addr = (n: number) => getAddress(padHex(toHex(n), { size: 20 }));
const SAFE = addr(0x5afe);
const SINGLETON = addr(0x51);
const U = addr(0xa1);
const R = addr(0xa2);
const S = addr(0xa3);
const code = (label: string): Hex => toHex(label);

const contracts = Object.fromEntries(
  SYSTEM_ROLES.map((role, i) => [role, { name: role, address: addr(0xc0 + i), codehash: keccak256(code(role)) }]),
) as unknown as SystemContracts['contracts'];
const pinned = {
  system: { contracts } as SystemContracts,
  chain: {
    safe: {
      singletonL2: SINGLETON,
      singletonL2Codehash: keccak256(code('singleton')),
      proxyRuntimeCodehash: keccak256(code('proxy')),
    },
  } as PinnedChain,
};

interface Chain {
  codes: Record<string, Hex>;
  slots: Record<string, Address>;
  threshold: bigint;
  registered: boolean;
  owners: Address[];
  roles: { userKey: Address; recoveryKey: Address; executor: Address };
}

function healthy(): Chain {
  const codes: Record<string, Hex> = { [SAFE]: code('proxy'), [SINGLETON]: code('singleton') };
  for (const role of SYSTEM_ROLES) codes[contracts[role].address] = code(role);
  return {
    codes,
    slots: {
      [SAFE_SLOTS.singleton]: SINGLETON,
      [SAFE_SLOTS.guard]: contracts.guard.address,
      [SAFE_SLOTS.moduleGuard]: contracts.moduleGuard.address,
    },
    threshold: 2n,
    registered: true,
    owners: [U, R, S],
    roles: { userKey: U, recoveryKey: R, executor: S },
  };
}

function reader(chain: Chain) {
  return {
    getCode: ({ address }: { address: Address }) => Promise.resolve(chain.codes[getAddress(address)]),
    getStorageAt: ({ slot }: { slot: Hex }) => Promise.resolve(padHex(chain.slots[slot] ?? '0x', { size: 32 })),
    readContract: ({ functionName }: { functionName: string }) =>
      Promise.resolve(
        (
          {
            getThreshold: chain.threshold,
            isRegistered: chain.registered,
            getOwners: chain.owners,
            rolesOf: { initialized: true, ...chain.roles },
          } as Record<string, unknown>
        )[functionName],
      ),
  } as never;
}

describe('checkSafe', () => {
  it('con todo lo fijado: sin fallas, roles y owners leídos de la cadena', async () => {
    const checked = await requireSafe(reader(healthy()), pinned, SAFE, { recoveryKey: R });
    expect(checked).toEqual({
      safe: SAFE,
      roles: { userKey: U, recoveryKey: R, executor: S },
      owners: [U, R, S],
      failures: [],
    });
  });

  it.each([
    ['CODEHASH_TIMELOCK', (c: Chain) => void (c.codes[contracts.timelock.address] = code('otro'))],
    ['SINGLETON', (c: Chain) => void (c.slots[SAFE_SLOTS.singleton] = addr(0x52))],
    ['SINGLETON_CODEHASH', (c: Chain) => void (c.codes[SINGLETON] = code('otro singleton'))],
    ['GUARD', (c: Chain) => void (c.slots[SAFE_SLOTS.guard] = addr(0x99))],
    ['MODULE_GUARD', (c: Chain) => void (c.slots[SAFE_SLOTS.moduleGuard] = addr(0))],
    ['THRESHOLD', (c: Chain) => void (c.threshold = 1n)],
    ['NOT_REGISTERED', (c: Chain) => void (c.registered = false)],
    ['OWNERS', (c: Chain) => void (c.owners = [U, R, addr(0xbad)])],
    ['RECOVERY_KEY', (c: Chain) => void (c.roles = { userKey: U, recoveryKey: S, executor: R })],
  ])('%s', async (item, mutate) => {
    const chain = healthy();
    mutate(chain);
    const checked = await checkSafe(reader(chain), pinned, SAFE, { recoveryKey: R });
    expect(checked.failures).toContain(item);
    await expect(requireSafe(reader(chain), pinned, SAFE, { recoveryKey: R })).rejects.toBeInstanceOf(SafeCheckError);
  });

  it('una dirección que no es un proxy de Safe: no se leen owners ni roles', async () => {
    const chain = healthy();
    chain.codes[SAFE] = '0x';
    const checked = await checkSafe(reader(chain), pinned, SAFE);
    expect(checked.failures).toEqual(
      expect.arrayContaining(['SAFE_PROXY_CODEHASH', 'THRESHOLD', 'NOT_REGISTERED', 'OWNERS']),
    );
    expect(checked.owners).toEqual([]);
  });

  it('textos de cada ítem', () => {
    expect(safeFailureText('CODEHASH_SWAPEXECUTOR')).toBe(
      'el contrato del sistema swapexecutor no tiene el código fijado',
    );
    expect(safeFailureText('RECOVERY_KEY')).toBe('tu clave R no es la clave de recuperación de esta Safe');
    expect(safeFailureText('OTRO')).toBe('OTRO');
  });
});

describe('timelock y nonce on-chain', () => {
  const TIMELOCK = addr(0x71);
  const id = (n: number) => padHex(toHex(n), { size: 32 });
  it('una propuesta pendiente por tipo; las de otra Safe o ya resueltas no cuentan', async () => {
    const proposals: Record<string, { safe: Address; kind: number; status: number }> = {
      [id(1)]: { safe: SAFE, kind: 0, status: 1 },
      [id(2)]: { safe: addr(0x123), kind: 2, status: 1 },
      [id(3)]: { safe: SAFE, kind: 3, status: 2 },
    };
    const active = [id(1), id(0), id(2), id(3), id(0)];
    const chain = {
      readContract: ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName === 'activeProposal') return Promise.resolve(active[Number(args[1])]);
        if (functionName === 'nonce') return Promise.resolve(9n);
        const proposal = proposals[String(args[0])];
        return Promise.resolve({
          ...proposal,
          oldValue: U,
          newValue: addr(0xa9),
          createdAt: 1_800_000_000n,
          executableAt: 1_800_172_800n,
        });
      },
    } as never;
    const pending = await pendingProposals(chain, TIMELOCK, SAFE);
    expect(pending).toEqual([
      {
        id: id(1),
        kind: 'U',
        oldValue: U,
        newValue: addr(0xa9),
        createdAt: new Date(1_800_000_000_000),
        executableAt: new Date(1_800_172_800_000),
      },
    ]);
    expect(await safeNonce(chain, SAFE)).toBe(9n);
  });
});
