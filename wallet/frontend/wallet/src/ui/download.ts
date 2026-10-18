// Descarga local de un archivo generado en el navegador (sobre cifrado `mtw-U-<walletId>.enc.json`, [F-KEY-06].2):
// blob con URL efímera; nada pasa por el backend.

export function downloadText(fileName: string, content: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}

export function envelopeFileName(walletId: string): string {
  return `mtw-U-${walletId}.enc.json`;
}

/** Lee un archivo elegido por el usuario como texto (máximo 64 KiB: un sobre ocupa menos de 1 KiB). */
export async function readTextFile(file: File, maxBytes = 64 * 1024): Promise<string> {
  if (file.size > maxBytes) throw new Error('El archivo es demasiado grande para ser un sobre de MT Wallet');
  return file.text();
}
