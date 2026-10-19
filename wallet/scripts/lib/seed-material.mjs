#!/usr/bin/env node
// Material determinístico del seed local (P21.T04; sólo desarrollo, lo usa scripts/seed-local). Todo sale de LOCAL_SEED
// (wallet/.env, nunca se imprime) con keccak256 (`cast keccak`), igual que contracts/script/lib/LocalKeys.sol:
//   - walletId: UUID (v4) de keccak256("mtw-local-wallet" ‖ seed);
//   - claves U y R del seed: keccak256("mtw-local-key" ‖ seed ‖ label), re-hasheadas mientras no caigan en [1, n);
//   - email, contraseña de cuenta, Password U y Password R (5 palabras de MTW-WORDLIST-V1) de prueba.
// Escribe .secrets/seed/credentials.json (0600; sin claves privadas) y, con --keys, imprime las dos claves en hex en una
// línea JSON para pasarlas por variables de entorno a los scripts de sobres (nunca a un archivo).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const value = (name) =>
  process.env[name] ||
  execFileSync('node', [join(ROOT, 'scripts/lib/env-value.mjs'), name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const seed = value('LOCAL_SEED').replace(/^0x/, '');
if (!/^[0-9a-fA-F]{64}$/.test(seed) || /^0+$/.test(seed)) throw new Error('LOCAL_SEED inválida (32 bytes en hex)');
const platformId = value('PLATFORM_ID');
const hex = (text) => Buffer.from(text, 'utf8').toString('hex');
const keccak = (data) => execFileSync('cast', ['keccak', `0x${data}`], { encoding: 'utf8' }).trim().slice(2);

function localKey(label) {
  let digest = keccak(`${hex('mtw-local-key')}${seed}${hex(label)}`);
  while (BigInt(`0x${digest}`) === 0n || BigInt(`0x${digest}`) >= N) digest = keccak(digest);
  return digest;
}

const words = readFileSync(join(ROOT, 'config/wordlist/mtw-wordlist-v1.txt'), 'utf8').split('\n').filter(Boolean);
function password(label) {
  return Array.from({ length: 5 }, (_, i) => {
    const digest = keccak(`${hex(label)}${seed}${i.toString(16).padStart(2, '0')}`);
    return words[Number.parseInt(digest.slice(0, 8), 16) % words.length];
  }).join(' ');
}

const id = keccak(`${hex('mtw-local-wallet')}${seed}`).slice(0, 32).split('');
id[12] = '4';
id[16] = ((Number.parseInt(id[16], 16) & 0x3) | 0x8).toString(16);
const walletId = `${id.slice(0, 8).join('')}-${id.slice(8, 12).join('')}-${id.slice(12, 16).join('')}-${id.slice(16, 20).join('')}-${id.slice(20).join('')}`;
const credentials = {
  platformId,
  walletId,
  email: 'seed@mtw-local.test',
  accountPassword: `Seed-${keccak(`${hex('mtw-local-account')}${seed}`).slice(0, 16)}-Ok!`,
  passwordU: password('mtw-local-password-u'),
  passwordR: password('mtw-local-password-r'),
};
const dir = join(ROOT, '.secrets/seed');
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, 'credentials.json'), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(
  `${JSON.stringify(process.argv.includes('--keys') ? { walletId, userKey: localKey('seed-user-key'), recoveryKey: localKey('seed-recovery-key') } : { walletId })}\n`,
);
