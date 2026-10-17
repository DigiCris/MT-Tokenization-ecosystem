import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from '../lib/env.mjs';
import { missingLocalSecrets } from '../checks/config.mjs';
import { WALLET_ROOT, tmp, validLocalEnv } from './helpers.mjs';

const script = join(WALLET_ROOT, 'scripts/lib/secrets-local.mjs');

function envInTmp() {
  const dir = tmp('mtw-secrets-');
  const text = validLocalEnv()
    .replace(/^SIGNER_KEYSTORE_DIR=.*$/m, `SIGNER_KEYSTORE_DIR=${dir}/signer/keystore`)
    .replace(/^SIGNER_UNLOCK_CREDENTIAL_FILE=.*$/m, `SIGNER_UNLOCK_CREDENTIAL_FILE=${dir}/signer/unlock.key`)
    .replace(/^MTLS_CA_CERT_PATH=.*$/m, `MTLS_CA_CERT_PATH=${dir}/mtls/ca.pem`)
    .replace(/^MTLS_BACKEND_CLIENT_CERT_PATH=.*$/m, `MTLS_BACKEND_CLIENT_CERT_PATH=${dir}/mtls/backend-client.pem`)
    .replace(/^MTLS_BACKEND_CLIENT_KEY_PATH=.*$/m, `MTLS_BACKEND_CLIENT_KEY_PATH=${dir}/mtls/backend-client-key.pem`)
    .replace(/^MTLS_SIGNER_SERVER_CERT_PATH=.*$/m, `MTLS_SIGNER_SERVER_CERT_PATH=${dir}/mtls/signer-server.pem`)
    .replace(/^MTLS_SIGNER_SERVER_KEY_PATH=.*$/m, `MTLS_SIGNER_SERVER_KEY_PATH=${dir}/mtls/signer-server-key.pem`);
  const envFile = join(dir, '.env');
  writeFileSync(envFile, text, { mode: 0o600 });
  return { dir, envFile };
}

const runScript = (envFile, extraEnv = {}) => spawnSync(process.execPath, [script], { env: { ...process.env, APP_ENV: '', ...extraEnv, MTW_ENV_FILE: envFile }, encoding: 'utf8' });

test('secrets-local se niega con APP_ENV=staging y no toca el archivo', () => {
  const { envFile } = envInTmp();
  const before = readFileSync(envFile, 'utf8');
  const r = runScript(envFile, { APP_ENV: 'staging' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /se niega/);
  assert.equal(readFileSync(envFile, 'utf8'), before);
});

test('secrets-local genera secretos válidos y es idempotente (segunda corrida no cambia nada)', () => {
  const { dir, envFile } = envInTmp();
  const r1 = runScript(envFile);
  assert.equal(r1.status, 0, r1.stderr);
  const env1 = parseEnv(readFileSync(envFile, 'utf8'));
  assert.deepEqual(missingLocalSecrets(env1), []);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'signer/unlock.key')).mode & 0o777, 0o600);
  assert.ok(existsSync(join(dir, 'mtls/signer-server.pem')));
  const verify = spawnSync('openssl', ['verify', '-CAfile', join(dir, 'mtls/ca.pem'), join(dir, 'mtls/signer-server.pem'), join(dir, 'mtls/backend-client.pem')], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  // Nunca imprime valores: ningún secreto generado aparece en la salida.
  for (const k of ['SESSION_SECRET', 'POSTGRES_PASSWORD', 'SESSION_ISSUER_PRIVATE_KEY']) assert.ok(!r1.stderr.includes(env1[k]));
  const before = readFileSync(envFile, 'utf8');
  const cred = readFileSync(join(dir, 'signer/unlock.key'), 'utf8');
  const r2 = runScript(envFile);
  assert.equal(r2.status, 0);
  assert.equal(readFileSync(envFile, 'utf8'), before);
  assert.equal(readFileSync(join(dir, 'signer/unlock.key'), 'utf8'), cred);
  assert.match(r2.stderr, /no había nada que generar/);
});
