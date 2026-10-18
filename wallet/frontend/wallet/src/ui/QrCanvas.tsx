// QR dibujado en canvas a partir de la matriz de `qr` (sin SVG ni HTML generado: ningún sink de Trusted Types).
import { useEffect, useRef } from 'react';
import encodeQR from 'qr';

export function QrCanvas({ text, label, size = 280 }: { text: string; label: string; size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const matrix = encodeQR(text, 'raw', { ecc: 'medium', border: 4 });
    const cells = matrix.length;
    const scale = Math.max(1, Math.floor(size / cells));
    element.width = cells * scale;
    element.height = cells * scale;
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
