// Contenido de una descarga leído por stream: funciona también con los navegadores en la imagen de Playwright
// (PW_TEST_CONNECT_WS_ENDPOINT), donde `download.path()` no existe porque el archivo queda en el contenedor.
import type { Download } from '@playwright/test';

export async function downloadedText(download: Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}
