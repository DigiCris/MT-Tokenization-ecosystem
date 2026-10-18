// Lecturas on-chain propias de la app con el RPC del frontend y los contratos fijados en el build ([F-SEC-08]): nunca se
// confía en lo que informe el backend sobre quién es U. El Guard instalado se lee del storage de la Safe y tiene que ser
// el SecurityGuard fijado; sus roles (`rolesOf`) dicen la U vigente ([F-KEY-10]: no se restaura una clave cuya
// dirección no coincida con el rol U on-chain).
import { getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import type { SystemContracts } from '../config/system-contracts.ts';
import type { BaseClient } from './client.ts';

export { frontendClient, type BaseClient } from './client.ts';

/** keccak256("guard_manager.guard.address"): slot del Guard en una Safe v1.5. */
export const SAFE_GUARD_SLOT: Hex = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';

const securityGuardAbi = [
  {
    type: 'function',
    name: 'rolesOf',
    stateMutability: 'view',
    inputs: [{ name: 'safe', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'userKey', type: 'address' },
          { name: 'recoveryKey', type: 'address' },
          { name: 'executor', type: 'address' },
          { name: 'initialized', type: 'bool' },
        ],
      },
    ],
  },
] as const;

const walletFactoryAbi = [
  {
    type: 'function',
    name: 'isWallet',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface OnchainRoles {
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
}

export class OnchainCheckError extends Error {
  override name = 'OnchainCheckError';
}

export async function onchainRoles(
  reader: Pick<BaseClient, 'getStorageAt' | 'readContract' | 'getChainId'>,
  contracts: SystemContracts['contracts'],
  safe: Address,
): Promise<OnchainRoles> {
  if ((await reader.getChainId()) !== base.id) throw new OnchainCheckError('El RPC no es de Base (8453)');
  const slot = await reader.getStorageAt({ address: safe, slot: SAFE_GUARD_SLOT });
  const guard = getAddress(`0x${(slot ?? '0x').slice(-40).padStart(40, '0')}`);
  if (!isAddressEqual(guard, contracts.guard.address)) {
    throw new OnchainCheckError('La Safe no tiene instalado el Guard del sistema fijado en esta versión de la app');
  }
  const [roles, isWallet] = await Promise.all([
    reader.readContract({
      address: contracts.guard.address,
      abi: securityGuardAbi,
      functionName: 'rolesOf',
      args: [safe],
    }),
    reader.readContract({
      address: contracts.factory.address,
      abi: walletFactoryAbi,
      functionName: 'isWallet',
      args: [safe],
    }),
  ]);
  if (!isWallet || !roles.initialized) throw new OnchainCheckError('La Safe no es una wallet registrada del sistema');
  return {
    userKey: getAddress(roles.userKey),
    recoveryKey: getAddress(roles.recoveryKey),
    executor: getAddress(roles.executor),
  };
}
