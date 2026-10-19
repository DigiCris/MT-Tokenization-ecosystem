// Hash de una transacción completo (para compararlo o buscarlo) y el enlace al explorador de bloques fijado (sólo un
// enlace: no se embebe nada de terceros). Lo usan la actividad y el review (planner §8.4: detalle con tx hash).
import { pinnedChain } from '../config/chain.ts';
import { explorerTx } from './activity.ts';

export function TxHash({ hash }: { hash: string }) {
  return (
    <span className="tx" data-tx={hash}>
      Transacción <code className="tx__hash">{hash}</code> ·{' '}
      <a className="nowrap" href={explorerTx(pinnedChain, hash)} target="_blank" rel="noopener noreferrer">
        ver en el explorador de bloques
      </a>
    </span>
  );
}
