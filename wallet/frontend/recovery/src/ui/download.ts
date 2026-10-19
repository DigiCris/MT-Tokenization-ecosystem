// Descarga de un archivo generado en el navegador (sobre cifrado, documento soberano, calldata): un Blob con una URL
// temporal, sin pasar por ningún servidor; la URL se revoca enseguida.
export function downloadText(fileName: string, content: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** Texto de un archivo elegido por el usuario (sobre cifrado, documento soberano, firma de U). */
export function readTextFile(file: File): Promise<string> {
  return file.text();
}
