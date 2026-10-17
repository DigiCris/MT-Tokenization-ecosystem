// pnpm policy:sign [<ruta>] [--key-file <archivo>]
// Firma Ed25519 de los bytes exactos del snapshot (→ <ruta>.sig, base64). Local: POLICY_SIGNING_PRIVATE_KEY_LOCAL de
// wallet/.env (sólo APP_ENV=local). Ensayos de staging/producción: --key-file con la clave de policy del entorno en
// ~/.config/mtw/secrets/<entorno>/ (fuera del repo); en el despliegue final se re-firma offline.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseDotenv } from '../src/config/dotenv.ts';
import { WALLET_ROOT } from '../src/config/env.ts';
import { ed25519PrivateKey } from '../src/crypto/jws.ts';
import { args, fail, output, run } from '../src/cli/common.ts';
import { signSnapshotBytes } from '../src/policy/build.ts';
import { PolicySnapshotSchema } from '../src/policy/snapshot.ts';

await run(() => {
  const { values, positionals } = args({ 'key-file': { type: 'string' }, path: { type: 'string' } });
  const base = process.env.INIT_CWD ?? process.cwd();
  const target = values.path ?? positionals[0] ?? resolve(WALLET_ROOT, 'config/policy/local/policy-snapshot.json');
  const path = isAbsolute(target) ? target : resolve(base, target);
  const bytes = readFileSync(path);
  const snapshot = PolicySnapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
  let keyBase64: string | undefined;
  if (values['key-file'] !== undefined) {
    keyBase64 = readFileSync(values['key-file'], 'utf8').trim();
  } else {
    if (snapshot.environment !== 'local')
      fail(`un snapshot de ${snapshot.environment} se firma con --key-file (clave del entorno, fuera del repo)`);
    const appEnv = process.env.APP_ENV ?? 'local';
    if (appEnv !== 'local') fail('la clave local de policy sólo se usa con APP_ENV=local');
    const envFile = resolve(WALLET_ROOT, '.env');
    keyBase64 =
      process.env.POLICY_SIGNING_PRIVATE_KEY_LOCAL ??
      (existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')).POLICY_SIGNING_PRIVATE_KEY_LOCAL : undefined);
    if (keyBase64 === undefined || keyBase64 === '')
      fail('falta POLICY_SIGNING_PRIVATE_KEY_LOCAL (pnpm secrets:local)');
  }
  writeFileSync(`${path}.sig`, `${signSnapshotBytes(bytes, ed25519PrivateKey(keyBase64))}\n`);
  output({ path, signature: `${path}.sig`, version: snapshot.version, environment: snapshot.environment });
});
