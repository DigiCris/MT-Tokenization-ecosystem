// pnpm policy:verify [<ruta>] [--public-key <SPKI base64>]
// Verifica la firma Ed25519 y el formato del snapshot con la clave pública de policy (POLICY_SIGNING_PUBLIC_KEY del
// entorno o de wallet/.env, o --public-key). El anti-rollback lo aplica el signer contra su DB al arrancar.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseDotenv } from '../src/config/dotenv.ts';
import { WALLET_ROOT } from '../src/config/env.ts';
import { args, fail, output, run } from '../src/cli/common.ts';
import { policyPublicKey, verifySnapshot } from '../src/policy/snapshot.ts';

await run(() => {
  const parsed = args({ 'public-key': { type: 'string' }, path: { type: 'string' } });
  const positionals = parsed.positionals;
  const base = process.env.INIT_CWD ?? process.cwd();
  const target =
    parsed.values.path ?? positionals[0] ?? resolve(WALLET_ROOT, 'config/policy/local/policy-snapshot.json');
  const path = isAbsolute(target) ? target : resolve(base, target);
  const envFile = resolve(WALLET_ROOT, '.env');
  const publicKey =
    parsed.values['public-key'] ??
    process.env.POLICY_SIGNING_PUBLIC_KEY ??
    (existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')).POLICY_SIGNING_PUBLIC_KEY : undefined);
  if (publicKey === undefined || publicKey === '') fail('falta POLICY_SIGNING_PUBLIC_KEY (o --public-key)');
  if (!existsSync(`${path}.sig`)) fail(`falta la firma ${path}.sig (pnpm policy:sign)`);
  const loaded = verifySnapshot(readFileSync(path), readFileSync(`${path}.sig`, 'utf8'), policyPublicKey(publicKey));
  output({
    ok: true,
    path,
    version: loaded.snapshot.version,
    environment: loaded.snapshot.environment,
    sha256: loaded.sha256,
    issuedAt: loaded.snapshot.issuedAt,
  });
});
