// Descarga local de un archivo generado en el navegador (sobre cifrado `mtw-U-<walletId>-<4>-<4>.enc.json`,
// [F-KEY-06].2): blob con URL efímera; nada pasa por el backend.
import { getAddress, type Address } from 'viem';

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

/**
 * Nombre del archivo del sobre de U: con el principio y el final de la dirección de la clave (EIP-55), así el de U′
 * («Perdí mi Password U») no baja con el mismo nombre que el de la U anterior (cuarta revisión de P17.MAN, hallazgo 1).
 * Restaurar o desbloquear lee el contenido, nunca el nombre.
 */
export function envelopeFileName(envelope: { walletId: string; keyAddress: Address }): string {
  const hex = getAddress(envelope.keyAddress).slice(2);
  return `mtw-U-${envelope.walletId}-${hex.slice(0, 4)}-${hex.slice(-4)}.enc.json`;
}

/** Lee un archivo elegido por el usuario como texto (máximo 64 KiB: un sobre ocupa menos de 1 KiB). */
export async function readTextFile(file: File, maxBytes = 64 * 1024): Promise<string> {
  if (file.size > maxBytes) throw new Error('El archivo es demasiado grande para ser un sobre de MT Wallet');
  return file.text();
}
