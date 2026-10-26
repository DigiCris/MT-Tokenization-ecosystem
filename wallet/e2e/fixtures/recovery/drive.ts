// Drive real desde Recovery en el E2E: el consentimiento y el bloqueo de la revocación son los compartidos
// (fixtures/drive.ts); acá, el cliente de Drive de la app y la limpieza de los backups de R que dejó cada test.
import { DriveClient } from '../../../frontend/recovery/src/drive/client.ts';
import { driveTestToken } from '../drive.ts';

export { answerGoogleConsent, blockGoogleRevocation, driveTestToken, type GoogleConsent } from '../drive.ts';

export async function testDrive(): Promise<DriveClient> {
  const accessToken = await driveTestToken();
  return new DriveClient(() => accessToken);
}

/**
 * Borra los backups de R de una wallet de este test: uno por clave (`R.enc.<walletId>.<dirección>.json`) y el del nombre
 * anterior, por wallet. La wallet es propia de cada corrida: no toca los de otras.
 */
export async function removeRecoveryBackup(walletId: string): Promise<void> {
  const drive = await testDrive();
  const mine = (name: string) => name === `R.enc.${walletId}.json` || name.startsWith(`R.enc.${walletId}.`);
  for (const file of await drive.listMatching(mine)) await drive.remove(file.id);
}
