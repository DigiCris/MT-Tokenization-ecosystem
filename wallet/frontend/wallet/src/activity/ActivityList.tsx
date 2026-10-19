// Lista de actividad: operaciones con lo que hicieron y su estado, y transfers entrantes/salientes, con la hora de
// inclusión en un bloque y link al explorer (sólo un link).
import { pinnedChain } from '../config/chain.ts';
import { CallDescription } from '../operations/CallDescription.tsx';
import { STATE_TEXT } from '../operations/describe.ts';
import type { NameOf } from '../operations/names.ts';
import { explorerTx, operationDetail, transferDetail, type ActivityItem } from './activity.ts';

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

function TxLink({ txHash }: { txHash: string }) {
  return (
    <>
      {' · '}
      <a href={explorerTx(pinnedChain, txHash)} target="_blank" rel="noopener noreferrer">
        ver transacción
      </a>
    </>
  );
}

export function ActivityList({ items, nameOf }: { items: ActivityItem[]; nameOf: NameOf }) {
  if (items.length === 0) return <p className="muted">Todavía no hay movimientos.</p>;
  return (
    <ul className="activity">
      {items.map((item) => {
        const when = item.at.toLocaleString('es-AR');
        if (item.kind === 'operation') {
          const detail = operationDetail(item, nameOf);
          return (
            <li key={`op-${item.operation.id}`} data-kind="operation" data-status={item.operation.status}>
              <strong>{OPERATION_TEXT[item.operation.operationType] ?? item.operation.operationType}</strong>
              {detail && (
                <span data-detail>
                  {' · '}
                  <CallDescription parts={detail} />
                </span>
              )}{' '}
              · {STATE_TEXT[item.operation.status]} ·{' '}
              <time dateTime={item.at.toISOString()}>{item.atKind === 'prepared' ? `preparada el ${when}` : when}</time>
              {item.operation.txHash && <TxLink txHash={item.operation.txHash} />}
            </li>
          );
        }
        const { title, parts } = transferDetail(item.transfer, nameOf);
        return (
          <li key={`tr-${item.transfer.id}`} data-kind="transfer" data-direction={item.transfer.direction}>
            <strong>{title}</strong> <CallDescription parts={parts} /> ·{' '}
            <time dateTime={item.at.toISOString()}>{when}</time>
            <TxLink txHash={item.transfer.txHash} />
          </li>
        );
      })}
    </ul>
  );
}
