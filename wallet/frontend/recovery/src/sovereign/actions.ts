// Acciones tipadas del modo soberano (P19.T06, ADR-004): lo que U + R pueden hacer con la Safe sin la plataforma, cada
// una como SafeTx que arma la app con el nonce leído on-chain. Transferir todo el saldo de un token a una dirección
// elegida; reemplazar S (dos documentos: swapOwner en la Safe y updateRoles en el Guard, nonces N y N+1); retirar o
// cambiar el Guard o el module guard; actualizar los roles del Guard; y la NoOp que ocupa un nonce pendiente.
import { encodeFunctionData, erc20Abi, getAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { securityGuardAbi } from '../chain/abis/SecurityGuard.ts';
import { previousOwner } from '../chain/rotations.ts';
import { plainCall, type SafeTx } from '../chain/safe-tx.ts';
import type { PinnedToken } from '../config/chain.ts';

export type SovereignActionType =
  | 'TRANSFER'
  | 'EXECUTOR_REPLACEMENT_SWAP'
  | 'EXECUTOR_REPLACEMENT_ROLES'
  | 'SET_GUARD'
  | 'SET_MODULE_GUARD'
  | 'UPDATE_ROLES'
  | 'NOOP';

export interface TypedSafeTx {
  tx: SafeTx;
  action: { type: SovereignActionType; params: Record<string, string> };
}

export class SovereignActionError extends Error {
  override name = 'SovereignActionError';
}

/** Todo el saldo de un token a una dirección elegida (el saldo lo lee la app on-chain). */
export function transferAll(token: PinnedToken, destination: Address, balance: bigint, nonce: bigint): TypedSafeTx {
  if (balance <= 0n) throw new SovereignActionError(`La Safe no tiene saldo de ${token.symbol}.`);
  if (isAddressEqual(destination, zeroAddress)) throw new SovereignActionError('La dirección cero no es un destino.');
  return {
    tx: plainCall(
      token.address,
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(destination), balance] }),
      nonce,
    ),
    action: {
      type: 'TRANSFER',
      params: { token: token.address, destination: getAddress(destination), amount: balance.toString() },
    },
  };
}

/**
 * Reemplazar S por S′ sin la plataforma: swapOwner(prev, S, S′) en la Safe (nonce N) y updateRoles(U, R, S′) en el Guard
 * (nonce N+1), en ese orden. Los roles y los owners los lee la app on-chain.
 */
export function replaceExecutor(
  safe: Address,
  guard: Address,
  roles: { userKey: Address; recoveryKey: Address; executor: Address },
  owners: readonly Address[],
  newExecutor: Address,
  nonce: bigint,
): [TypedSafeTx, TypedSafeTx] {
  const next = getAddress(newExecutor);
  if ([roles.userKey, roles.recoveryKey, roles.executor, safe, zeroAddress].some((a) => isAddressEqual(a, next))) {
    throw new SovereignActionError('S′ tiene que ser una dirección nueva, distinta de U, R, la S actual y la Safe.');
  }
  const prev = previousOwner(owners, roles.executor);
  return [
    {
      tx: plainCall(
        safe,
        encodeFunctionData({ abi: iSafeAbi, functionName: 'swapOwner', args: [prev, roles.executor, next] }),
        nonce,
      ),
      action: {
        type: 'EXECUTOR_REPLACEMENT_SWAP',
        params: { prevOwner: prev, oldExecutor: roles.executor, newExecutor: next },
      },
    },
    {
      tx: plainCall(
        guard,
        encodeFunctionData({
          abi: securityGuardAbi,
          functionName: 'updateRoles',
          args: [roles.userKey, roles.recoveryKey, next],
        }),
        nonce + 1n,
      ),
      action: {
        type: 'EXECUTOR_REPLACEMENT_ROLES',
        params: { userKey: roles.userKey, recoveryKey: roles.recoveryKey, executor: next },
      },
    },
  ];
}

/** Cambiar o retirar (dirección cero) el Guard o el module guard de la Safe. */
export function setGuard(safe: Address, kind: 'GUARD' | 'MODULE_GUARD', newGuard: Address, nonce: bigint): TypedSafeTx {
  const functionName = kind === 'GUARD' ? 'setGuard' : 'setModuleGuard';
  const value = getAddress(newGuard);
  return {
    tx: plainCall(safe, encodeFunctionData({ abi: iSafeAbi, functionName, args: [value] }), nonce),
    action: { type: kind === 'GUARD' ? 'SET_GUARD' : 'SET_MODULE_GUARD', params: { guard: value } },
  };
}

/** Actualizar los roles del Guard para que coincidan con los owners (después de un cambio soberano de owners). */
export function updateRoles(
  guard: Address,
  roles: { userKey: Address; recoveryKey: Address; executor: Address },
  nonce: bigint,
): TypedSafeTx {
  const keys = [roles.userKey, roles.recoveryKey, roles.executor].map((k) => getAddress(k));
  if (new Set(keys.map((k) => k.toLowerCase())).size !== 3)
    throw new SovereignActionError('U, R y S tienen que ser distintas.');
  const [userKey, recoveryKey, executor] = keys as [Address, Address, Address];
  return {
    tx: plainCall(
      guard,
      encodeFunctionData({
        abi: securityGuardAbi,
        functionName: 'updateRoles',
        args: [userKey, recoveryKey, executor],
      }),
      nonce,
    ),
    action: { type: 'UPDATE_ROLES', params: { userKey, recoveryKey, executor } },
  };
}

/** NoOp: Safe → Safe sin datos con un nonce dado (anula una operación pendiente que usa ese nonce). */
export function noop(safe: Address, nonce: bigint): TypedSafeTx {
  return { tx: plainCall(safe, '0x', nonce), action: { type: 'NOOP', params: { nonce: nonce.toString() } } };
}
