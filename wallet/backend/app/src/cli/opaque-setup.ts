// `pnpm opaque:setup` (P10.T01): genera OPAQUE_SERVER_SETUP [B-PSES-02] en wallet/.env (o MTW_ENV_FILE), sólo con
// APP_ENV=local, y nunca imprime el valor. Si ya hay uno no lo reemplaza: rotarlo invalida todos los registros OPAQUE
// (re-registro con KEY_RESTORE, runbook de rotación de P26). En staging y producción lo genera una vez
// scripts/deploy/init-secrets.sh como Docker Compose secret (ADR-030).
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { parseDotenv } from '../config/dotenv.ts';

const WALLET_ROOT = resolve(import.meta.dirname, '../../../..');
const LINE = /^(\s*(?:export\s+)?OPAQUE_SERVER_SETUP\s*=)([^\n]*)$/m;

function fail(message: string): never {
  process.stderr.write(`opaque:setup: ${message}\n`);
  process.exit(1);
}

const envFile = resolve(process.env.MTW_ENV_FILE ?? resolve(WALLET_ROOT, '.env'));
if (!existsSync(envFile)) fail(`no existe ${envFile} (generarlo con pnpm secrets:local)`);
const text = readFileSync(envFile, 'utf8');
const values = parseDotenv(text);
const appEnv = process.env.APP_ENV ?? values.APP_ENV ?? 'local';
if (appEnv !== 'local') {
  fail(`sólo genera el secreto de local (APP_ENV=${appEnv}); en staging/producción: scripts/deploy/init-secrets.sh`);
}
if (values.OPAQUE_SERVER_SETUP) {
  process.stdout.write(
    `OPAQUE_SERVER_SETUP ya está en ${envFile}: no se regenera (invalidaría los registros OPAQUE)\n`,
  );
  process.exit(0);
}

await opaque.ready;
const setup = opaque.server.createSetup();
// Verificación de ida y vuelta: el valor escrito se puede deserializar (clave pública del servidor).
opaque.server.getPublicKey(setup);

const match = LINE.exec(text);
let next: string;
if (match) {
  // Conserva el comentario en línea de .env.example (`VAR=   # comentario`).
  const comment = /\s#.*$/.exec(match[2] ?? '')?.[0].trim();
  next = text.replace(LINE, `OPAQUE_SERVER_SETUP=${setup}${comment ? `  ${comment}` : ''}`);
} else {
  next = `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}OPAQUE_SERVER_SETUP=${setup}\n`;
}
const mode = statSync(envFile).mode & 0o777;
writeFileSync(envFile, next);
chmodSync(envFile, mode);
process.stdout.write(`OPAQUE_SERVER_SETUP generado en ${envFile}\n`);
