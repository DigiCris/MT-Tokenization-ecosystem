// QR del sobre cifrado ([F-KEY-06].3, [W-05]): los cuadros MTWQR1 dibujados en canvas, con la opción de imprimirlos
// solos. Si el sobre no entra en un cuadro, se avisa que para restaurar hacen falta todas las partes. Cada cuadro lleva,
// también impreso, de qué app y qué clave es (con la dirección abreviada de esa U, cuarta revisión de P17.MAN), qué
// parte es y con qué se abre (una hoja suelta tiene que decirlo), y se avisa que se imprima en una impresora de
// confianza, como en Recovery (tercera revisión). Lo usan los backups (onboarding, Password U, restauración) y la
// re-exportación desde Seguridad.
import type { Address } from 'viem';
import { Notice } from '../ui/forms.tsx';
import { printSection } from '../ui/print.ts';
import { QrCanvas } from '../ui/QrCanvas.tsx';
import { uQrTitle } from './user-key.ts';

export function EnvelopeQr({
  frames,
  keyAddress,
  printId,
}: {
  frames: readonly string[];
  /** La dirección de la U del sobre: va abreviada en el título de cada cuadro. */
  keyAddress: Address;
  printId: string;
}) {
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
              label={`QR del sobre cifrado, parte ${String(i + 1)} de ${String(parts)}`}
            />
            <figcaption className="print-title">{uQrTitle(keyAddress, i + 1, parts)}</figcaption>
          </figure>
        ))}
      </div>
      <button
        type="button"
        className="button button--ghost"
        onClick={() => {
          printSection(printId);
        }}
      >
        Imprimir QR
      </button>
      <p className="muted">Si lo imprimís, usá una impresora de confianza y no guardes el PDF.</p>
    </div>
  );
}
