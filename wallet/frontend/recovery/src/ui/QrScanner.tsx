// Lector de QR con la cámara (sólo en /restore y /sovereign: Permissions-Policy, [F-SEC-03]): cuadros del video a un
// canvas fuera de pantalla y decodificación con `qr/decode.js` (JS puro, sin servicios externos). El callback más
// reciente vive en una ref: un re-render de quien lo pasa no reinicia la cámara. Corta la cámara al desmontar.
import { useEffect, useRef, useState } from 'react';
import decodeQR from 'qr/decode.js';

export function QrScanner({ onText }: { onText: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const callback = useRef(onText);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    callback.current = onText;
  }, [onText]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (media) => {
        if (stopped) {
          for (const track of media.getTracks()) track.stop();
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
        setError('No se pudo usar la cámara. Revisá el permiso o elegí el archivo.');
      });
    return () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      if (stream) for (const track of stream.getTracks()) track.stop();
    };
  }, []);

  return (
    <div className="scanner">
      {/* La vista previa de la cámara para apuntar al QR: no tiene audio ni subtítulos. */}
      <video ref={video} className="scanner__video" muted playsInline aria-label="Vista de la cámara" />
      {error !== null && (
        <p role="alert" className="notice notice--error">
          {error}
        </p>
      )}
    </div>
  );
}
