// Whitelist (P18.T05, [C-WL]): la lista sale de la cadena (DestinationWhitelist.destinationsOf + destinationInfo por el
// RPC propio) y del backend sólo los labels (texto); un destino se ofrece para enviar únicamente si está activo
// on-chain (24 h después del alta). El alta y la baja son SafeTx del camino asistido que la app arma por su cuenta.
// Hasta que el backend indexa el alta, el label de un destino recién agregado está en su pedido en curso.
import { encodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import type { WhitelistEntry, WhitelistRequest } from '../api/wallet-api.ts';
import { destinationWhitelistAbi } from '../chain/abis/DestinationWhitelist.ts';
import type { BaseClient } from '../chain/client.ts';
import { assistedCall, type SafeTx } from '../chain/safe-tx.ts';

export interface Destination {
  address: Address;
  label: string | null;
  active: boolean;
  /** Momento on-chain en que se activa (o se activó). */
  activatesAt: Date;
}

export class DestinationError extends Error {
  override name = 'DestinationError';
}

/** Dirección escrita por el usuario: EIP-55 válido o toda en minúsculas; nunca la dirección cero. */
export function parseDestination(text: string): Address {
  const value = text.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new DestinationError('Escribí una dirección de Base (0x y 40 caracteres).');
  const mixed = value !== value.toLowerCase() && value.slice(2) !== value.slice(2).toUpperCase();
  if (mixed && !isAddress(value, { strict: true })) {
    throw new DestinationError('La dirección tiene un error de tipeo (el checksum EIP-55 no coincide).');
  }
  const address = getAddress(value.toLowerCase());
  if (isAddressEqual(address, zeroAddress)) throw new DestinationError('La dirección cero no es un destino válido.');
  return address;
}

/** Pedidos cuyo alta ya se firmó o se está indexando: su label vale mientras no exista la entrada. */
const IN_FLIGHT: readonly WhitelistRequest['status'][] = ['AWAITING_SIGNATURE', 'SUBMITTED', 'ACTIVATING'];

export interface BackendLabels {
  entries: readonly WhitelistEntry[];
  requests?: readonly WhitelistRequest[];
}

function labelOf(backend: BackendLabels, destination: Address): string | null {
  const entry = backend.entries.find((e) => isAddressEqual(e.destination, destination) && e.status !== 'REMOVED');
  if (entry) return entry.label;
  const request = backend.requests?.find(
    (r) => isAddressEqual(r.destination, destination) && IN_FLIGHT.includes(r.status),
  );
  return request?.label ?? null;
}

export async function readWhitelist(
  reader: Pick<BaseClient, 'readContract'>,
  whitelist: Address,
  safe: Address,
  backend: BackendLabels = { entries: [] },
): Promise<Destination[]> {
  const destinations = await reader.readContract({
    address: whitelist,
    abi: destinationWhitelistAbi,
    functionName: 'destinationsOf',
    args: [safe],
  });
  const infos = await Promise.all(
    destinations.map((destination) =>
      reader.readContract({
        address: whitelist,
        abi: destinationWhitelistAbi,
        functionName: 'destinationInfo',
        args: [safe, destination],
      }),
    ),
  );
  return destinations
    .map((destination, i) => {
      const [exists, activatesAt, active] = infos[i] ?? [false, 0n, false];
      return {
        exists,
        destination: getAddress(destination),
        label: labelOf(backend, destination),
        active,
        activatesAt,
      };
    })
    .filter((d) => d.exists)
    .map((d) => ({
      address: d.destination,
      label: d.label,
      active: d.active,
      activatesAt: new Date(Number(d.activatesAt) * 1000),
    }));
}

/** Destinos agregados que todavía no se activaron (la alerta in-app de ADR-006: si no lo agregaste vos, quitalo). */
export function activating(destinations: readonly Destination[]): Destination[] {
  return destinations.filter((d) => !d.active);
}

/** Cuánto falta para que se active un destino, medido con la hora de la cadena (null: todavía sin leerla). */
export function activationText(activatesAt: Date, chainNowMs: number | null): string {
  if (chainNowMs === null) return `se activa el ${activatesAt.toLocaleString('es-AR')}`;
  const ms = activatesAt.getTime() - chainNowMs;
  if (ms <= 0) return 'ya se activó';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `se activa en ${String(hours)} h ${String(minutes)} min`;
}

/** El destino está activo on-chain para esta Safe (lo único que habilita un envío). */
export async function isActiveDestination(
  reader: Pick<BaseClient, 'readContract'>,
  whitelist: Address,
  safe: Address,
  destination: Address,
): Promise<boolean> {
  return reader.readContract({
    address: whitelist,
    abi: destinationWhitelistAbi,
    functionName: 'isWhitelisted',
    args: [safe, destination],
  });
}

export function addDestinationCall(whitelist: Address, destination: Address, nonce: bigint): SafeTx {
  return assistedCall(
    whitelist,
    encodeFunctionData({ abi: destinationWhitelistAbi, functionName: 'addDestination', args: [destination] }),
    nonce,
  );
}

export function removeDestinationCall(whitelist: Address, destination: Address, nonce: bigint): SafeTx {
  return assistedCall(
    whitelist,
    encodeFunctionData({ abi: destinationWhitelistAbi, functionName: 'removeDestination', args: [destination] }),
    nonce,
  );
}
