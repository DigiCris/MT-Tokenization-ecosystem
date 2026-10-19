// P19.T10: la migración con R sana. La Safe destino tiene que ser de la factory, estar registrada en el Guard con la
// misma R, tener owners = roles y la autorización del PolicyRegistry; cada transfer tiene que ser de USDC o USDT hacia la
// Safe nueva y la que arma la app es la del vector MIGRATION_TRANSFER.
import { encodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import safeTxVectors from '../../test/vectors/safe-tx.json' with { type: 'json' };
import { plainCall, safeTxHash } from '../chain/safe-tx.ts';
import { pinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { MigrationCheckError, migrationToken, migrationTransferCall, verifyMigrationTarget } from './migration.ts';

const safe = safeTxVectors.safe as Address;
const migration = safeTxVectors.operations.find((o) => o.opType === 'MIGRATION_TRANSFER');
if (!migration) throw new Error('falta el vector MIGRATION_TRANSFER');
const newSafe = getAddress(`0x${migration.data.slice(34, 74)}`);
const amount = BigInt(`0x${migration.data.slice(74)}`);

const R = getAddress('0x00000000000000000000000000000000000000a2');
const U = getAddress('0x00000000000000000000000000000000000000a1');
const S = getAddress('0x00000000000000000000000000000000000000a3');
const system = {
  contracts: {
    factory: { address: getAddress('0x00000000000000000000000000000000000000f1') },
    guard: { address: getAddress('0x00000000000000000000000000000000000000f2') },
    policyRegistry: { address: getAddress('0x00000000000000000000000000000000000000f3') },
  },
} as unknown as Pick<SystemContracts, 'contracts'>;

function reader(overrides: Partial<Record<string, unknown>> = {}) {
  const values: Record<string, unknown> = {
    isWallet: true,
    isRegistered: true,
    rolesOf: { initialized: true, userKey: U, recoveryKey: R, executor: S },
    getOwners: [U, R, S],
    isMigrationAuthorized: true,
    ...overrides,
  };
  return {
    readContract: ({ functionName }: { functionName: string }) => Promise.resolve(values[functionName]),
  } as never;
}

describe('Safe destino de la migración', () => {
  it('verifica y devuelve los roles de la Safe nueva', async () => {
    await expect(verifyMigrationTarget(reader(), system, { oldSafe: safe, newSafe, recoveryKey: R })).resolves.toEqual({
      userKey: U,
      recoveryKey: R,
      executor: S,
    });
  });

  it.each([
    ['NOT_A_FACTORY_WALLET', { isWallet: false }],
    ['NOT_REGISTERED', { isRegistered: false }],
    ['RECOVERY_KEY', { rolesOf: { initialized: true, userKey: U, recoveryKey: S, executor: R } }],
    ['OWNERS', { getOwners: [U, R] }],
    ['NOT_AUTHORIZED', { isMigrationAuthorized: false }],
  ])('%s: no se firma nada', async (item, overrides) => {
    const check = verifyMigrationTarget(reader(overrides), system, { oldSafe: safe, newSafe, recoveryKey: R });
    await expect(check).rejects.toThrow(MigrationCheckError);
    await expect(check).rejects.toMatchObject({ items: expect.arrayContaining([item]) as unknown });
  });

  it('la misma Safe no es un destino', async () => {
    await expect(
      verifyMigrationTarget(reader(), system, { oldSafe: newSafe, newSafe, recoveryKey: R }),
    ).rejects.toMatchObject({ items: ['SAME_SAFE'] });
  });
});

describe('transferencias de la migración', () => {
  it('la que arma la app es la del vector (saldo completo a la Safe nueva)', () => {
    const tx = migrationTransferCall(pinnedChain.tokens.USDC, newSafe, amount, BigInt(migration.nonce));
    expect(tx.data).toBe(migration.data);
    expect(safeTxHash(8453, safe, tx)).toBe(migration.safeTxHash);
    expect(migrationToken(tx, pinnedChain, newSafe)).toEqual(pinnedChain.tokens.USDC);
  });

  it('a otra dirección, de otro contrato o sin transfer: no es una transferencia de migración', () => {
    const other = getAddress('0x00000000000000000000000000000000000000b0');
    const toOther = migrationTransferCall(pinnedChain.tokens.USDT, other, amount, 1n);
    expect(() => migrationToken(toOther, pinnedChain, newSafe)).toThrow(MigrationCheckError);
    const approve = plainCall(
      pinnedChain.tokens.USDC.address,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [newSafe, amount] }),
      1n,
    );
    expect(() => migrationToken(approve, pinnedChain, newSafe)).toThrow(MigrationCheckError);
    const notToken = { ...migrationTransferCall(pinnedChain.tokens.USDC, newSafe, amount, 1n), to: other };
    expect(() => migrationToken(notToken, pinnedChain, newSafe)).toThrow(MigrationCheckError);
    const delegate = { ...migrationTransferCall(pinnedChain.tokens.USDC, newSafe, amount, 1n), operation: 1 as const };
    expect(() => migrationToken(delegate, pinnedChain, newSafe)).toThrow(MigrationCheckError);
  });
});
