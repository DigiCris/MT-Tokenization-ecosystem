// Acciones soberanas tipadas de la herramienta (las mismas que el modo soberano de Recovery, ADR-004): transferir todo
// el saldo de USDC, USDT o ETH a una dirección elegida, reemplazar una clave owner (p. ej. S), retirar el Guard o el
// module guard y anular un nonce (NoOp). Cada una arma su SafeTx con el nonce leído del RPC y su descripción legible
// sale de los mismos parámetros (no de bytes ajenos).
import { encodeFunctionData, erc20Abi, getAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import { call, SAFE_ABI, type SafeTx } from './safe-tx.ts';

/** Tokens de Base fijados en la herramienta (config/chains/base-mainnet.json). */
export const TOKENS = {
  USDC: { address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), decimals: 6 },
  USDT: { address: getAddress('0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'), decimals: 6 },
} as const;

export type Asset = keyof typeof TOKENS | 'ETH';

export const SENTINEL: Address = '0x0000000000000000000000000000000000000001';

export class ActionError extends Error {
  override name = 'ActionError';
}

export interface Typed {
  tx: SafeTx;
  description: string;
}

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${(value / base).toString()}${fraction === '' ? '' : `,${fraction}`}`;
}

/** Todo el saldo de un activo a una dirección (el saldo lo lee la herramienta del RPC). */
export function transferAll(safe: Address, asset: Asset, destination: Address, balance: bigint, nonce: bigint): Typed {
  if (balance <= 0n) throw new ActionError(`La Safe no tiene saldo de ${asset}.`);
  if (isAddressEqual(destination, zeroAddress) || isAddressEqual(destination, safe)) {
    throw new ActionError('El destino no puede ser la dirección cero ni la misma Safe.');
  }
  const to = getAddress(destination);
  if (asset === 'ETH') {
    return { tx: call(to, '0x', nonce, balance), description: `Enviar ${formatUnits(balance, 18)} ETH a ${to}` };
  }
  const token = TOKENS[asset];
  return {
    tx: call(
      token.address,
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, balance] }),
      nonce,
    ),
    description: `Enviar ${formatUnits(balance, token.decimals)} ${asset} a ${to}`,
  };
}

/** El owner anterior en la lista enlazada de la Safe (getOwners devuelve el orden de la lista). */
export function previousOwner(owners: readonly Address[], owner: Address): Address {
  const index = owners.findIndex((o) => isAddressEqual(o, owner));
  if (index < 0) throw new ActionError(`${owner} no es owner de la Safe.`);
  return index === 0 ? SENTINEL : (owners[index - 1] ?? SENTINEL);
}

/** Reemplaza un owner por otra dirección (swapOwner con el owner anterior leído del RPC). */
export function replaceOwner(
  safe: Address,
  owners: readonly Address[],
  oldOwner: Address,
  newOwner: Address,
  nonce: bigint,
): Typed {
  const next = getAddress(newOwner);
  if (owners.some((o) => isAddressEqual(o, next)) || isAddressEqual(next, zeroAddress) || isAddressEqual(next, safe)) {
    throw new ActionError('La clave nueva tiene que ser una dirección nueva (no un owner actual, la cero ni la Safe).');
  }
  const prev = previousOwner(owners, oldOwner);
  return {
    tx: call(
      safe,
      encodeFunctionData({ abi: SAFE_ABI, functionName: 'swapOwner', args: [prev, getAddress(oldOwner), next] }),
      nonce,
    ),
    description: `Reemplazar en la Safe la clave ${getAddress(oldOwner)} por ${next}`,
  };
}

/** Retira el Guard o el module guard de la Safe (dirección cero). */
export function removeGuard(safe: Address, kind: 'GUARD' | 'MODULE_GUARD', nonce: bigint): Typed {
  const functionName = kind === 'GUARD' ? 'setGuard' : 'setModuleGuard';
  return {
    tx: call(safe, encodeFunctionData({ abi: SAFE_ABI, functionName, args: [zeroAddress] }), nonce),
    description: kind === 'GUARD' ? 'Retirar el Guard de la Safe' : 'Retirar el guard de módulos de la Safe',
  };
}

/** NoOp: Safe → Safe sin datos, ocupa el nonce actual (anula una operación pendiente con ese nonce). */
export function noop(safe: Address, nonce: bigint): Typed {
  return {
    tx: call(safe, '0x', nonce),
    description: `Anular la operación pendiente con nonce ${nonce.toString()} (NoOp)`,
  };
}
