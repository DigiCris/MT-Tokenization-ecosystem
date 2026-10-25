// P19.T03/T08 [F-DRV-02]: el cliente REST de Drive de Recovery (sólo appDataFolder, multipart, Bearer sin cookies ni
// referrer), errores, verificación post-subida byte a byte, listado paginado y el backup `R.enc.<walletId>.json`
// (uno por wallet; al restaurar se valida que el sobre sea de la wallet de su nombre). Contra la API real lo prueba
// test/live/drive.live.test.ts con la cuenta de prueba.
import { describe, expect, it } from 'vitest';
import envelopeVectors from '../../test/vectors/wire/envelope.json' with { type: 'json' };
import { utf8 } from '../crypto/encoding.ts';
import { parseRecoveryEnvelope, serializeRecoveryEnvelope } from '../crypto/envelope.ts';
import { backupName, downloadRecoveryEnvelope, listRecoveryBackups, uploadRecoveryEnvelope } from './backup.ts';
import { DriveClient, DriveError } from './client.ts';

const vector = envelopeVectors.envelopes.find((e) => e.envelope.role === 'R');
if (!vector) throw new Error('el vector de sobres no tiene el de R');
const envelope = parseRecoveryEnvelope(vector.envelope);

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
  it('uno por wallet: R.enc.<walletId>.json con la serialización exacta del sobre', async () => {
    const drive = fakeDrive();
    const client = new DriveClient(() => 't', drive.fetcher);
    const file = await uploadRecoveryEnvelope(client, envelope);
    expect(file.name).toBe(backupName(envelope.walletId));
    expect(new TextDecoder().decode(drive.files.get(file.id)?.content)).toBe(serializeRecoveryEnvelope(envelope));
    expect(() => backupName('no-es-un-uuid')).toThrow('walletId inválido');
  });

  it('en un dispositivo nuevo lista los sobres (paginado, sin otros archivos) y valida el elegido', async () => {
    const drive = fakeDrive({ pageSize: 2 });
    const client = new DriveClient(() => 't', drive.fetcher);
    await client.create('U.enc.json', utf8('{}'));
    await client.create('otro.json', utf8('{}'));
    await uploadRecoveryEnvelope(client, envelope);
    await client.create('notas.txt', utf8('x'));
    const backups = await listRecoveryBackups(client);
    expect(backups.map((b) => b.walletId)).toEqual([envelope.walletId]);
    const [backup] = backups;
    if (!backup) throw new Error('sin backup');
    expect(await downloadRecoveryEnvelope(client, backup)).toEqual(envelope);
    // Un sobre de otra wallet guardado con el nombre de esta no se acepta.
    const other = { ...backup, walletId: '00000000-0000-4000-8000-000000000000' };
    await expect(downloadRecoveryEnvelope(client, other)).rejects.toThrow('no es de la wallet');
  });

  it('un archivo con ese nombre que no es un sobre se rechaza', async () => {
    const drive = fakeDrive();
    const client = new DriveClient(() => 't', drive.fetcher);
    const file = await client.create(backupName(envelope.walletId), utf8('no es json'));
    await expect(downloadRecoveryEnvelope(client, { file, walletId: envelope.walletId })).rejects.toThrow(
      'no es un sobre válido',
    );
  });
});
