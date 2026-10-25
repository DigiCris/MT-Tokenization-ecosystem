// @vitest-environment jsdom
// P17.T02 [F-DRV-02]/[F-DRV-05]: forma de los requests a Drive v3 (sólo appDataFolder, multipart, token Bearer sin
// cookies ni referrer), errores, verificación post-subida byte a byte y chequeo de salud del backup. Contra la API real
// lo prueba test/live/drive.live.test.ts con la cuenta de prueba.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import envelopeVectors from '../../test/vectors/wire/envelope.json';
import { utf8 } from '../crypto/bytes.ts';
import { parseEnvelope, serializeEnvelope } from '../crypto/envelope.ts';
import {
  backupHealth,
  backupHealthText,
  checkBackupHealth,
  downloadEnvelope,
  envelopeSha256,
  ENVELOPE_FILE,
  forgetBackupHealth,
  HEALTH_INTERVAL_MS,
  uploadEnvelope,
} from './backup.ts';
import { DriveClient, DriveError } from './client.ts';

const envelope = parseEnvelope(
  (envelopeVectors as unknown as { envelopes: { envelope: unknown }[] }).envelopes[0]?.envelope,
);

/** Drive en memoria con la semántica de la API (ids, appDataFolder, multipart) para probar el cliente. */
function fakeDrive(options: { corrupt?: boolean; beforePatch?: (id: string) => void } = {}) {
  const files = new Map<string, { name: string; content: Uint8Array; modifiedTime: string }>();
  let next = 1;
  const calls: { method: string; url: URL; headers: Record<string, string>; init: RequestInit }[] = [];
  const handle = (input: RequestInfo | URL, init: RequestInit): Response => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? 'GET';
    calls.push({ method, url, headers: init.headers as Record<string, string>, init });
    const id = /\/files\/([^/?]+)/.exec(url.pathname)?.[1];
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const name = /name='([^']+)'/.exec(url.searchParams.get('q') ?? '')?.[1];
      const list = [...files.entries()]
        .filter(([, f]) => f.name === name)
        .map(([fid, f]) => ({ id: fid, name: f.name, modifiedTime: f.modifiedTime }))
        .reverse();
      return Response.json({ files: list });
    }
    if (method === 'GET' && id) {
      const file = files.get(id);
      if (!file) return new Response(null, { status: 404 });
      const content = options.corrupt ? utf8('alterado') : file.content;
      return new Response(new Uint8Array(content));
    }
    if (method === 'DELETE' && id) return new Response(null, { status: files.delete(id) ? 204 : 404 });
    if (method === 'PATCH' && id) {
      options.beforePatch?.(id);
      if (!files.has(id)) return new Response(null, { status: 404 });
    }
    if (method === 'POST' || method === 'PATCH') {
      const type = (init.headers as Record<string, string>)['Content-Type'] ?? '';
      const boundary = /boundary=(.+)$/.exec(type)?.[1] ?? '';
      const text = new TextDecoder().decode(init.body as Uint8Array);
      const parts = text.split(`--${boundary}`);
      const metadata = JSON.parse(parts[1]?.split('\r\n\r\n')[1] ?? '{}') as { name?: string; parents?: string[] };
      const media = parts[2]?.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '') ?? '';
      const fid = method === 'POST' ? `f${String(next++)}` : (id ?? '');
      if (method === 'POST' && metadata.parents?.[0] !== 'appDataFolder') return new Response(null, { status: 400 });
      const name = method === 'POST' ? (metadata.name ?? '') : (files.get(fid)?.name ?? '');
      files.set(fid, { name, content: utf8(media), modifiedTime: new Date(Date.now() + next).toISOString() });
      return Response.json({ id: fid, name });
    }
    return new Response(null, { status: 500 });
  };
  const fetcher = vi.fn<typeof fetch>((input, init = {}) => Promise.resolve(handle(input, init)));
  return { files, calls, client: new DriveClient(() => 'token-de-prueba', fetcher) };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('DriveClient', () => {
  it('requests con Bearer, sin cookies ni referrer, sólo en appDataFolder', async () => {
    const { client, calls } = fakeDrive();
    const created = await client.create('x.json', utf8('{"a":1}'));
    await client.find('x.json');
    await client.download(created.id);
    await client.update(created.id, utf8('{"a":2}'));
    await client.remove(created.id);
    for (const call of calls) {
      expect(call.headers.Authorization).toBe('Bearer token-de-prueba');
      expect(call.init).toMatchObject({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      expect(call.url.origin).toBe('https://www.googleapis.com');
    }
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /upload/drive/v3/files',
      'GET /drive/v3/files',
      `GET /drive/v3/files/${created.id}`,
      `PATCH /upload/drive/v3/files/${created.id}`,
      `DELETE /drive/v3/files/${created.id}`,
    ]);
    const list = calls[1]?.url.searchParams;
    expect(list?.get('spaces')).toBe('appDataFolder');
    expect(list?.get('q')).toBe("name='x.json' and trashed=false");
    expect(calls[0]?.url.searchParams.get('uploadType')).toBe('multipart');
    expect(calls[2]?.url.searchParams.get('alt')).toBe('media');
    await expect(client.find("x' or name='y")).rejects.toThrow(TypeError);
  });

  it('errores: sin token, 401, 403, 404, 429, red caída y respuesta inválida', async () => {
    await expect(new DriveClient(() => null).find('a.json')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    for (const [status, code] of [
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [500, 'UNEXPECTED'],
    ] as const) {
      const client = new DriveClient(
        () => 't',
        () => Promise.resolve(new Response(null, { status })),
      );
      await expect(client.download('id')).rejects.toMatchObject({ code, status });
    }
    const offline = new DriveClient(
      () => 't',
      () => Promise.reject(new TypeError('Failed to fetch')),
    );
    await expect(offline.find('a.json')).rejects.toMatchObject({ code: 'NETWORK' });
    const garbage = new DriveClient(
      () => 't',
      () => Promise.resolve(new Response('no json')),
    );
    await expect(garbage.find('a.json')).rejects.toMatchObject({ code: 'UNEXPECTED' });
    const badList = new DriveClient(
      () => 't',
      () => Promise.resolve(Response.json({ files: [{ nope: 1 }] })),
    );
    await expect(badList.find('a.json')).rejects.toBeInstanceOf(DriveError);
  });

  it('uploadVerified: crea o reemplaza, verifica byte a byte y limpia copias viejas', async () => {
    const drive = fakeDrive();
    const first = await drive.client.uploadVerified('b.json', utf8('uno'));
    expect(first.replaced).toBe(false);
    await drive.client.create('b.json', utf8('copia vieja'));
    const second = await drive.client.uploadVerified('b.json', utf8('dos'));
    expect(second.replaced).toBe(true);
    expect([...drive.files.values()].filter((f) => f.name === 'b.json')).toHaveLength(1);
    const corrupt = fakeDrive({ corrupt: true });
    await expect(corrupt.client.uploadVerified('c.json', utf8('tres'))).rejects.toMatchObject({ code: 'MISMATCH' });
  });

  it('uploadVerified: si el archivo listado desaparece antes de reemplazarlo (404), lo crea de nuevo', async () => {
    // Otro dispositivo (o la configuración de Google) lo borra entre el listado y el reemplazo.
    const drive = fakeDrive({ beforePatch: (id) => drive.files.delete(id) });
    await drive.client.create('d.json', utf8('viejo'));
    const result = await drive.client.uploadVerified('d.json', utf8('nuevo'));
    expect(result.replaced).toBe(false);
    const stored = [...drive.files.values()].filter((f) => f.name === 'd.json');
    expect(stored.map((f) => new TextDecoder().decode(f.content))).toEqual(['nuevo']);
  });
});

describe('backup del sobre en Drive [F-DRV-05]', () => {
  it('sube el sobre exacto, lo vuelve a leer validado y deja el chequeo en verde', async () => {
    const drive = fakeDrive();
    await uploadEnvelope(drive.client, envelope);
    const stored = [...drive.files.values()].find((f) => f.name === ENVELOPE_FILE);
    expect(new TextDecoder().decode(stored?.content)).toBe(serializeEnvelope(envelope));
    expect(await downloadEnvelope(drive.client)).toEqual(envelope);
    expect(backupHealth()).toMatchObject({ status: 'ok', due: false });
    expect(window.localStorage.getItem('mtw.flag.drive.backup.sha256')).toBe(await envelopeSha256(envelope));
  });

  it('a los 7 días toca chequear; si falta o no coincide queda la alerta hasta re-subirlo', async () => {
    const drive = fakeDrive();
    expect(backupHealth().due).toBe(false);
    await uploadEnvelope(drive.client, envelope);
    expect(backupHealth(Date.now() + HEALTH_INTERVAL_MS).due).toBe(true);
    for (const [id] of drive.files) await drive.client.remove(id);
    expect(await checkBackupHealth(drive.client)).toBe('missing');
    expect(backupHealth()).toMatchObject({ status: 'missing', due: true });
    await drive.client.create(ENVELOPE_FILE, utf8('{"otro":"sobre"}'));
    expect(await checkBackupHealth(drive.client, envelope)).toBe('mismatch');
    await uploadEnvelope(drive.client, envelope);
    expect(await checkBackupHealth(drive.client)).toBe('ok');
    await drive.client.create(ENVELOPE_FILE, utf8('{"format":"otro"}'));
    await expect(downloadEnvelope(drive.client)).rejects.toThrow();
    forgetBackupHealth();
    expect(backupHealth()).toEqual({ status: 'unknown', checkedAt: null, due: false });
  });

  it('el estado que ve el usuario es el de la última verificación, con su fecha y hora', () => {
    const checkedAt = Date.parse('2026-10-19T15:42:00Z');
    expect(backupHealthText({ status: 'ok', checkedAt, due: false }, 'UTC')).toBe(
      'En la última verificación (19/10/2026, 15:42), el backup en Drive estaba y coincidía con tu sobre.',
    );
    expect(backupHealthText({ status: 'ok', checkedAt, due: true }, 'UTC')).toMatch(
      /coincidía con tu sobre\. Toca verificarlo de nuevo\.$/,
    );
    expect(backupHealthText({ status: 'missing', checkedAt, due: true }, 'UTC')).toBe(
      'En la última verificación (19/10/2026, 15:42) faltaba el backup en Drive: volvé a subirlo.',
    );
    expect(backupHealthText({ status: 'mismatch', checkedAt: null, due: true })).toBe(
      'En la última verificación, el backup en Drive no coincidía con tu sobre actual: volvé a subirlo.',
    );
    expect(backupHealthText({ status: 'unknown', checkedAt: null, due: false })).toBe(
      'Todavía no se verificó el backup en Drive en este dispositivo.',
    );
  });

  it('sin backup en Drive, downloadEnvelope devuelve null; un archivo que no es UTF-8/JSON no es un sobre', async () => {
    const drive = fakeDrive();
    expect(await downloadEnvelope(drive.client)).toBeNull();
    await drive.client.create(ENVELOPE_FILE, Uint8Array.of(0xff, 0xfe));
    await expect(downloadEnvelope(drive.client)).rejects.toMatchObject({ code: 'UNEXPECTED' });
  });
});
