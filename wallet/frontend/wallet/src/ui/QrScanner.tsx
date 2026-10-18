// Lector de QR con la cámara (sólo en /restore y /sovereign: Permissions-Policy, [F-SEC-03]): cuadros del video a un
// canvas fuera de pantalla y decodificación con `qr/decode.js` (JS puro, sin servicios externos). Corta la cámara al
// desmontar o al completar la lectura.
import { useEffect, useRef, useState } from 'react';
import decodeQR from 'qr/decode.js';

export function QrScanner({ onText, active }: { onText: (text: string) => void; active: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  // El callback más reciente, sin reiniciar la cámara cuando cambia (cada lectura suele re-renderizar a quien lo pasa).
  const callback = useRef(onText);
  useEffect(() => {
    callback.current = onText;
  }, [onText]);

  useEffect(() => {
    if (!active) return undefined;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (media) => {
        if (stopped) {
          media.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        stream = media;
        const element = video.current;
        if (!element || !context) return;
        element.srcObject = media;
        await element.play();
        timer = setInterval(() => {
          if (element.videoWidth === 0) return;
          canvas.width = element.videoWidth;
          canvas.height = element.videoHeight;
          context.drawImage(element, 0, 0);
          const frame = context.getImageData(0, 0, canvas.width, canvas.height);
          try {
            const text = decodeQR({ width: frame.width, height: frame.height, data: frame.data });
            if (text !== '') callback.current(text);
          } catch {
            // Sin QR legible en este cuadro.
          }
        }, 250);
      })
      .catch(() => {
        setError('No se pudo usar la cámara. Revisá el permiso o elegí otra forma de restaurar.');
      });
    return () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
    };
  }, [active]);

  return (
    <div className="scanner">
      {/* El video no tiene audio ni subtítulos: es la vista previa de la cámara para apuntar al QR. */}
      <video ref={video} className="scanner__video" muted playsInline aria-label="Vista de la cámara" />
      {error !== null && (
        <p role="alert" className="notice notice--error">
          {error}
        </p>
      )}
    </div>
  );
}
