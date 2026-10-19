#!/usr/bin/env node
// Genera secretos LOCALES aleatorios (P00.T04). Sólo con APP_ENV=local; nunca sobrescribe valores
// existentes; jamás imprime valores (sólo nombres). Staging/producción usan scripts/deploy/init-secrets.sh.
//
// Uso: node scripts/lib/secrets-local.mjs [--regen-mtls]
import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { randomBytes, generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { readEnvFile, updateEnvFile } from '../preflight.d/lib/env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = resolve(process.env.MTW_ENV_FILE ?? join(ROOT, '.env'));
const regenMtls = process.argv.includes('--regen-mtls');

if (!existsSync(envFile)) {
  copyFileSync(join(ROOT, '.env.example'), envFile);
  chmodSync(envFile, 0o600);
  console.error('secrets-local: wallet/.env creado desde .env.example');
}
const env = readEnvFile(envFile);
const appEnv = process.env.APP_ENV || env.APP_ENV;
if (appEnv !== 'local') {
  console.error(`secrets-local: se niega a correr con APP_ENV=${appEnv || '(vacío)'}; sólo genera secretos de desarrollo local. Staging/producción: scripts/deploy/init-secrets.sh (ADR-030).`);
  process.exit(3);
}

const updates = {};
const generated = [];
const current = (k) => updates[k] ?? env[k] ?? '';
const setIfEmpty = (k, gen) => {
  if (!current(k)) {
    updates[k] = gen();
    generated.push(k);
  }
};
// Variables nuevas de .env.example (agregadas en fases posteriores) que todavía no están en wallet/.env: se agregan
// con su valor por defecto; nunca se toca una clave que ya existe (aunque esté vacía).
const example = readEnvFile(join(ROOT, '.env.example')) ?? {};
const addedDefaults = [];
for (const [k, v] of Object.entries(example)) {
  if (!(k in env)) {
    updates[k] = v;
    addedDefaults.push(k);
  }
}
const hex = (n) => () => randomBytes(n).toString('hex');
const b64 = (n) => () => randomBytes(n).toString('base64');

for (const k of ['POSTGRES_PASSWORD', 'MTW_APP_DB_PASSWORD', 'MTW_MIGRATOR_DB_PASSWORD', 'MTW_SIGNER_DB_PASSWORD', 'REDIS_PASSWORD']) setIfEmpty(k, hex(24));
setIfEmpty('GRAFANA_ADMIN_PASSWORD', hex(16));
setIfEmpty('LOCAL_SEED', hex(32));
for (const k of ['SESSION_SECRET', 'CSRF_SECRET', 'APP_FIELD_ENCRYPTION_KEY', 'OTP_HMAC_KEY', 'PASSWORD_PEPPER_V1', 'AUDIT_CHAIN_KEY']) setIfEmpty(k, b64(32));

// Pares Ed25519: privada PKCS#8 DER y pública SPKI DER, ambas en base64.
const ED_PAIRS = [
  ['SESSION_ISSUER_PRIVATE_KEY', 'SESSION_ISSUER_PUBLIC_KEY'],
  ['SIGNER_ATTESTATION_PRIVATE_KEY', 'SIGNER_ATTESTATION_PUBLIC_KEY'],
  ['POLICY_SIGNING_PRIVATE_KEY_LOCAL', 'POLICY_SIGNING_PUBLIC_KEY'],
  ['INTEGRITY_MONITOR_PRIVATE_KEY', 'INTEGRITY_MONITOR_PUBLIC_KEY'],
  ['WALLET_RELEASE_SIGNING_KEY_LOCAL', 'WALLET_RELEASE_PUBLIC_KEY'],
  ['RECOVERY_RELEASE_SIGNING_KEY_LOCAL', 'RECOVERY_RELEASE_PUBLIC_KEY'],
  ['SOVEREIGN_EXIT_RELEASE_SIGNING_KEY_LOCAL', 'SOVEREIGN_EXIT_RELEASE_PUBLIC_KEY'],
];
for (const [priv, pub] of ED_PAIRS) {
  if (!current(priv)) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    updates[priv] = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    updates[pub] = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    generated.push(priv, pub);
  } else if (!current(pub)) {
    const key = createPrivateKey({ key: Buffer.from(current(priv), 'base64'), format: 'der', type: 'pkcs8' });
    updates[pub] = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
    generated.push(pub);
  }
}

// URLs de conexión compuestas con las passwords finales (sólo si están vacías).
const pgPort = current('POSTGRES_HOST_PORT') || '55432';
const pgDb = current('POSTGRES_DB') || 'mtw_wallet';
setIfEmpty('DATABASE_URL', () => `postgres://mtw_app:${current('MTW_APP_DB_PASSWORD')}@127.0.0.1:${pgPort}/${pgDb}`);
setIfEmpty('DATABASE_MIGRATION_URL', () => `postgres://mtw_migrator:${current('MTW_MIGRATOR_DB_PASSWORD')}@127.0.0.1:${pgPort}/${pgDb}`);
setIfEmpty('SIGNER_DATABASE_URL', () => `postgres://mtw_signer:${current('MTW_SIGNER_DB_PASSWORD')}@127.0.0.1:${pgPort}/mtw_signer_dev`);
setIfEmpty('SIGNER_PLATFORM_DATABASE_URL', () => `postgres://mtw_signer:${current('MTW_SIGNER_DB_PASSWORD')}@127.0.0.1:${pgPort}/mtw_signer_platform_dev`);
setIfEmpty('REDIS_URL', () => `redis://:${current('REDIS_PASSWORD')}@127.0.0.1:${current('REDIS_HOST_PORT') || '56379'}/0`);

