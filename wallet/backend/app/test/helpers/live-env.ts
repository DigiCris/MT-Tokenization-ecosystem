// Credenciales de los tests contra servicios reales (`*.live.test.ts`): variables del proceso (secrets de CI) o, en
// local, wallet/.env. Nunca se imprimen: los valores sensibles quedan envueltos en Secret. Si falta alguna, el test
// falla con el nombre de la variable (no se saltea: estos tests son obligatorios cuando se ejecutan).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDotenv } from '../../src/config/dotenv.ts';
import { Secret } from '../../src/config/secret.ts';

const WALLET_ENV = resolve(import.meta.dirname, '../../../../.env');

let fileValues: Record<string, string> | undefined;

function value(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  fileValues ??= existsSync(WALLET_ENV) ? parseDotenv(readFileSync(WALLET_ENV, 'utf8')) : {};
  const fromFile = fileValues[name];
  if (fromFile === undefined || fromFile === '') {
    throw new Error(`falta ${name} (variable de entorno o wallet/.env; ver docs/SETUP_EXTERNAL_SERVICES.md)`);
  }
  return fromFile;
}

export interface MailgunLiveEnv {
  apiKey: Secret<string>;
  domain: string;
  baseUrl: string;
  from: string;
}

export interface GmailLiveEnv {
  address: string;
  clientId: string;
  clientSecret: Secret<string>;
  refreshToken: Secret<string>;
}

export function mailgunLiveEnv(): MailgunLiveEnv {
  const domain = value('EMAIL_PROVIDER_DOMAIN');
  return {
    apiKey: new Secret(value('EMAIL_PROVIDER_API_KEY')),
    domain,
    baseUrl: value('EMAIL_PROVIDER_BASE_URL').replace(/\/+$/, ''),
    // [P09.TST.h]: remitente no-reply@<EMAIL_PROVIDER_DOMAIN>.
    from: `no-reply@${domain}`,
  };
}

export function gmailLiveEnv(): GmailLiveEnv {
  return {
    address: value('EMAIL_TEST_ADDRESS').toLowerCase(),
    clientId: value('EMAIL_TEST_GOOGLE_CLIENT_ID'),
    clientSecret: new Secret(value('EMAIL_TEST_GOOGLE_CLIENT_SECRET')),
    refreshToken: new Secret(value('EMAIL_TEST_GOOGLE_REFRESH_TOKEN')),
  };
}
