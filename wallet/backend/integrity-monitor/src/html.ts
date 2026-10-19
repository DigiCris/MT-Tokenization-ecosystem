// Revisión del index.html servido ([F-SEC-06]): con un parser HTML conforme (parse5, el mismo árbol que arma el
// navegador) recorre todos los elementos y exige que cada script y cada hoja de estilo o modulepreload sea un archivo
// del manifest con `integrity` (SRI sha384) igual a su contenido, que todo recurso referenciado esté en el manifest y
// sea del mismo origin, y que no haya scripts inline, manejadores `on*`, `<base>` ni contenido embebido.
import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const URL_ATTRIBUTES = new Set(['src', 'href', 'srcset', 'poster', 'data', 'action', 'formaction', 'background']);
const EMBEDDING = new Set(['iframe', 'frame', 'object', 'embed', 'applet', 'base', 'portal']);
const SRI_LINKS = new Set(['stylesheet', 'modulepreload', 'preload']);

export function sriSha384(bytes: Uint8Array): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

function* elements(node: Node): Generator<Element> {
  if ('tagName' in node) yield node;
  const children = 'childNodes' in node ? node.childNodes : [];
  for (const child of children) yield* elements(child);
  if ('content' in node) yield* elements(node.content);
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

/** Ruta del manifest para una URL del documento (sólo rutas absolutas del mismo origin; `null` si es otra cosa). */
export function manifestPath(reference: string): string | null {
  if (!reference.startsWith('/') || reference.startsWith('//')) return null;
  const path = reference.split(/[?#]/, 1)[0] ?? '';
  return path.slice(1) || null;
}

/**
 * Problemas del documento (vacío si está bien). `files` da los bytes de cada archivo del manifest ya verificados por
 * hash; `listed` es el conjunto de rutas del manifest.
 */
export function inspectDocument(
  html: string,
  listed: ReadonlySet<string>,
  files: ReadonlyMap<string, Uint8Array>,
): string[] {
  const problems: string[] = [];
  for (const element of elements(parse(html))) {
    const tag = element.tagName;
    if (EMBEDDING.has(tag)) problems.push(`index.html: elemento <${tag}> no permitido`);
    for (const { name, value } of element.attrs) {
      if (name.startsWith('on')) problems.push(`index.html: manejador inline ${name} en <${tag}>`);
      if (!URL_ATTRIBUTES.has(name)) continue;
      if (name === 'srcset') {
        problems.push(`index.html: srcset en <${tag}> (no se usa)`);
        continue;
      }
      if (value.trim().toLowerCase().startsWith('data:')) continue;
      const path = manifestPath(value.trim());
      if (path === null) problems.push(`index.html: ${name}="${value}" en <${tag}> no es del mismo origin`);
      else if (!listed.has(path)) problems.push(`index.html: ${value} no figura en el manifest`);
    }
    if (tag === 'script') {
      const src = attr(element, 'src');
      if (src === undefined) {
        problems.push('index.html: script inline');
        continue;
      }
      checkSri(element, src, files, problems);
    }
    if (tag === 'link') {
      const rel = (attr(element, 'rel') ?? '').toLowerCase().split(/\s+/);
      const href = attr(element, 'href');
      if (href !== undefined && rel.some((r) => SRI_LINKS.has(r))) checkSri(element, href, files, problems);
    }
  }
  return problems;
}

function checkSri(
  element: Element,
  reference: string,
  files: ReadonlyMap<string, Uint8Array>,
  problems: string[],
): void {
  const path = manifestPath(reference);
  const bytes = path === null ? undefined : files.get(path);
  if (bytes === undefined) return; // ya reportado como fuera del manifest
  const integrity = attr(element, 'integrity');
  if (integrity === undefined) problems.push(`index.html: ${reference} sin integrity (SRI)`);
  else if (integrity.trim() !== sriSha384(bytes)) problems.push(`index.html: el integrity de ${reference} no coincide`);
}