if (Object.keys(updates).length) updateEnvFile(envFile, updates);

// Archivos: directorio de keystores del signer y credencial de desbloqueo (en otro directorio).
const abs = (p) => (isAbsolute(p) ? p : resolve(ROOT, p));
const files = [];
const ksDir = abs(current('SIGNER_KEYSTORE_DIR') || './.secrets/signer/dev-1/keystore');
if (!existsSync(ksDir)) {
  mkdirSync(ksDir, { recursive: true, mode: 0o700 });
  files.push('directorio de keystores del signer');
}
chmodSync(ksDir, 0o700);
const credFile = abs(current('SIGNER_UNLOCK_CREDENTIAL_FILE') || './.secrets/signer/dev-1/unlock.key');
if (!existsSync(credFile)) {
  mkdirSync(dirname(credFile), { recursive: true, mode: 0o700 });
  writeFileSync(credFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  files.push('credencial de desbloqueo del shard dev-1');
}
chmodSync(credFile, 0o600);

// Shard `platform` (cuenta gas tank): keystores y credencial propios, también separados entre sí.
const platformKs = abs(current('SIGNER_PLATFORM_KEYSTORE_DIR') || './.secrets/signer/platform/keystore');
if (!existsSync(platformKs)) {
  mkdirSync(platformKs, { recursive: true, mode: 0o700 });
  files.push('directorio de keystores del shard platform');
}
chmodSync(platformKs, 0o700);
const platformCred = abs(current('SIGNER_PLATFORM_UNLOCK_CREDENTIAL_FILE') || './.secrets/signer/platform/unlock.key');
if (!existsSync(platformCred)) {
  mkdirSync(dirname(platformCred), { recursive: true, mode: 0o700 });
  writeFileSync(platformCred, randomBytes(32).toString('hex'), { mode: 0o600 });
  files.push('credencial de desbloqueo del shard platform');
}
chmodSync(platformCred, 0o600);

// mTLS de desarrollo: CA propia + certificado de servidor del signer + certificado cliente del backend.
const mtls = {
  ca: abs(current('MTLS_CA_CERT_PATH') || './.secrets/mtls/ca.pem'),
  clientCert: abs(current('MTLS_BACKEND_CLIENT_CERT_PATH') || './.secrets/mtls/backend-client.pem'),
  clientKey: abs(current('MTLS_BACKEND_CLIENT_KEY_PATH') || './.secrets/mtls/backend-client-key.pem'),
  serverCert: abs(current('MTLS_SIGNER_SERVER_CERT_PATH') || './.secrets/mtls/signer-server.pem'),
  serverKey: abs(current('MTLS_SIGNER_SERVER_KEY_PATH') || './.secrets/mtls/signer-server-key.pem'),
};
if (regenMtls || Object.values(mtls).some((p) => !existsSync(p))) {
  generateMtls(mtls);
  files.push('CA y certificados mTLS de desarrollo');
}

function openssl(args) {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`secrets-local: openssl ${args[0]} falló: ${(r.stderr || '').split('\n')[0]}`);
    process.exit(1);
  }
}

function generateMtls(p) {
  const dir = dirname(p.ca);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caKey = join(dir, 'ca-key.pem');
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKey]);
  openssl(['req', '-x509', '-new', '-key', caKey, '-sha256', '-days', '825', '-subj', '/CN=MTW Local Dev CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', p.ca]);
  const leaf = (key, cert, cn, ext) => {
    const csr = `${cert}.csr`;
    const extFile = `${cert}.ext`;
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    openssl(['req', '-new', '-key', key, '-subj', `/CN=${cn}`, '-out', csr]);
    writeFileSync(extFile, ext);
    openssl(['x509', '-req', '-in', csr, '-CA', p.ca, '-CAkey', caKey, '-CAcreateserial', '-days', '365', '-sha256', '-extfile', extFile, '-out', cert]);
    rmSync(csr);
    rmSync(extFile);
    chmodSync(key, 0o600);
  };
  leaf(p.serverKey, p.serverCert, 'mtw-signer-dev-1', 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:signer,DNS:signer-dev-1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n');
  leaf(p.clientKey, p.clientCert, 'mtw-backend', 'extendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n');
  chmodSync(caKey, 0o600);
  rmSync(join(dir, 'ca.srl'), { force: true });
}

if (addedDefaults.length) console.error(`secrets-local: agregadas ${addedDefaults.length} variables nuevas de .env.example: ${addedDefaults.join(', ')}`);
if (!generated.length && !files.length && !addedDefaults.length) console.error('secrets-local: no había nada que generar (no se sobrescribe ningún valor existente)');
else {
  if (generated.length) console.error(`secrets-local: generadas ${generated.length} variables en wallet/.env: ${generated.join(', ')}`);
  for (const f of files) console.error(`secrets-local: generado: ${f}`);
}
