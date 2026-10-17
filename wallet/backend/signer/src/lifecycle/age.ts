// Cifrado con `age` (binario fijado en la toolchain, scripts/tools/versions.json) para backups y custodia [B-SIG-08],
// ADR-031. El contenido viaja por stdin/stdout: nunca por argumentos ni archivos temporales en claro.
import { spawnSync } from 'node:child_process';

export class AgeError extends Error {
  override name = 'AgeError';
}

const RECIPIENT = /^age1[0-9a-z]{58}$/;

export function isAgeRecipient(value: string): boolean {
  return RECIPIENT.test(value);
}

function run(args: string[], input: Buffer): Buffer {
  const result = spawnSync('age', args, { input, maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined)
    throw new AgeError('no se encontró el binario age (pnpm --dir wallet exec scripts/tools/bootstrap age)');
  if (result.status !== 0) throw new AgeError(`age falló: ${result.stderr.toString('utf8').split('\n')[0] ?? ''}`);
  return result.stdout;
}

export function ageEncrypt(plaintext: Buffer, recipients: readonly string[]): Buffer {
  if (recipients.length === 0 || !recipients.every(isAgeRecipient)) throw new AgeError('destinatarios age inválidos');
  return run(
    recipients.flatMap((r) => ['-r', r]),
    plaintext,
  );
}

export function ageDecrypt(ciphertext: Buffer, identityFile: string): Buffer {
  return run(['-d', '-i', identityFile], ciphertext);
}
