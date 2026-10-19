// Claves Ed25519 para el monitor (P20): la de atestación del monitor o la de un operador. Escribe la privada en un
// archivo nuevo con permisos 0600 (PEM PKCS#8; nunca por stdout) y muestra sólo la pública (SPKI DER base64), que es la
// que se fija en el signer y el backend (atestación) o en MONITOR_OPERATOR_KEYS (operador).
//
//   pnpm keys:generate --out <archivo nuevo>
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (values.out === undefined) {
  process.stderr.write('uso: pnpm keys:generate --out <archivo nuevo>\n');
  process.exit(2);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(values.out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
process.stdout.write(
  `${JSON.stringify({ publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })}\n`,
);
