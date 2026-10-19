// Actividad (P18.T08): operaciones de la plataforma con su estado (incluidos MINED, CONFIRMED y FINALIZED) y los
// transfers entrantes y salientes indexados, en una sola lista ordenada por fecha, con el hash de la transacción y el
// link al explorer de la cadena (sólo un link: no se embebe nada de terceros). Cada operación dice qué hizo: con los
// transfers de su transacción si los hay (en un swap, lo que salió y lo que entró) y, si no llegó a la cadena, con la
// intención guardada al prepararla ("Envío: 1,00 USDC a …", sin un "de" que se lea como origen). La hora de una
// operación es la de su inclusión en un bloque (como la de un transfer indexado); sólo las que no llegaron a la red
// muestran la de preparación.
import type { Address } from 'viem';
import type { DecodedOperation, OperationStatus, Transfer } from '../api/wallet-api.ts';
import type { PinnedChain } from '../config/chain.ts';
import { ROLE_TEXT, tokenAmount, type DescriptionPart } from '../operations/describe.ts';
import type { NameOf } from '../operations/names.ts';

export type ActivityItem =
  | {
      kind: 'operation';
      at: Date;
      /** De qué es la hora: la inclusión en un bloque o, si la operación no llegó a la cadena, su preparación. */
      atKind: 'mined' | 'prepared';
      operation: OperationStatus;
      /** Transfers indexados de la transacción de la operación: los salientes y, en un swap, también el entrante. */
      transfers: Transfer[];
    }
  | { kind: 'transfer'; at: Date; transfer: Transfer };

function sameTx(operation: OperationStatus, transfer: Transfer): boolean {
  return operation.txHash !== null && operation.txHash.toLowerCase() === transfer.txHash.toLowerCase();
}

/** Un transfer que es parte de la operación: su saliente o, en un swap, también lo que llegó del pool. */
function belongsTo(operation: OperationStatus, transfer: Transfer): boolean {
  return sameTx(operation, transfer) && (transfer.direction === 'OUT' || operation.operationType === 'SWAP');
}

/** Momento en que la plataforma vio la operación incluida en un bloque (su historial). */
function minedAt(operation: OperationStatus): Date | null {
  const mined = operation.history.find((entry) => entry.status === 'MINED');
  return mined ? new Date(mined.at) : null;
}

/**
 * Una lista por fecha. Un transfer saliente que originó una operación de la plataforma (y el entrante de un swap) se
 * muestra dentro de esa operación (no dos veces); los salientes que la plataforma no originó (p. ej. una ejecución
 * soberana) y los demás entrantes son ítems propios.
 */
