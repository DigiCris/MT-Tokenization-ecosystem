// Lector mínimo de archivos .env (nunca `source`): comillas simples o dobles y comentarios en línea precedidos de
// espacio, con la misma semántica que el parser de wallet/scripts. Propio de esta app: los builds de Wallet y Recovery
// no comparten código (V9 §17).
import { existsSync, readFileSync } from 'node:fs';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function valueOf(raw: string): string {
  if (/^\s*$/.test(raw) || /^\s+#/.test(raw)) return '';
  const s = raw.replace(/^\s+/, '');
  const quote = s[0];
  if (quote === "'" || quote === '"') {
    const end = s.indexOf(quote, 1);
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  return (/^(.*?)(\s+#.*)?$/.exec(s)?.[1] ?? '').trim();
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const match = LINE.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) out[match[1]] = valueOf(match[2]);
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> | null {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : null;
}
