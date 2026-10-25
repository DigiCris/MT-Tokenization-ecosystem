// P18.T08: operaciones y transfers en una lista por fecha, sin duplicar el transfer saliente de una operación propia, y
// links al explorer fijado. P18.MAN: el swap junta lo que salió y lo que entró en su transacción ("cambiaste … por …"
// con el pool que usa la app), una operación sin transfers dice qué era (su intención guardada, sin un "de" que se lea
// como origen) y la hora de una operación es la de su inclusión en un bloque, comparable con la de los transfers
// indexados. Los labels de la whitelist van entre «», como en la pantalla.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { DecodedOperation, OperationStatus, Transfer } from '../api/wallet-api.ts';
import { pinnedChain } from '../config/chain.ts';
import { partsText } from '../operations/describe.ts';
import { addressNames, labelsOf, POOL_NAME, shownLabels } from '../operations/names.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { explorerAddress, explorerTx, mergeActivity, operationDetail, transferDetail } from './activity.ts';

const op = (id: string, createdAt: string, txHash: string | null, patch: Partial<OperationStatus> = {}) =>
  ({ id, createdAt, txHash, status: 'FINALIZED', operationType: 'SEND', history: [], ...patch }) as OperationStatus;
const transfer = (
  id: string,
  createdAt: string,
  direction: 'IN' | 'OUT',
  txHash: string,
  patch: Partial<Transfer> = {},
) => ({ id, createdAt, direction, txHash, token: 'USDC', amount: '1', ...patch }) as Transfer;

const DEST: Address = '0x6DFD2d7600000000000000000000000000003a23';
const POOL = pinnedChain.uniswap.pool.address;
const nameOf = addressNames(
  { chain: pinnedChain },
  shownLabels(labelsOf([{ address: DEST, label: 'Cuenta de Carla' }])),
);
const CARLA = `«Cuenta de Carla» (${groupAddress(DEST)})`;

function operationItem(items: ReturnType<typeof mergeActivity>, id: string) {
  const item = items.find((i) => i.kind === 'operation' && i.operation.id === id);
  if (item?.kind !== 'operation') throw new Error(id);
  return item;
}

