// Lista de actividad: operaciones con su estado y transfers entrantes/salientes, con link al explorer (sólo un link).
import { formatAmount } from '../assets/amount.ts';
import { pinnedChain } from '../config/chain.ts';
import { STATE_TEXT } from '../operations/describe.ts';
import { groupAddress } from '../ui/AddressText.tsx';
import { explorerTx, type ActivityItem } from './activity.ts';

const OPERATION_TEXT: Record<string, string> = {
  SEND: 'Envío',
  SWAP_APPROVE: 'Swap: permiso exacto',
  SWAP: 'Swap',
  WHITELIST_ADD: 'Alta en la whitelist',
  WHITELIST_REMOVE: 'Baja de la whitelist',
  ROTATION_PROPOSE: 'Propuesta de rotación',
  ROTATION_EXECUTE: 'Ejecución de rotación',
  NOOP_CANCEL: 'Cancelación',
  MIGRATION_TRANSFER: 'Migración',
  APPROVE_REVOKE: 'Revocación de permiso',
  GUARD_UPGRADE: 'Actualización del Guard',
};

export function ActivityList({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) return <p className="muted">Todavía no hay movimientos.</p>;
  return (
    <ul className="activity">
      {items.map((item) =>
        item.kind === 'operation' ? (
          <li key={`op-${item.operation.id}`} data-kind="operation" data-status={item.operation.status}>
            <strong>{OPERATION_TEXT[item.operation.operationType] ?? item.operation.operationType}</strong>
            {item.transfers.map((t) => (
              <span key={t.id} data-transfer-out={t.id}>
                {' '}
                · enviaste {formatAmount(BigInt(t.amount), 6)} {t.token} a {groupAddress(t.counterparty)}
              </span>
            ))}{' '}
            · {STATE_TEXT[item.operation.status]} · {item.at.toLocaleString('es-AR')}
            {item.operation.txHash && (
              <>
                {' '}
                ·{' '}
                <a href={explorerTx(pinnedChain, item.operation.txHash)} target="_blank" rel="noopener noreferrer">
                  ver transacción
                </a>
              </>
            )}
          </li>
        ) : (
          <li key={`tr-${item.transfer.id}`} data-kind="transfer" data-direction={item.transfer.direction}>
            <strong>
              {item.transfer.direction === 'IN' ? 'Recibiste' : 'Enviaste'}{' '}
              {formatAmount(BigInt(item.transfer.amount), 6)} {item.transfer.token}
            </strong>{' '}
            {item.transfer.direction === 'IN' ? 'de' : 'a'} {groupAddress(item.transfer.counterparty)} ·{' '}
            {item.at.toLocaleString('es-AR')} ·{' '}
            <a href={explorerTx(pinnedChain, item.transfer.txHash)} target="_blank" rel="noopener noreferrer">
              ver transacción
            </a>
          </li>
        ),
      )}
    </ul>
  );
}
