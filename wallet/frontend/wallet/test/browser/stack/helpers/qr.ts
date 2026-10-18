// Lectura de los QR que dibuja la app: los píxeles del canvas se decodifican en Node con `qr/decode.js`, el mismo
// decodificador del lector de la app, así el test verifica lo que una cámara leería y no el texto que se le pasó.
import type { Locator } from '@playwright/test';
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
