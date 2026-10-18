// P18.T11: la Safe destino de la migración se acepta sólo si la creó la factory, está registrada en el Guard con la
// misma U y owners = roles, y la autorización de migración está activa en el PolicyRegistry.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES, type SystemContracts } from '../config/system-contracts.ts';
import { MigrationCheckError, tokenBalance, verifyMigrationTarget } from './migration.ts';

const a = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const system = {
  contracts: Object.fromEntries(
    SYSTEM_ROLES.map((role, i) => [role, { name: role, address: a(0x100 + i), codehash: '0x' }]),
  ),
} as unknown as Pick<SystemContracts, 'contracts'>;
const U = a(0xaa1);
const roles = { userKey: U, recoveryKey: a(0xaa2), executor: a(0xaa3), initialized: true };

function reader(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    isWallet: true,
    isRegistered: true,
    rolesOf: roles,
    getOwners: [roles.userKey, roles.recoveryKey, roles.executor],
    isMigrationAuthorized: true,
    balanceOf: 42n,
    ...overrides,
  };
  return {
    readContract: ({ functionName }: { functionName: string }) => Promise.resolve(values[functionName]),
  } as never;
}

const input = { oldSafe: a(0x1), newSafe: a(0x2), userKey: U };
const itemsOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MigrationCheckError) return error.items;
    throw error;
  }
  return [];
};

describe('Safe destino de la migración', () => {
  it('verifica y devuelve los roles', async () => {
    await expect(verifyMigrationTarget(reader(), system, input)).resolves.toEqual({
      roles: { userKey: U, recoveryKey: roles.recoveryKey, executor: roles.executor },
    });
    expect(await tokenBalance(reader(), a(0x5), input.oldSafe)).toBe(42n);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['no la creó la factory', { isWallet: false }, ['NOT_A_FACTORY_WALLET']],
    ['no registrada en el Guard', { isRegistered: false }, ['NOT_REGISTERED']],
    ['con otra U', { rolesOf: { ...roles, userKey: a(0xbb1) } }, ['USER_KEY', 'OWNERS']],
    ['owners que no son los roles', { getOwners: [U, roles.recoveryKey, a(0xcc1)] }, ['OWNERS']],
    ['sin la autorización activa', { isMigrationAuthorized: false }, ['NOT_AUTHORIZED']],
  ])('rechaza una Safe destino %s', async (_label, overrides, items) => {
    expect(await itemsOf(verifyMigrationTarget(reader(overrides), system, input))).toEqual(items);
  });

  it('la Safe destino no puede ser la vieja', async () => {
    expect(await itemsOf(verifyMigrationTarget(reader(), system, { ...input, newSafe: input.oldSafe }))).toEqual([
      'SAME_SAFE',
    ]);
  });
});
