// QR dibujado en un canvas a partir de la matriz de `qr` (sin SVG ni HTML generado: ningún sink de Trusted Types). Lo
// usan el link de regreso a la Wallet, el sobre de R y los cuadros de un documento soberano.
import { useEffect, useRef, useState } from 'react';
import encodeQR from 'qr';

export function QrCanvas({ text, label, size = 280 }: { text: string; label: string; size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const matrix = encodeQR(text, 'raw', { ecc: 'medium', border: 4 });
    const scale = Math.max(1, Math.floor(size / matrix.length));
    element.width = matrix.length * scale;
    element.height = matrix.length * scale;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, element.width, element.height);
    context.fillStyle = '#000000';
    matrix.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) context.fillRect(x * scale, y * scale, scale, scale);
      });
    });
  }, [text, size]);
  return <canvas ref={canvas} className="qr" role="img" aria-label={label} />;
}

/** QR multi-cuadro que rota solo (cada ~0,9 s): el documento soberano o el sobre para leerlos con otra cámara. */
export function QrFrames({ frames, label }: { frames: readonly string[]; label: string }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (frames.length < 2) return undefined;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, 900);
    return () => {
      clearInterval(timer);
    };
  }, [frames]);
  const current = index < frames.length ? index : 0;
  return (
    <div className="stack">
      <QrCanvas
        text={frames[current] ?? ''}
        label={`${label}, cuadro ${String(current + 1)} de ${String(frames.length)}`}
      />
      <p className="muted" data-frame={current + 1}>
        Cuadro {current + 1} de {frames.length}
      </p>
    </div>
  );
}
