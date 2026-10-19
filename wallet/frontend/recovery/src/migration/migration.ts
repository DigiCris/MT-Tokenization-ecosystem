// Migración excepcional en Recovery (P19.T10, `/migration`), cuando la credencial sana es R: antes de que R firme cada
// MIGRATION_TRANSFER la app verifica por el RPC propio la Safe destino —creada por la factory fijada, registrada en el
// Guard con la misma R, owners = roles y `PolicyRegistry.isMigrationAuthorized(vieja, nueva)` activa— y arma ella
// misma cada transfer del saldo completo leído on-chain hacia la Safe nueva.
import { decodeFunctionData, encodeFunctionData, erc20Abi, isAddressEqual, type Address } from 'viem';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { policyRegistryAbi } from '../chain/abis/PolicyRegistry.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { walletFactoryAbi } from '../chain/abis/WalletFactory.ts';
import type { ChainReader } from '../chain/client.ts';
import { plainCall, type SafeTx } from '../chain/safe-tx.ts';
import type { PinnedChain, PinnedToken } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';

type Reader = Pick<ChainReader, 'readContract'>;

export class MigrationCheckError extends Error {
  override name = 'MigrationCheckError';
  readonly items: readonly string[];

  constructor(items: readonly string[]) {
    super(`La Safe destino de la migración no verifica (${items.join(', ')}): no se firma nada.`);
    this.items = items;
  }
}

export interface MigrationRoles {
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
}

export async function verifyMigrationTarget(
  reader: Reader,
  system: Pick<SystemContracts, 'contracts'>,
  input: { oldSafe: Address; newSafe: Address; recoveryKey: Address },
): Promise<MigrationRoles> {
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
  if (!isAddressEqual(roles.recoveryKey, input.recoveryKey)) problems.push('RECOVERY_KEY');
  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  const roleKeys = [roles.userKey, roles.recoveryKey, roles.executor];
  if (owners.length !== 3 || !roleKeys.every((k) => ownerSet.has(k.toLowerCase()))) problems.push('OWNERS');
  if (!authorized) problems.push('NOT_AUTHORIZED');
  if (isAddressEqual(input.oldSafe, input.newSafe)) problems.push('SAME_SAFE');
  if (problems.length > 0) throw new MigrationCheckError(problems);
  return { userKey: roles.userKey, recoveryKey: roles.recoveryKey, executor: roles.executor };
}

/** El token de una SafeTx que tiene que ser `transfer(nuevaSafe, …)` de USDC o USDT; si es otra cosa, no se firma. */
export function migrationToken(tx: SafeTx, chain: Pick<PinnedChain, 'tokens'>, newSafe: Address): PinnedToken {
  const token = Object.values(chain.tokens).find((t) => isAddressEqual(t.address, tx.to));
  let recipient: Address | null = null;
  if (token && tx.operation === 0 && tx.value === 0n) {
    try {
      const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (call.functionName === 'transfer') [recipient] = call.args;
    } catch {
      recipient = null;
    }
  }
  if (!token || recipient === null || !isAddressEqual(recipient, newSafe)) {
    throw new MigrationCheckError(['NOT_A_TRANSFER_TO_NEW_SAFE']);
  }
  return token;
}

/** Saldo completo del token en la Safe vieja (lo que tiene que transferir cada MIGRATION_TRANSFER). */
export function tokenBalance(reader: Reader, token: Address, safe: Address): Promise<bigint> {
  return reader.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [safe] });
}

export function migrationTransferCall(token: PinnedToken, newSafe: Address, amount: bigint, nonce: bigint): SafeTx {
  return plainCall(
    token.address,
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [newSafe, amount] }),
    nonce,
  );
}