describe('actividad', () => {
  it('ordena por fecha y muestra el transfer saliente de una operación propia dentro de ella, no dos veces', () => {
    const items = mergeActivity(
      [op('o1', '2026-10-18T10:00:00Z', `0x${'aa'.repeat(32)}`), op('o2', '2026-10-18T12:00:00Z', null)],
      [
        transfer('t1', '2026-10-18T10:00:05Z', 'OUT', `0x${'AA'.repeat(32)}`),
        transfer('t2', '2026-10-18T11:00:00Z', 'IN', `0x${'bb'.repeat(32)}`),
        transfer('t3', '2026-10-18T09:00:00Z', 'OUT', `0x${'cc'.repeat(32)}`),
      ],
    );
    expect(items.map((i) => (i.kind === 'operation' ? i.operation.id : i.transfer.id))).toEqual([
      'o2',
      't2',
      'o1',
      't3',
    ]);
    expect(operationItem(items, 'o1').transfers.map((t) => t.id)).toEqual(['t1']);
    expect(operationItem(items, 'o2').transfers).toEqual([]);
  });

  it('un saliente de la misma tx que una operación pero entrante no se pliega', () => {
    const tx = `0x${'dd'.repeat(32)}`;
    const items = mergeActivity(
      [op('o1', '2026-10-18T10:00:00Z', tx)],
      [transfer('t1', '2026-10-18T10:00:01Z', 'IN', tx)],
    );
    expect(items.map((i) => i.kind)).toEqual(['transfer', 'operation']);
  });

  it('la hora de una operación minada es la de su inclusión en un bloque, comparable con la de los transfers', () => {
    const items = mergeActivity(
      [
        op('o1', '2026-10-18T10:00:00Z', `0x${'ee'.repeat(32)}`, {
          history: [
            { status: 'CREATED', at: '2026-10-18T10:00:00Z' },
            { status: 'MINED', at: '2026-10-18T10:05:00Z' },
          ],
        }),
      ],
      [transfer('t1', '2026-10-18T10:03:00Z', 'IN', `0x${'ff'.repeat(32)}`)],
    );
    expect(items.map((i) => i.kind)).toEqual(['operation', 'transfer']);
    const mined = operationItem(items, 'o1');
    expect(mined.atKind).toBe('mined');
    expect(mined.at.toISOString()).toBe('2026-10-18T10:05:00.000Z');
    const pending = operationItem(mergeActivity([op('o2', '2026-10-18T10:00:00Z', null)], []), 'o2');
    expect(pending.atKind).toBe('prepared');
  });

  it('el swap junta lo que salió y lo que entró en su transacción, con el pool que usa la app', () => {
    const tx = `0x${'12'.repeat(32)}`;
    const items = mergeActivity(
      [
        op('approve', '2026-10-18T10:00:00Z', `0x${'34'.repeat(32)}`, { operationType: 'SWAP_APPROVE' }),
        op('swap', '2026-10-18T10:00:01Z', tx, { operationType: 'SWAP' }),
      ],
      [
        transfer('out', '2026-10-18T10:01:00Z', 'OUT', tx, { amount: '20000000', counterparty: POOL }),
        transfer('in', '2026-10-18T10:01:00Z', 'IN', tx, { token: 'USDT', amount: '20027338', counterparty: POOL }),
      ],
    );
    // Dos ítems (el permiso y el swap), no tres: el entrante del pool queda dentro del swap.
    expect(items.map((i) => i.kind)).toEqual(['operation', 'operation']);
    const detail = operationDetail(operationItem(items, 'swap'), nameOf);
    expect(detail && partsText(detail)).toBe(
      `cambiaste 20,00 USDC por 20,027338 USDT con ${POOL_NAME} (${groupAddress(POOL)})`,
    );
  });

  it('una operación sin transfers dice qué era: su intención guardada, con el destino nombrado', () => {
    const cancelled = op('o1', '2026-10-18T10:00:00Z', null, {
      status: 'CANCELLED',
      decoded: { token: 'USDC', amount: '2500000', destination: DEST },
    });
    const [item] = mergeActivity([cancelled], []);
    if (item?.kind !== 'operation') throw new Error('operation');
    const detail = operationDetail(item, nameOf);
    expect(detail && partsText(detail)).toBe(`2,50 USDC a ${CARLA}`);
    const whitelistAdd = op('o2', '2026-10-18T10:00:00Z', null, {
      operationType: 'WHITELIST_ADD',
      decoded: { destination: DEST },
    });
    const [added] = mergeActivity([whitelistAdd], []);
    if (added?.kind !== 'operation') throw new Error('operation');
    expect(partsText(operationDetail(added, nameOf) ?? [])).toBe(CARLA);
    // Sin intención (backend anterior) no se inventa nada.
    const [bare] = mergeActivity([op('o3', '2026-10-18T10:00:00Z', null)], []);
    if (bare?.kind !== 'operation') throw new Error('operation');
    expect(operationDetail(bare, nameOf)).toBeNull();
    // Un tipo que esta app no conoce: sin detalle (sólo el título genérico), aunque traiga intención.
    const unknownType = op('o4', '2026-10-18T10:00:00Z', null, {
      operationType: 'TIPO_NUEVO' as OperationStatus['operationType'],
      decoded: { token: 'USDC', amount: '2500000', destination: DEST },
    });
    const [unknown] = mergeActivity([unknownType], []);
    if (unknown?.kind !== 'operation') throw new Error('operation');
    expect(operationDetail(unknown, nameOf)).toBeNull();
  });

  it('el envío con su transfer saliente; un transfer propio con su contraparte', () => {
    const tx = `0x${'56'.repeat(32)}`;
    const items = mergeActivity(
      [op('send', '2026-10-18T10:00:00Z', tx)],
      [transfer('t', '2026-10-18T10:00:05Z', 'OUT', tx, { amount: '2500000', counterparty: DEST })],
    );
    const detail = operationDetail(operationItem(items, 'send'), nameOf);
    expect(detail && partsText(detail)).toBe(`enviaste 2,50 USDC a ${CARLA}`);
    const received = transferDetail(
      transfer('in', '2026-10-18T10:00:00Z', 'IN', tx, { amount: '8000000', counterparty: DEST }),
      nameOf,
    );
    expect(received.title).toBe('Recibiste 8,00 USDC');
    expect(partsText(received.parts)).toBe(`de ${CARLA}`);
  });

  it.each<[OperationStatus['operationType'], DecodedOperation, string | null]>([
    ['SEND', { token: 'USDT', amount: '1000000', destination: DEST }, `1,00 USDT a ${CARLA}`],
    ['MIGRATION_TRANSFER', { token: 'USDC', amount: '25000000', destination: DEST }, `25,00 USDC a ${CARLA}`],
    [
      'SWAP',
      { tokenIn: 'USDC', tokenOut: 'USDT', amount: '20000000', minAmountOut: '19940000', deadline: '1' },
      '20,00 USDC por al menos 19,94 USDT',
    ],
    ['SWAP_APPROVE', { token: 'USDC', amount: '20000000' }, '20,00 USDC para el contrato de swap de la plataforma'],
    ['APPROVE_REVOKE', { token: 'USDT' }, 'el del contrato de swap de la plataforma sobre tus USDT'],
    ['WHITELIST_REMOVE', { destination: DEST }, CARLA],
    ['ROTATION_PROPOSE', { role: 'R' }, 'tu clave de recuperación (R)'],
    ['ROTATION_EXECUTE', { role: 'S' }, 'la clave de la plataforma (S)'],
    ['GUARD_UPGRADE', { role: 'GUARD', newKey: DEST }, `nueva dirección ${CARLA}`],
    ['NOOP_CANCEL', {}, null],
    // Datos incompletos o inválidos: nada inventado.
    ['SEND', { token: 'USDC', amount: '1,5', destination: DEST }, null],
    ['APPROVE_REVOKE', {}, null],
    ['ROTATION_PROPOSE', {}, null],
  ])('sin transfers, %s dice qué era según su intención', (operationType, decoded, expected) => {
    const [item] = mergeActivity([op('o', '2026-10-18T10:00:00Z', null, { operationType, decoded })], []);
    if (item?.kind !== 'operation') throw new Error('operation');
    const detail = operationDetail(item, nameOf);
    expect(detail === null ? null : partsText(detail)).toBe(expected);
  });

  it('un envío con más de un transfer saliente en su transacción los muestra todos', () => {
    const tx = `0x${'78'.repeat(32)}`;
    const items = mergeActivity(
      [op('m', '2026-10-18T10:00:00Z', tx, { operationType: 'MIGRATION_TRANSFER' })],
      [
        transfer('a', '2026-10-18T10:00:05Z', 'OUT', tx, { amount: '1000000', counterparty: DEST }),
        transfer('b', '2026-10-18T10:00:05Z', 'OUT', tx, { token: 'USDT', amount: '2000000', counterparty: DEST }),
      ],
    );
    const detail = operationDetail(operationItem(items, 'm'), nameOf);
    expect(detail && partsText(detail)).toBe(`enviaste 1,00 USDC a ${CARLA}; enviaste 2,00 USDT a ${CARLA}`);
  });

  it('links al explorer fijado', () => {
    expect(explorerTx(pinnedChain, '0xabc')).toBe('https://basescan.org/tx/0xabc');
    expect(explorerAddress(pinnedChain, '0xdef')).toBe('https://basescan.org/address/0xdef');
  });
});
