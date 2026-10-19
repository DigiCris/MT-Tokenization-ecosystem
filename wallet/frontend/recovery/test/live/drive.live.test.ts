// P19 / P22.T04 [F-DRV-02]: el cliente Drive de Recovery contra la API real de Google, con la cuenta de prueba
// autorizada una vez (GOOGLE_DRIVE_TEST_*, el cliente `drive-tests` de los tests contra servicios reales). Corre en cada
// `pnpm ci:local` y en CI y nunca se saltea: sin credenciales falla. El refresh token sólo se usa acá, del lado de Node;
// al token de acceso nunca se le llama a `revoke` (revocaría también el refresh token de la cuenta de prueba). Cada
// corrida usa una wallet y nombres propios y borra lo que creó, así que puede correr en paralelo con otras.
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WALLET_ROOT } from '../../build/config.ts';
import { readEnvFile } from '../../build/env-file.ts';
import { utf8 } from '../../src/crypto/encoding.ts';
import { parseRecoveryEnvelope, serializeRecoveryEnvelope } from '../../src/crypto/envelope.ts';
import {
  backupName,
  downloadRecoveryEnvelope,
  listRecoveryBackups,
  uploadRecoveryEnvelope,
} from '../../src/drive/backup.ts';
import { DRIVE_API, DriveClient } from '../../src/drive/client.ts';
import { DRIVE_SCOPE } from '../../src/drive/token.ts';
import envelopeVectors from '../vectors/wire/envelope.json' with { type: 'json' };

const NAMES = ['GOOGLE_DRIVE_TEST_CLIENT_ID', 'GOOGLE_DRIVE_TEST_CLIENT_SECRET', 'GOOGLE_DRIVE_TEST_REFRESH_TOKEN'];
const RUN = `mtw-recovery-live-${String(Date.now())}-${crypto.randomUUID().slice(0, 8)}`;
const vector = envelopeVectors.envelopes.find((e) => e.envelope.role === 'R');
if (!vector) throw new Error('el vector de sobres no tiene el de R');
// El sobre del vector con una wallet propia de esta corrida: su nombre en Drive no choca con corridas en paralelo. Sólo
// se prueba el almacenamiento (el AAD con otra wallet ya no abre, y acá no se abre).
const envelope = parseRecoveryEnvelope({ ...vector.envelope, walletId: crypto.randomUUID() });

function credentials(): Record<string, string> {
  const dotenv = readEnvFile(resolve(WALLET_ROOT, '.env')) ?? {};
  const values = Object.fromEntries(NAMES.map((name) => [name, process.env[name] || dotenv[name] || '']));
  const missing = NAMES.filter((name) => values[name] === '');
  if (missing.length > 0) {
    throw new Error(
      `faltan ${missing.join(', ')}: los tests de Drive real son obligatorios (docs/SETUP_EXTERNAL_SERVICES.md)`,
    );
  }
  return values;
}

let accessToken = '';
let drive: DriveClient;

beforeAll(async () => {
  const c = credentials();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.GOOGLE_DRIVE_TEST_CLIENT_ID ?? '',
      client_secret: c.GOOGLE_DRIVE_TEST_CLIENT_SECRET ?? '',
      refresh_token: c.GOOGLE_DRIVE_TEST_REFRESH_TOKEN ?? '',
      grant_type: 'refresh_token',
    }).toString(),
  });
  const body = (await response.json()) as { access_token?: string; scope?: string; error?: string };
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error(
      `no se pudo obtener un token de la cuenta de prueba: ${String(response.status)} ${body.error ?? ''}`,
    );
  }
  expect(body.scope?.split(' ')).toEqual([DRIVE_SCOPE]);
  accessToken = body.access_token;
  drive = new DriveClient(() => accessToken);
});

afterAll(async () => {
  if (accessToken === '') return;
  for (const name of [`${RUN}-crud.json`, backupName(envelope.walletId)]) {
    for (const file of await drive.list(name)) await drive.remove(file.id);
  }
});

describe('Drive real: carpeta privada de la app', () => {
  it('crear, leer, reemplazar y borrar con verificación byte a byte', async () => {
    const name = `${RUN}-crud.json`;
    const first = await drive.uploadVerified(name, utf8('{"v":1}'));
    expect(first.replaced).toBe(false);
    expect((await drive.find(name))?.id).toBe(first.file.id);
    const second = await drive.uploadVerified(name, utf8('{"v":2,"ñ":"é"}'));
    expect(second).toMatchObject({ replaced: true, file: { id: first.file.id } });
    expect(new TextDecoder().decode(await drive.download(first.file.id))).toBe('{"v":2,"ñ":"é"}');
    await drive.remove(first.file.id);
    expect(await drive.find(name)).toBeNull();
    await expect(drive.download(first.file.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('el sobre de R se sube exacto, aparece al listar los backups y se baja validado', async () => {
    const file = await uploadRecoveryEnvelope(drive, envelope);
    expect(file.name).toBe(backupName(envelope.walletId));
    expect(new TextDecoder().decode(await drive.download(file.id))).toBe(serializeRecoveryEnvelope(envelope));
    const backup = (await listRecoveryBackups(drive)).find((b) => b.walletId === envelope.walletId);
    expect(backup?.file.id).toBe(file.id);
    if (!backup) throw new Error('el backup no aparece en la lista');
    expect(await downloadRecoveryEnvelope(drive, backup)).toEqual(envelope);
    await drive.remove(file.id);
    expect((await listRecoveryBackups(drive)).some((b) => b.walletId === envelope.walletId)).toBe(false);
  });

  it('el scope drive.appdata no ve el resto del Drive del usuario', async () => {
    const response = await fetch(`${DRIVE_API}/files?spaces=drive&pageSize=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(403);
  });
});
