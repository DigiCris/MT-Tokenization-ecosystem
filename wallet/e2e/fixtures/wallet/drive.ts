// Drive real desde la Wallet en el E2E: el consentimiento y el bloqueo de la revocación son los compartidos
// (fixtures/drive.ts); acá, el cliente de Drive de la app y la limpieza de los backups de U que dejó cada test.
import { DriveClient } from '../../../frontend/wallet/src/drive/client.ts';
import { driveTestToken } from '../drive.ts';

export { answerGoogleConsent, blockGoogleRevocation, driveTestToken, type GoogleConsent } from '../drive.ts';

export async function testDrive(): Promise<DriveClient> {
  const accessToken = await driveTestToken();
  return new DriveClient(() => accessToken);
}

/** Borra de la carpeta de la app los `U.enc.json` cuyo contenido es exactamente el de este test. */
export async function removeEnvelopeBackup(content: string): Promise<number> {
  const drive = await testDrive();
  let removed = 0;
  for (const file of await drive.list('U.enc.json')) {
    const stored = new TextDecoder().decode(await drive.download(file.id));
    if (stored === content) {
      await drive.remove(file.id);
      removed++;
    }
  }
  return removed;
}
