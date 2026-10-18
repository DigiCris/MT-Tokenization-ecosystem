// Migración excepcional en Wallet (P18.T11, `/security/migration`): antes de que U firme cada MIGRATION_TRANSFER la app
// verifica por el RPC propio la Safe destino —creada por la factory fijada, registrada en el Guard con la misma U
// (y owners = roles), y la autorización `PolicyRegistry.isMigrationAuthorized(vieja, nueva)` activa— y arma ella misma
// cada transfer del saldo completo leído on-chain hacia la Safe nueva.
import { erc20Abi, isAddressEqual, type Address } from 'viem';
import { policyRegistryAbi } from '../chain/abis/PolicyRegistry.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { walletFactoryAbi } from '../chain/abis/WalletFactory.ts';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import type { BaseClient } from '../chain/client.ts';
import type { SystemContracts } from '../config/system-contracts.ts';

export class MigrationCheckError extends Error {
  override name = 'MigrationCheckError';
  readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super(`La Safe destino de la migración no verifica (${items.join(', ')}): no se firma nada.`);
    this.items = items;
  }
}

export async function verifyMigrationTarget(
  reader: Pick<BaseClient, 'readContract'>,
  system: Pick<SystemContracts, 'contracts'>,
  input: { oldSafe: Address; newSafe: Address; userKey: Address },
): Promise<{ roles: { userKey: Address; recoveryKey: Address; executor: Address } }> {
  const c = system.contracts;
  const [isWallet, registered, roles, owners, authorized] = await Promise.all([
    reader.readContract({
      address: c.factory.address,
      abi: walletFactoryAbi,
      functionName: 'isWallet',
      args: [input.newSafe],
    }),
    reader.readContract({
      address: c.guard.address,
      abi: securityGuardAbi,
      functionName: 'isRegistered',
      args: [input.newSafe],
    }),
    reader.readContract({
      address: c.guard.address,
      abi: securityGuardAbi,
      functionName: 'rolesOf',
      args: [input.newSafe],
    }),
    reader.readContract({ address: input.newSafe, abi: iSafeAbi, functionName: 'getOwners' }),
    reader.readContract({
      address: c.policyRegistry.address,
      abi: policyRegistryAbi,
      functionName: 'isMigrationAuthorized',
      args: [input.oldSafe, input.newSafe],
    }),
  ]);
  const problems: string[] = [];
  if (!isWallet) problems.push('NOT_A_FACTORY_WALLET');
  if (!registered || !roles.initialized) problems.push('NOT_REGISTERED');
  if (!isAddressEqual(roles.userKey, input.userKey)) problems.push('USER_KEY');
  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  const roleKeys = [roles.userKey, roles.recoveryKey, roles.executor];
  if (owners.length !== 3 || !roleKeys.every((k) => ownerSet.has(k.toLowerCase()))) problems.push('OWNERS');
  if (!authorized) problems.push('NOT_AUTHORIZED');
  if (isAddressEqual(input.oldSafe, input.newSafe)) problems.push('SAME_SAFE');
  if (problems.length > 0) throw new MigrationCheckError(problems);
  return { roles: { userKey: roles.userKey, recoveryKey: roles.recoveryKey, executor: roles.executor } };
}

/** Saldo completo del token en la Safe vieja (lo que tiene que transferir cada MIGRATION_TRANSFER). */
export function tokenBalance(reader: Pick<BaseClient, 'readContract'>, token: Address, safe: Address): Promise<bigint> {
  return reader.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [safe] });
}
