// Rotaciones (P18.T09, [C-RTL]): las pendientes se leen de la cadena (RotationTimelock.activeProposal + getProposal por
// el RPC propio, para los cinco tipos), no del backend. Cancelar es una firma EIP-712 `CancelRotation` de U que la app
// arma con el timelock fijado y el id leído on-chain (se manda al relay de la plataforma o se exporta para transmitirla
// con cualquier wallet: `cancelWithSignature`). Proponer y ejecutar son SafeTx del camino asistido que la app arma por
// su cuenta: `propose(kind, old, new)` al timelock y `swapOwner(prev, old, new)` (o `setGuard`/`setModuleGuard`) a la
// propia Safe, con `prev` calculado de la lista de owners on-chain.
import { encodeFunctionData, getAddress, hashTypedData, isAddressEqual, type Address, type Hex } from 'viem';
import type { CancelRotationTypedData, RotationRole } from '../../api/wallet-api.ts';
import { iSafeAbi } from '../../chain/abis/ISafe.ts';
import { rotationTimelockAbi } from '../../chain/abis/RotationTimelock.ts';
import type { BaseClient } from '../../chain/client.ts';
import { ROTATION_KINDS } from '../../chain/decoders.ts';
import { assistedCall, type SafeTx } from '../../chain/safe-tx.ts';
import { signDigest, withKey } from '../../crypto/sign.ts';
import { fromHex } from '../../crypto/bytes.ts';
import type { KeyEnvelope } from '../../crypto/envelope.ts';

export const SENTINEL_OWNER: Address = '0x0000000000000000000000000000000000000001';
const ZERO_ID = /^0x0{64}$/;

export interface PendingProposal {
  id: Hex;
  role: RotationRole;
  oldValue: Address;
  newValue: Address;
  createdAt: Date;
  executableAt: Date;
}

export class RotationCheckError extends Error {
  override name = 'RotationCheckError';
}

/** Propuestas pendientes de la Safe en el timelock (una por tipo como máximo), leídas por el RPC propio. */
export async function readPendingProposals(
  reader: Pick<BaseClient, 'readContract'>,
  timelock: Address,
  safe: Address,
): Promise<PendingProposal[]> {
  const ids = await Promise.all(
    ROTATION_KINDS.map((_, kind) =>
      reader.readContract({
        address: timelock,
        abi: rotationTimelockAbi,
        functionName: 'activeProposal',
        args: [safe, kind],
      }),
    ),
  );
  const pending = await Promise.all(
    ids.map(async (id, kind) => {
      if (ZERO_ID.test(id)) return null;
      const p = await reader.readContract({
        address: timelock,
        abi: rotationTimelockAbi,
        functionName: 'getProposal',
        args: [id],
      });
      if (!isAddressEqual(p.safe, safe)) return null;
      const role = ROTATION_KINDS[kind];
      if (role === undefined) return null;
      return {
        id,
        role,
        oldValue: getAddress(p.oldValue),
        newValue: getAddress(p.newValue),
        createdAt: new Date(Number(p.createdAt) * 1000),
        executableAt: new Date(Number(p.executableAt) * 1000),
      };
    }),
  );
  return pending.filter((p): p is PendingProposal => p !== null);
}

export const CANCEL_ROTATION_TYPES = {
  CancelRotation: [
    { name: 'proposalId', type: 'bytes32' },
    { name: 'safe', type: 'address' },
  ],
} as const;

/** Typed data propio de la cancelación (dominio del timelock fijado). */
export function cancelRotationTypedData(timelock: Address, proposalId: Hex, safe: Address) {
  return {
    domain: { name: 'MTW RotationTimelock', version: '1', chainId: 8453, verifyingContract: timelock },
    types: CANCEL_ROTATION_TYPES,
    primaryType: 'CancelRotation' as const,
    message: { proposalId, safe },
  };
}

/** El typed data que manda el backend tiene que ser el propio (si lo manda); la app firma siempre el propio. */
export function assertCancelTypedData(
  remote: CancelRotationTypedData | null,
  own: ReturnType<typeof cancelRotationTypedData>,
) {
  if (remote === null) return;
  const same =
    remote.domain.name === own.domain.name &&
    remote.domain.version === own.domain.version &&
    remote.domain.chainId === own.domain.chainId &&
    isAddressEqual(remote.domain.verifyingContract, own.domain.verifyingContract) &&
    remote.message.proposalId.toLowerCase() === own.message.proposalId.toLowerCase() &&
    isAddressEqual(remote.message.safe, own.message.safe);
  if (!same) throw new RotationCheckError('La cancelación que propone la plataforma no es la de esta propuesta.');
}

/** U firma la cancelación (descifrada sólo durante la firma). */
export async function signCancellation(
  key: { envelope: KeyEnvelope; encryptionKey: CryptoKey },
  typedData: ReturnType<typeof cancelRotationTypedData>,
): Promise<Hex> {
  const digest = hashTypedData(typedData);
  return withKey(key.envelope, key.encryptionKey, (privateKey) => signDigest(fromHex(digest), privateKey));
}

export function proposeCall(
  timelock: Address,
  role: RotationRole,
  oldValue: Address,
  newValue: Address,
  nonce: bigint,
): SafeTx {
  const kind = ROTATION_KINDS.indexOf(role);
  return assistedCall(
    timelock,
    encodeFunctionData({ abi: rotationTimelockAbi, functionName: 'propose', args: [kind, oldValue, newValue] }),
    nonce,
  );
}

/** Owner anterior en la lista enlazada de la Safe (`getOwners` devuelve el orden de la lista). */
export function previousOwner(owners: readonly Address[], owner: Address): Address {
  const index = owners.findIndex((o) => isAddressEqual(o, owner));
  if (index < 0) throw new RotationCheckError('La clave a rotar no es owner de la Safe.');
  return index === 0 ? SENTINEL_OWNER : getAddress(owners[index - 1] ?? SENTINEL_OWNER);
}

/** Ejecución de una rotación madura: swapOwner para U/R/S, setGuard/setModuleGuard para el upgrade del Guard. */
export function executeCall(
  safe: Address,
  proposal: Pick<PendingProposal, 'role' | 'oldValue' | 'newValue'>,
  owners: readonly Address[],
  nonce: bigint,
): SafeTx {
  if (proposal.role === 'GUARD' || proposal.role === 'MODULE_GUARD') {
    const functionName = proposal.role === 'GUARD' ? 'setGuard' : 'setModuleGuard';
    return assistedCall(safe, encodeFunctionData({ abi: iSafeAbi, functionName, args: [proposal.newValue] }), nonce);
  }
  const prev = previousOwner(owners, proposal.oldValue);
  return assistedCall(
    safe,
    encodeFunctionData({
      abi: iSafeAbi,
      functionName: 'swapOwner',
      args: [prev, proposal.oldValue, proposal.newValue],
    }),
    nonce,
  );
}
