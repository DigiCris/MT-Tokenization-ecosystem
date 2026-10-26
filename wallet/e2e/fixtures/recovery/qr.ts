// QR en los tests de Recovery: los píxeles del canvas que dibuja la app se decodifican en Node con `qr/decode.js` (el
// mismo decodificador del lector de la app), y un video Y4M con cuadros QR alimenta la cámara simulada de Chromium
// (`--use-file-for-fake-video-capture`): la app lo lee por getUserMedia → canvas → decodificador, como con una cámara.
import { writeFileSync } from 'node:fs';
import type { Locator } from '@playwright/test';
import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';

export async function readCanvasQr(canvas: Locator): Promise<string> {
  const image = await canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('el QR no es un canvas');
    const context = element.getContext('2d');
    if (!context) throw new Error('el canvas del QR no tiene contexto 2d');
    const { width, height, data } = context.getImageData(0, 0, element.width, element.height);
    return { width, height, data: Array.from(data) };
  });
  return decodeQR({ width: image.width, height: image.height, data: new Uint8Array(image.data) });
}

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

/** Video Y4M (YUV 4:2:0) con cada cuadro QR repetido varios cuadros de video. */
export function writeQrVideo(path: string, frames: readonly string[], repeat = 15): void {
  const header = Buffer.from(`YUV4MPEG2 W${String(WIDTH)} H${String(HEIGHT)} F10:1 Ip A1:1 C420jpeg\n`);
  const encoded = frames.map(frameFor);
  const body: Buffer[] = [];
  for (const frame of encoded) for (let i = 0; i < repeat; i++) body.push(frame);
  writeFileSync(path, Buffer.concat([header, ...body]));
}
