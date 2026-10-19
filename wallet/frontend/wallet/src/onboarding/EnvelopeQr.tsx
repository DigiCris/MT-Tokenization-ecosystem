// QR del sobre cifrado ([F-KEY-06].3, [W-05]): los cuadros MTWQR1 dibujados en canvas, con la opción de imprimirlos
// solos. Si el sobre no entra en un cuadro, se avisa que para restaurar hacen falta todas las partes. Lo usan los
// backups (onboarding, Password U, restauración) y la re-exportación desde Seguridad.
import { Notice } from '../ui/forms.tsx';
import { printSection } from '../ui/print.ts';
import { QrCanvas } from '../ui/QrCanvas.tsx';

export function EnvelopeQr({ frames, printId }: { frames: readonly string[]; printId: string }) {
  const parts = frames.length;
  return (
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
            label={`QR del sobre cifrado, parte ${String(i + 1)} de ${String(parts)}`}
          />
          {parts > 1 && (
            <figcaption>
              Parte {i + 1} de {parts}
            </figcaption>
          )}
        </figure>
      ))}
      <button
        type="button"
        className="button button--ghost"
        onClick={() => {
          printSection(printId);
        }}
      >
        Imprimir QR
      </button>
    </div>
  );
}