export function mergeActivity(operations: readonly OperationStatus[], transfers: readonly Transfer[]): ActivityItem[] {
  const folded = (t: Transfer) => operations.some((o) => belongsTo(o, t));
  const items: ActivityItem[] = [
    ...operations.map((operation) => {
      const mined = minedAt(operation);
      return {
        kind: 'operation' as const,
        at: mined ?? new Date(operation.createdAt),
        atKind: mined === null ? ('prepared' as const) : ('mined' as const),
        operation,
        transfers: transfers.filter((t) => belongsTo(operation, t)),
      };
    }),
    ...transfers
      .filter((t) => !folded(t))
      .map((transfer) => ({ kind: 'transfer' as const, at: new Date(transfer.createdAt), transfer })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}

const units = (value: string | undefined): bigint | null =>
  value !== undefined && /^\d+$/.test(value) ? BigInt(value) : null;

/** Qué hizo la operación según su intención guardada (cuando no hay transfers de su transacción). */
function intentParts(type: OperationStatus['operationType'], decoded: DecodedOperation, nameOf: NameOf) {
  const text = (value: string): DescriptionPart => ({ kind: 'text', text: value });
  const amount = (value: string | undefined, token: string | undefined): DescriptionPart | null => {
    const parsed = units(value);
    return parsed === null || token === undefined ? null : { kind: 'amount', text: tokenAmount(parsed, token) };
  };
  const party = (address: Address | undefined): DescriptionPart | null =>
    address === undefined ? null : { kind: 'address', address, name: nameOf(address) };
  const parts = (...list: (DescriptionPart | null)[]): DescriptionPart[] | null =>
    list.every((p) => p !== null) ? list : null;
  switch (type) {
    case 'SEND':
    case 'MIGRATION_TRANSFER':
      return parts(amount(decoded.amount, decoded.token), text(' a '), party(decoded.destination));
    case 'SWAP':
      return parts(
        amount(decoded.amount, decoded.tokenIn),
        text(' por al menos '),
        amount(decoded.minAmountOut, decoded.tokenOut),
      );
    case 'SWAP_APPROVE':
      return parts(amount(decoded.amount, decoded.token), text(' para el contrato de swap de la plataforma'));
    case 'APPROVE_REVOKE':
      return decoded.token === undefined
        ? null
        : [text(`el del contrato de swap de la plataforma sobre tus ${decoded.token}`)];
    case 'WHITELIST_ADD':
    case 'WHITELIST_REMOVE':
      return parts(party(decoded.destination));
    case 'ROTATION_PROPOSE':
    case 'ROTATION_EXECUTE':
      return decoded.role === undefined ? null : [text(ROLE_TEXT[decoded.role] ?? decoded.role)];
    case 'GUARD_UPGRADE':
      return parts(text('nueva dirección '), party(decoded.newKey));
    case 'NOOP_CANCEL':
      return null;
  }
}

/** El detalle de una operación de la actividad (sin el título ni el estado). */
export function operationDetail(
  item: Extract<ActivityItem, { kind: 'operation' }>,
  nameOf: NameOf,
): DescriptionPart[] | null {
  const { operation, transfers } = item;
  const text = (value: string): DescriptionPart => ({ kind: 'text', text: value });
  const out = transfers.filter((t) => t.direction === 'OUT');
  const incoming = transfers.filter((t) => t.direction === 'IN');
  const [sold] = out;
  const [bought] = incoming;
  if (operation.operationType === 'SWAP' && sold && bought) {
    return [
      text('cambiaste '),
      { kind: 'amount', text: tokenAmount(BigInt(sold.amount), sold.token) },
      text(' por '),
      { kind: 'amount', text: tokenAmount(BigInt(bought.amount), bought.token) },
      text(' con '),
      { kind: 'address', address: sold.counterparty, name: nameOf(sold.counterparty) },
    ];
  }
  if (out.length > 0) {
    return out.flatMap((t, i) => [
      text(i === 0 ? 'enviaste ' : '; enviaste '),
      { kind: 'amount' as const, text: tokenAmount(BigInt(t.amount), t.token) },
      text(' a '),
      { kind: 'address' as const, address: t.counterparty, name: nameOf(t.counterparty) },
    ]);
  }
  return operation.decoded === undefined ? null : intentParts(operation.operationType, operation.decoded, nameOf);
}

/** Un transfer propio de la actividad: título (con monto) y contraparte. */
export function transferDetail(transfer: Transfer, nameOf: NameOf): { title: string; parts: DescriptionPart[] } {
  const incoming = transfer.direction === 'IN';
  return {
    title: `${incoming ? 'Recibiste' : 'Enviaste'} ${tokenAmount(BigInt(transfer.amount), transfer.token)}`,
    parts: [
      { kind: 'text', text: incoming ? 'de ' : 'a ' },
      { kind: 'address', address: transfer.counterparty, name: nameOf(transfer.counterparty) },
    ],
  };
}

export function explorerTx(chain: Pick<PinnedChain, 'explorer'>, txHash: string): string {
  return `${chain.explorer.tx}${txHash}`;
}

export function explorerAddress(chain: Pick<PinnedChain, 'explorer'>, address: string): string {
  return `${chain.explorer.address}${address}`;
}
