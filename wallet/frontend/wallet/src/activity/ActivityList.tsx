// Lista de actividad: operaciones con lo que hicieron ("Envío: 1,00 USDC a …") y su estado (con el motivo en texto si
// no se ejecutó), y transfers entrantes/salientes, con la hora de inclusión en un bloque, el hash de la transacción y
// el link al explorer (sólo un link).
import { CallDescription } from '../operations/CallDescription.tsx';
import { operationReason, stateLabel } from '../operations/describe.ts';
import type { NameOf } from '../operations/names.ts';
import { operationDetail, operationTypeText, transferDetail, type ActivityItem } from './activity.ts';
import { TxHash } from './TxHash.tsx';

export function ActivityList({ items, nameOf }: { items: ActivityItem[]; nameOf: NameOf }) {
  if (items.length === 0) return <p className="muted">Todavía no hay movimientos.</p>;
  return (
    <ul className="activity">
      {items.map((item) => {
        const when = item.at.toLocaleString('es-AR');
        if (item.kind === 'operation') {
          const { operation } = item;
          const detail = operationDetail(item, nameOf);
          const reason = operationReason(operation);
          return (
            <li key={`op-${operation.id}`} data-kind="operation" data-status={operation.status}>
              <strong>{operationTypeText(operation.operationType)}</strong>
              {detail && (
                <span data-detail>
                  {': '}
                  <CallDescription parts={detail} />
                </span>
              )}{' '}
              · <span data-state>{stateLabel(operation)}</span>
              {reason !== null && <span data-reason> ({reason})</span>} ·{' '}
              <time dateTime={item.at.toISOString()}>{item.atKind === 'prepared' ? `preparada el ${when}` : when}</time>
              {operation.txHash && (
                <>
                  <br />
                  <TxHash hash={operation.txHash} />
                </>
              )}
            </li>
          );
        }
        const { title, parts } = transferDetail(item.transfer, nameOf);
        return (
          <li key={`tr-${item.transfer.id}`} data-kind="transfer" data-direction={item.transfer.direction}>
            <strong>{title}</strong> <CallDescription parts={parts} /> ·{' '}
            <time dateTime={item.at.toISOString()}>{when}</time>
            <br />
            <TxHash hash={item.transfer.txHash} />
          </li>
        );
      })}
    </ul>
  );
}
