// P19.T03/T08 [F-DRV-02]: el cliente REST de Drive de Recovery (sólo appDataFolder, multipart, Bearer sin cookies ni
// referrer), errores, verificación post-subida byte a byte, listado paginado y el backup del sobre de R: uno por clave,
// `R.enc.<walletId>.<dirección>.json`, así un reemplazo no pisa la copia de la R vigente (N13 de la verificación de
// P17.MAN); al restaurar se aceptan también los de antes (`R.enc.<walletId>.json`) y cada sobre se valida contra su
// nombre. Contra la API real lo prueba test/live/drive.live.test.ts con la cuenta de prueba.
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import envelopeVectors from '../../test/vectors/wire/envelope.json' with { type: 'json' };
import { utf8 } from '../crypto/encoding.ts';
import { parseRecoveryEnvelope, serializeRecoveryEnvelope } from '../crypto/envelope.ts';
import { backupName, listRecoveryBackups, readRecoveryBackup, uploadRecoveryEnvelope } from './backup.ts';
import { DriveClient, DriveError } from './client.ts';

const vector = envelopeVectors.envelopes.find((e) => e.envelope.role === 'R');
if (!vector) throw new Error('el vector de sobres no tiene el de R');
const envelope = parseRecoveryEnvelope(vector.envelope);
/** El sobre de R′ de un reemplazo de la misma wallet (otra dirección; el cifrado no se abre en estos tests). */
const replacement = parseRecoveryEnvelope({
  ...vector.envelope,
  keyAddress: getAddress('0x5a3c9b11e0f4d2a7c8b6e5f4a3b2c1d0e9f8a7b6'),
});
if (replacement.keyAddress === envelope.keyAddress) throw new Error('R′ tiene que ser otra clave');

/** Drive en memoria con la semántica de la API (ids, appDataFolder, multipart, páginas) para probar el cliente. */
function fakeDrive(
  options: {
    corrupt?: boolean;
    pageSize?: number;
    status?: number;
    beforePatch?: (id: string) => void;
    /** Antes de borrar: otro dispositivo lo borra, o Drive responde otro status. */
    beforeDelete?: (id: string) => number | undefined;
  } = {},
) {
  const files = new Map<string, { name: string; content: Uint8Array; modifiedTime: string }>();
  let next = 1;
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  const handle = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, init });
    if (options.status !== undefined) return new Response(null, { status: options.status });
    const id = /\/files\/([^/?]+)/.exec(url.pathname)?.[1];
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const name = /name='([^']+)'/.exec(url.searchParams.get('q') ?? '')?.[1];
      const all = [...files.entries()]
        .filter(([, f]) => name === undefined || f.name === name)
        .map(([fid, f]) => ({ id: fid, name: f.name, modifiedTime: f.modifiedTime }))
        .reverse();
      const size = options.pageSize ?? all.length;
      const start = Number(url.searchParams.get('pageToken') ?? '0');
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      return Response.json({ files: page, ...(more ? { nextPageToken: String(start + size) } : {}) });
    }
    if (method === 'GET' && id) {
      const file = files.get(id);
      if (!file) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(options.corrupt ? utf8('alterado') : file.content));
    }
    if (method === 'DELETE' && id) {
      const forced = options.beforeDelete?.(id);
      if (forced !== undefined) return new Response(null, { status: forced });
      return new Response(null, { status: files.delete(id) ? 204 : 404 });
    }
    if (method === 'PATCH' && id) {
      options.beforePatch?.(id);
      if (!files.has(id)) return new Response(null, { status: 404 });
    }
    const body = new Uint8Array(await new Response(init.body).arrayBuffer());
    const text = new TextDecoder().decode(body);
    const boundary = /boundary=(\S+)/.exec((init.headers as Record<string, string>)['Content-Type'] ?? '')?.[1] ?? '';
    const parts = text.split(`--${boundary}`);
    const metadata = JSON.parse(parts[1]?.split('\r\n\r\n')[1]?.trim() ?? '{}') as { name?: string };
    const content = utf8((parts[2]?.split('\r\n\r\n').slice(1).join('\r\n\r\n') ?? '').replace(/\r\n$/, ''));
    const fileId = id ?? `f${String(next++)}`;
    const name = id ? (files.get(id)?.name ?? '') : (metadata.name ?? '');
    files.set(fileId, { name, content, modifiedTime: new Date(1_800_000_000_000 + next * 1000).toISOString() });
    return Response.json({ id: fileId, name });
  };
  const fetcher: typeof fetch = (input, init = {}) =>
    handle(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), init);
  return { files, calls, fetcher };
}

