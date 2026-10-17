// Parser propio de .env (nunca `source`): respeta comillas simples/dobles y comentarios en línea
// precedidos de espacio. No imprime valores. También actualiza valores preservando el resto del archivo.
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Separa el valor crudo (tras "=") en {value, rest}; rest es el comentario en línea (si hay). */
export function splitValue(raw) {
  if (/^\s*$/.test(raw)) return { value: '', quoted: '', rest: '' };
  // "CLAVE=   # comentario": valor vacío con comentario en línea.
  if (/^\s+#/.test(raw)) return { value: '', quoted: '', rest: raw };
  let s = raw.replace(/^\s+/, '');
  if (s.startsWith("'") || s.startsWith('"')) {
    const q = s[0];
    const end = s.indexOf(q, 1);
    if (end > 0) return { value: s.slice(1, end), quoted: q, rest: s.slice(end + 1) };
    return { value: s.slice(1), quoted: q, rest: '' };
  }
  const m = s.match(/^(.*?)(\s+#.*)?$/);
  return { value: (m[1] ?? '').trim(), quoted: '', rest: m[2] ?? '' };
}

/** @returns {Record<string,string>} */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(LINE);
    if (!m) continue;
    out[m[1]] = splitValue(m[2]).value;
  }
  return out;
}

export function readEnvFile(path) {
  if (!existsSync(path)) return null;
  return parseEnv(readFileSync(path, 'utf8'));
}

/**
 * Asigna valores a claves existentes (o las agrega al final) preservando comentarios y orden.
 * Escritura atómica (tmp + rename) y permisos 0600.
 * @param {string} path @param {Record<string,string>} updates
 */
export function updateEnvFile(path, updates) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text.split('\n');
  const pending = new Map(Object.entries(updates));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE);
    if (!m || !pending.has(m[1])) continue;
    const { quoted, rest } = splitValue(m[2]);
    const v = pending.get(m[1]);
    const needsQuotes = quoted || /[\s#'"]/.test(v);
    const q = quoted || (v.includes("'") ? '"' : "'");
    const value = needsQuotes ? `${q}${v}${q}` : v;
    lines[i] = `${m[1]}=${value}${rest ? (rest.startsWith(' ') ? rest : ' ' + rest) : ''}`;
    pending.delete(m[1]);
  }
  if (pending.size) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    for (const [k, v] of pending) lines.push(`${k}=${/[\s#'"]/.test(v) ? `'${v}'` : v}`);
    lines.push('');
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Huella truncada (no reversible) para reportar presencia sin mostrar el valor. */
export const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);

export const isFileMode600 = (path) => (statSync(path).mode & 0o077) === 0;
