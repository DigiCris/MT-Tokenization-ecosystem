// QR del sobre cifrado de R ([F-KEY-06].3, [W-05]): los cuadros MTWQR1 dibujados en canvas, todos a la vista y quietos
// (no el QR animado de los documentos soberanos: impreso sólo saldría un cuadro), con la opción de imprimirlos solos.
// Si el sobre no entra en un cuadro, se avisa que para restaurar hacen falta todas las partes. Lo usan los backups del
// enrollment y la restauración de R.
import { printSection } from '../ui/print.ts';
import { Notice } from '../ui/forms.tsx';
import { QrCanvas } from '../ui/QrCanvas.tsx';

export function EnvelopeQr({ frames, printId }: { frames: readonly string[]; printId: string }) {
  const parts = frames.length;
  return (
    <div className="stack">
      <div className="stack" id={printId}>
        {parts > 1 && (
          <Notice tone="warning">
            El QR tiene {parts} partes y para restaurar hacen falta todas: guardá o imprimí las {parts}.
          </Notice>
        )}
        {frames.map((frame, i) => (
          <figure key={frame} className="qr-frame">
            <QrCanvas
              text={frame}
              size={360}
              label={`QR del sobre cifrado de R, parte ${String(i + 1)} de ${String(parts)}`}
            />
            {parts > 1 && (
              <figcaption>
                Parte {i + 1} de {parts}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
      <div className="actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            printSection(printId);
          }}
        >
          Imprimir QR
        </button>
      </div>
      <p className="muted">Si lo imprimís, usá una impresora de confianza y no guardes el PDF.</p>
    </div>
  );
}
