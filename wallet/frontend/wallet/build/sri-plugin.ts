// SRI propio de la app Wallet ([F-SEC-06], P16.T06): después de escribir el bundle agrega `integrity="sha384-…"` a
// cada <script src> y <link href> de dist/index.html, calculado sobre los bytes finales de cada archivo. Hace fallar el
// build si el HTML tiene scripts o estilos inline, atributos de evento o un <link> que no apunte a un archivo propio
// (CSP 'self' sin 'unsafe-inline', P16.T05).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const LINK = /<link\b([^>]*?)\/?>/gi;

function attribute(attrs: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(attrs)?.[1] ?? null;
}

export function integrityOf(bytes: Buffer): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

/** Reescribe el HTML con SRI en cada recurso propio; `read` devuelve los bytes del archivo publicado en `path`. */
export function addIntegrity(html: string, read: (path: string) => Buffer): string {
  if (/<style\b/i.test(html)) throw new Error('index.html: <style> inline prohibido');
  if (/\sstyle="/i.test(html)) throw new Error('index.html: atributo style prohibido');
  if (/\son[a-z]+="/i.test(html)) throw new Error('index.html: atributos de evento prohibidos');
  const local = (url: string | null, where: string): string => {
    if (url === null || !url.startsWith('/') || url.startsWith('//'))
      throw new Error(`index.html: ${where} sin archivo propio`);
    return url;
  };
  const withSri = html.replace(SCRIPT, (_whole, attrs: string, body: string) => {
    if (body.trim() !== '') throw new Error('index.html: script inline prohibido');
    const src = local(attribute(attrs, 'src'), '<script>');
    if (attribute(attrs, 'integrity') !== null) throw new Error(`index.html: ${src} ya tiene integrity`);
    return `<script${attrs} integrity="${integrityOf(read(src))}"></script>`;
  });
  return withSri.replace(LINK, (_whole, attrs: string) => {
    const href = local(attribute(attrs, 'href'), '<link>');
    const rel = attribute(attrs, 'rel');
    if (rel !== 'stylesheet' && rel !== 'modulepreload' && rel !== 'preload') {
      throw new Error(`index.html: <link rel="${String(rel)}"> no admitido (sólo stylesheet, modulepreload y preload)`);
    }
    return `<link${attrs.replace(/\s+$/, '')} integrity="${integrityOf(read(href))}">`;
  });
}

export function sriPlugin(): Plugin {
  return {
    name: 'mtw:sri',
    apply: 'build',
    writeBundle: {
      order: 'post',
      sequential: true,
      handler(options) {
        const dir = options.dir;
        if (dir === undefined) throw new Error('SRI: falta el directorio de salida');
        const file = join(dir, 'index.html');
        const html = readFileSync(file, 'utf8');
        writeFileSync(
          file,
          addIntegrity(html, (path) => readFileSync(join(dir, path.slice(1)))),
        );
      },
    },
  };
}
