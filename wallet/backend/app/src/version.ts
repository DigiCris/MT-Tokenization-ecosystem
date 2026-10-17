// Versión del servicio (package.json; igual desde src/ que desde dist/).
import { readFileSync } from 'node:fs';

export function serviceVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}