describe('cliente de Drive', () => {
  it('sin token no hay requests; con token, Bearer sin cookies ni referrer y sólo appDataFolder', async () => {
    const drive = fakeDrive();
    await expect(new DriveClient(() => null, drive.fetcher).list('a.json')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    expect(drive.calls).toHaveLength(0);
    const client = new DriveClient(() => 'token', drive.fetcher);
    await client.list('a.json');
    const [call] = drive.calls;
    expect(call?.url.searchParams.get('spaces')).toBe('appDataFolder');
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.referrerPolicy).toBe('no-referrer');
    expect((call?.init.headers as Record<string, string>).Authorization).toBe('Bearer token');
    await expect(client.list("a'.json")).rejects.toThrow('inválido');
  });

  it('subir verifica byte a byte; si Drive guardó otra cosa no se da por guardado', async () => {
    const good = new DriveClient(() => 't', fakeDrive().fetcher);
    const first = await good.uploadVerified('x.json', utf8('{"v":1}'));
    expect(first.replaced).toBe(false);
    expect((await good.uploadVerified('x.json', utf8('{"v":2}'))).replaced).toBe(true);
    const bad = new DriveClient(() => 't', fakeDrive({ corrupt: true }).fetcher);
    await expect(bad.uploadVerified('x.json', utf8('{"v":1}'))).rejects.toMatchObject({ code: 'MISMATCH' });
  });

  it('subir: si el archivo listado desaparece antes de reemplazarlo (404), lo crea de nuevo', async () => {
    // Otro dispositivo (o la configuración de Google) lo borra entre el listado y el reemplazo.
    const drive = fakeDrive({ beforePatch: (id) => drive.files.delete(id) });
    const client = new DriveClient(() => 't', drive.fetcher);
    await client.create('y.json', utf8('viejo'));
    const result = await client.uploadVerified('y.json', utf8('nuevo'));
    expect(result.replaced).toBe(false);
    const stored = [...drive.files.values()].filter((f) => f.name === 'y.json');
    expect(stored.map((f) => new TextDecoder().decode(f.content))).toEqual(['nuevo']);
  });

  it('subir: una copia vieja que ya no está al limpiarla (404) no convierte en error el backup verificado', async () => {
    // Otra subida (o dispositivo) borra la copia vieja entre el listado y la limpieza.
    const drive = fakeDrive({
      beforeDelete: (id) => {
        drive.files.delete(id);
        return undefined;
      },
    });
    const client = new DriveClient(() => 't', drive.fetcher);
    await client.create('z.json', utf8('copia vieja'));
    await client.create('z.json', utf8('la más reciente'));
    const result = await client.uploadVerified('z.json', utf8('nuevo'));
    expect(result.replaced).toBe(true);
    const stored = [...drive.files.values()].filter((f) => f.name === 'z.json');
    expect(stored.map((f) => new TextDecoder().decode(f.content))).toEqual(['nuevo']);
    // Cualquier otro error al borrar sigue siendo un error.
    const forbidden = fakeDrive({ beforeDelete: () => 403 });
    const other = new DriveClient(() => 't', forbidden.fetcher);
    await other.create('z.json', utf8('copia vieja'));
    await other.create('z.json', utf8('la más reciente'));
    await expect(other.uploadVerified('z.json', utf8('nuevo'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'UNEXPECTED'],
  ])('HTTP %i → %s', async (status, code) => {
    const client = new DriveClient(() => 't', fakeDrive({ status }).fetcher);
    await expect(client.list('x.json')).rejects.toMatchObject({ code, status });
  });

  it('sin red es un error propio', async () => {
    const client = new DriveClient(
      () => 't',
      () => Promise.reject(new TypeError('offline')),
    );
    await expect(client.download('id')).rejects.toBeInstanceOf(DriveError);
  });
});

describe('backup de R', () => {
  /** El nombre con el que se subía antes (uno por wallet): se sigue listando y restaurando. */
  const legacyName = (walletId: string) => `R.enc.${walletId}.json`;

  it('uno por clave: R.enc.<walletId>.<dirección en minúsculas, sin 0x>.json con la serialización exacta del sobre', async () => {
    const drive = fakeDrive();
    const client = new DriveClient(() => 't', drive.fetcher);
    const file = await uploadRecoveryEnvelope(client, envelope);
    expect(file.name).toBe(`R.enc.${envelope.walletId}.${envelope.keyAddress.slice(2).toLowerCase()}.json`);
    expect(file.name).toBe(backupName(envelope.walletId, envelope.keyAddress));
    expect(file.name).toMatch(/^R\.enc\.[0-9a-f-]{36}\.[0-9a-f]{40}\.json$/);
    expect(new TextDecoder().decode(drive.files.get(file.id)?.content)).toBe(serializeRecoveryEnvelope(envelope));
    expect(() => backupName('no-es-un-uuid', envelope.keyAddress)).toThrow('walletId inválido');
  });

  it('un reemplazo de R no pisa la copia de la R vigente (N13): quedan las dos', async () => {
    const drive = fakeDrive();
    const client = new DriveClient(() => 't', drive.fetcher);
    await uploadRecoveryEnvelope(client, envelope);
    await uploadRecoveryEnvelope(client, replacement);
    // Subir otra vez la misma R reemplaza su archivo (no lo duplica).
    await uploadRecoveryEnvelope(client, replacement);
    expect([...drive.files.values()].map((f) => f.name).sort()).toEqual(
      [
        backupName(envelope.walletId, envelope.keyAddress),
        backupName(envelope.walletId, replacement.keyAddress),
      ].sort(),
    );
    const { backups, unreadable } = await listRecoveryBackups(client);
    expect(unreadable).toBe(0);
    expect(backups.map((b) => b.keyAddress).sort()).toEqual([envelope.keyAddress, replacement.keyAddress].sort());
  });

  it('en un dispositivo nuevo lista los sobres (nombre nuevo y anterior, paginado) con su dirección validada contra el contenido', async () => {
    const drive = fakeDrive({ pageSize: 2 });
    const client = new DriveClient(() => 't', drive.fetcher);
    await client.create('U.enc.json', utf8('{}'));
    await client.create('otro.json', utf8('{}'));
    // Uno subido antes con el nombre por wallet y otro con el nombre por clave.
    await client.create(legacyName(envelope.walletId), utf8(serializeRecoveryEnvelope(envelope)));
    await uploadRecoveryEnvelope(client, replacement);
    // Uno cuyo nombre dice otra R que la de su contenido y otro que no es un sobre: no se ofrecen.
    await client.create(
      `R.enc.${envelope.walletId}.${'ab'.repeat(20)}.json`,
      utf8(serializeRecoveryEnvelope(replacement)),
    );
    await client.create(legacyName('00000000-0000-4000-8000-000000000000'), utf8('no es json'));
    await client.create('notas.txt', utf8('x'));
    const { backups, unreadable } = await listRecoveryBackups(client);
    expect(unreadable).toBe(2);
    expect(backups.map((b) => [b.walletId, b.keyAddress])).toEqual(
      expect.arrayContaining([
        [envelope.walletId, envelope.keyAddress],
        [envelope.walletId, replacement.keyAddress],
      ]),
    );
    expect(backups).toHaveLength(2);
    expect(backups.find((b) => b.file.name === legacyName(envelope.walletId))?.envelope).toEqual(envelope);
    expect(backups.find((b) => b.keyAddress === replacement.keyAddress)?.envelope).toEqual(replacement);
  });

  it('cada archivo se valida contra su nombre: otra wallet, otra R o algo que no es un sobre se rechazan', async () => {
    const drive = fakeDrive();
    const client = new DriveClient(() => 't', drive.fetcher);
    const otherWallet = '00000000-0000-4000-8000-000000000000';
    const content = utf8(serializeRecoveryEnvelope(envelope));
    const ofOtherWallet = await client.create(legacyName(otherWallet), content);
    await expect(readRecoveryBackup(client, ofOtherWallet)).rejects.toThrow('no es de la wallet');
    const ofOtherKey = await client.create(backupName(envelope.walletId, replacement.keyAddress), content);
    await expect(readRecoveryBackup(client, ofOtherKey)).rejects.toThrow('no es de la clave R');
    const notJson = await client.create(backupName(envelope.walletId, envelope.keyAddress), utf8('no es json'));
    await expect(readRecoveryBackup(client, notJson)).rejects.toThrow('no es un sobre válido');
    const notAnEnvelope = await client.create(legacyName(envelope.walletId), utf8('{"role":"U"}'));
    await expect(readRecoveryBackup(client, notAnEnvelope)).rejects.toThrow('no es un sobre válido');
    await expect(readRecoveryBackup(client, { id: 'x', name: 'U.enc.json' })).rejects.toThrow('no es un sobre de R');
    // Un error de Drive no se confunde con un sobre inválido: corta el listado.
    const offline = new DriveClient(() => 't', fakeDrive({ status: 503 }).fetcher);
    await expect(listRecoveryBackups(offline)).rejects.toMatchObject({ code: 'UNEXPECTED', status: 503 });
  });

  it('un sobre que se borró entre el listado y la descarga no está; un 5xx al bajarlo corta el listado', async () => {
    const drive = fakeDrive();
    const kept = await uploadRecoveryEnvelope(new DriveClient(() => 't', drive.fetcher), envelope);
    const gone = await uploadRecoveryEnvelope(new DriveClient(() => 't', drive.fetcher), replacement);
    /** Drive responde `status` al bajar el sobre de R′ (el resto, como siempre). */
    const failing =
      (status: number): typeof fetch =>
      (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith(`/files/${gone.id}`) && url.searchParams.get('alt') === 'media') {
          return Promise.resolve(new Response(null, { status }));
        }
        return drive.fetcher(input, init);
      };
    const listed = await listRecoveryBackups(new DriveClient(() => 't', failing(404)));
    expect(listed.unreadable).toBe(0);
    expect(listed.backups.map((b) => b.file.id)).toEqual([kept.id]);
    await expect(listRecoveryBackups(new DriveClient(() => 't', failing(503)))).rejects.toMatchObject({
      code: 'UNEXPECTED',
      status: 503,
    });
  });
});
