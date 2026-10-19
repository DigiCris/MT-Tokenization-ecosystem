// Rotaciones por el RotationTimelock (P19.T04/T05, [C-GRD-11/12]): propuestas pendientes leídas on-chain (una activa
// por tipo), llamadas que arma la app para proponer y ejecutar (swapOwner con el owner anterior de la lista enlazada de
// la Safe; setGuard/setModuleGuard para los guards) y el typed data de la cancelación individual.
import { encodeFunctionData, getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { iSafeAbi } from './abis/ISafe.ts';
import { rotationTimelockAbi } from './abis/RotationTimelock.ts';
import { securityGuardAbi } from './abis/SecurityGuard.ts';
import type { ChainReader } from './client.ts';
import { plainCall, type SafeTx } from './safe-tx.ts';

/** RotationKind del timelock (contracts/src/libraries/Roles.sol), en ese orden. */
export const ROTATION_KINDS = ['U', 'R', 'S', 'GUARD', 'MODULE_GUARD'] as const;
export type RotationKind = (typeof ROTATION_KINDS)[number];

export const SENTINEL_OWNER: Address = '0x0000000000000000000000000000000000000001';
const ZERO_ID = /^0x0{64}$/;

export interface PendingProposal {
  id: Hex;
  kind: RotationKind;
  oldValue: Address;
  newValue: Address;
  createdAt: Date;
  executableAt: Date;
}

export class RotationError extends Error {
  override name = 'RotationError';
}

type Reader = Pick<ChainReader, 'readContract'>;

/** Propuestas pendientes de la Safe, una por tipo, leídas del timelock. */
export async function pendingProposals(reader: Reader, timelock: Address, safe: Address): Promise<PendingProposal[]> {
  const found = await Promise.all(
    ROTATION_KINDS.map(async (kind, index) => {
      const id = await reader.readContract({
        address: timelock,
        abi: rotationTimelockAbi,
        functionName: 'activeProposal',
        args: [safe, index],
      });
      if (ZERO_ID.test(id)) return null;
      const proposal = await reader.readContract({
        address: timelock,
        abi: rotationTimelockAbi,
        functionName: 'getProposal',
        args: [id],
      });
      if (!isAddressEqual(proposal.safe, safe) || proposal.status !== 1) return null;
      return {
        id,
        kind,
        oldValue: getAddress(proposal.oldValue),
        newValue: getAddress(proposal.newValue),
        createdAt: new Date(Number(proposal.createdAt) * 1000),
        executableAt: new Date(Number(proposal.executableAt) * 1000),
      } satisfies PendingProposal;
    }),
  );
  return found.filter((p): p is PendingProposal => p !== null);
}

export interface SafeRoles {
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
}

export async function readRoles(reader: Reader, guard: Address, safe: Address): Promise<SafeRoles> {
  const roles = await reader.readContract({
    address: guard,
    abi: securityGuardAbi,
    functionName: 'rolesOf',
    args: [safe],
  });
  return {
    userKey: getAddress(roles.userKey),
    recoveryKey: getAddress(roles.recoveryKey),
    executor: getAddress(roles.executor),
  };
}

export function safeNonce(reader: Reader, safe: Address): Promise<bigint> {
  return reader.readContract({ address: safe, abi: iSafeAbi, functionName: 'nonce' });
}

export async function safeOwners(reader: Reader, safe: Address): Promise<Address[]> {
  const owners = await reader.readContract({ address: safe, abi: iSafeAbi, functionName: 'getOwners' });
  return owners.map((owner) => getAddress(owner));
}

export function proposeCall(
  timelock: Address,
  kind: RotationKind,
  oldValue: Address,
  newValue: Address,
  nonce: bigint,
): SafeTx {
  return plainCall(
    timelock,
    encodeFunctionData({
      abi: rotationTimelockAbi,
      functionName: 'propose',
      args: [ROTATION_KINDS.indexOf(kind), oldValue, newValue],
    }),
    nonce,
  );
}

/** Owner anterior en la lista enlazada de la Safe (`getOwners` respeta ese orden; el primero tiene al centinela). */
export function previousOwner(owners: readonly Address[], owner: Address): Address {
  const index = owners.findIndex((o) => isAddressEqual(o, owner));
  if (index < 0) throw new RotationError('La clave a rotar no es owner de la Safe.');
  return index === 0 ? SENTINEL_OWNER : getAddress(owners[index - 1] ?? SENTINEL_OWNER);
}

/** Ejecución de una rotación madura: swapOwner para U/R/S; setGuard/setModuleGuard para los guards. */
export function executeCall(
  safe: Address,
  proposal: Pick<PendingProposal, 'kind' | 'oldValue' | 'newValue'>,
  owners: readonly Address[],
  nonce: bigint,
): SafeTx {
  if (proposal.kind === 'GUARD' || proposal.kind === 'MODULE_GUARD') {
    const functionName = proposal.kind === 'GUARD' ? 'setGuard' : 'setModuleGuard';
    return plainCall(safe, encodeFunctionData({ abi: iSafeAbi, functionName, args: [proposal.newValue] }), nonce);
  }
  return plainCall(
    safe,
    encodeFunctionData({
      abi: iSafeAbi,
      functionName: 'swapOwner',
      args: [previousOwner(owners, proposal.oldValue), proposal.oldValue, proposal.newValue],
    }),
    nonce,
  );
}

/** Calldata de `cancelWithSignature(proposalId, firma)` para transmitirla con cualquier cuenta. */
export function cancelWithSignatureData(proposalId: Hex, signature: Hex): Hex {
  return encodeFunctionData({
    abi: rotationTimelockAbi,
    functionName: 'cancelWithSignature',
    args: [proposalId, signature],
  });
}
