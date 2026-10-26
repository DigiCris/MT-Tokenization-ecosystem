// Video Y4M (YUV 4:2:0) con QR para la cámara simulada de Chromium (`--use-file-for-fake-video-capture`): la app lee el
// QR por getUserMedia → canvas → decodificador, igual que con una cámara real. Cada frame QR se muestra varios cuadros.
import { writeFileSync } from 'node:fs';
import encodeQR from 'qr';

const WIDTH = 640;
const HEIGHT = 480;

function frameFor(text: string): Buffer {
  const matrix = encodeQR(text, 'raw', { ecc: 'medium', border: 4 });
  const cells = matrix.length;
  const scale = Math.floor(Math.min(WIDTH, HEIGHT) / cells);
  const size = cells * scale;
  const left = Math.floor((WIDTH - size) / 2);
  const top = Math.floor((HEIGHT - size) / 2);
  const luma = Buffer.alloc(WIDTH * HEIGHT, 235);
  for (let y = 0; y < size; y++) {
    const row = matrix[Math.floor(y / scale)] ?? [];
    for (let x = 0; x < size; x++) {
      if (row[Math.floor(x / scale)]) luma[(top + y) * WIDTH + left + x] = 16;
    }
  }
  const chroma = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2), 128);
  return Buffer.concat([Buffer.from('FRAME\n'), luma, chroma, chroma]);
}

export function writeQrVideo(path: string, frames: readonly string[], repeat = 15): void {
  const header = Buffer.from(`YUV4MPEG2 W${String(WIDTH)} H${String(HEIGHT)} F10:1 Ip A1:1 C420jpeg\n`);
  const encoded = frames.map(frameFor);
  const body: Buffer[] = [];
  for (const frame of encoded) for (let i = 0; i < repeat; i++) body.push(frame);
  writeFileSync(path, Buffer.concat([header, ...body]));
}
