// Helpers de test: contexto de preflight aislado sobre archivos temporales.
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from '../main.mjs';

export const WALLET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const tmp = (prefix = 'mtw-pf-') => mkdtempSync(join(tmpdir(), prefix));

/**
 * Valores sintéticos con el formato que validan los checks. Se arman en tiempo de ejecución para que ningún
 * literal con forma de credencial quede en el código (los escáneres de secretos los confunden con reales).
 */
const synthetic = {
  googleClientId: (tag) => `${'1'.repeat(12)}-${tag.padEnd(32, 'x')}.apps.${'googleusercontent'}.com`,
  googleSecret: () => ['GOCSPX', 'A'.repeat(28)].join('-'),
  refreshToken: (c) => ['1', '', '0' + c.repeat(40)].join('/'),
  mailgunKey: () => ['0123456789abcdef'.repeat(2), '01234567', '89abcdef'].join('-'),
};

/** .env válido de ejemplo (sin secretos reales) con todas las variables de local con formato correcto. */
export function validLocalEnv(overrides = {}) {
  const base = readFileSync(join(WALLET_ROOT, '.env.example'), 'utf8');
  const fill = {
    BASE_RPC_URL: `https://base-mainnet.g.alchemy.com/v2/${'A'.repeat(32)}`,
    WALLETCONNECT_PROJECT_ID: '0123456789abcdef'.repeat(2),
    GOOGLE_CLIENT_ID_WALLET: synthetic.googleClientId('walletclient'),
    GOOGLE_CLIENT_ID_RECOVERY: synthetic.googleClientId('recoveryclient'),
    EMAIL_PROVIDER_API_KEY: synthetic.mailgunKey(),
    EMAIL_PROVIDER_DOMAIN: `sandbox${'0123456789abcdef'.repeat(2)}ab.mailgun.org`,
    GOOGLE_DRIVE_TEST_CLIENT_ID: synthetic.googleClientId('drivetests'),
    GOOGLE_DRIVE_TEST_CLIENT_SECRET: synthetic.googleSecret(),
    GOOGLE_DRIVE_TEST_REFRESH_TOKEN: synthetic.refreshToken('A'),
    EMAIL_TEST_ADDRESS: 'prueba@example.com',
    EMAIL_TEST_GOOGLE_CLIENT_ID: synthetic.googleClientId('drivetests'),
    EMAIL_TEST_GOOGLE_CLIENT_SECRET: synthetic.googleSecret(),
    EMAIL_TEST_GOOGLE_REFRESH_TOKEN: synthetic.refreshToken('B'),
    ...overrides,
  };
  let text = base;
  for (const [k, v] of Object.entries(fill)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}\n${k}=${v}`;
  }
  return text;
}

/** Contexto de preflight con un .env temporal; nunca toca wallet/.env real. */
export function ctxWithEnv(envText, { envName = 'local', fix = false } = {}) {
  const dir = tmp();
  const envFile = join(dir, '.env');
  writeFileSync(envFile, envText, { mode: 0o600 });
  const logs = [];
  // Aislado del entorno del proceso (en CI los secretos llegan como variables): sólo cuenta el archivo temporal.
  const ctx = makeContext({ envName, fix, envFile, log: (m) => logs.push(m), processEnv: {} });
  ctx.reloadEnv = () => {};
  return { ctx, dir, envFile, logs };
}

export function setupSlugs() {
  const md = readFileSync(join(WALLET_ROOT, 'docs/SETUP_EXTERNAL_SERVICES.md'), 'utf8');
  const slugs = new Set();
  for (const line of md.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (!m) continue;
    const slug = m[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    slugs.add(slug);
  }
  return slugs;
}

export { cpSync };
