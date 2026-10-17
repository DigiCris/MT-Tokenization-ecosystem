// Parser de wallet/.env con la misma semántica que scripts/preflight.d/lib/env.mjs: comillas simples o dobles y
// comentarios en línea precedidos de espacio. Sólo se usa con APP_ENV=local (staging/production no leen archivos .env).

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function splitValue(raw: string): string {
  if (/^\s*$/.test(raw) || /^\s+#/.test(raw)) return '';
  const s = raw.replace(/^\s+/, '');
  const quote = s[0];
  if (quote === "'" || quote === '"') {
    const end = s.indexOf(quote, 1);
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  const m = /^(.*?)(\s+#.*)?$/.exec(s);
  return (m?.[1] ?? '').trim();
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const m = LINE.exec(line);
    if (!m?.[1] || m[2] === undefined) continue;
    out[m[1]] = splitValue(m[2]);
  }
  return out;
}
