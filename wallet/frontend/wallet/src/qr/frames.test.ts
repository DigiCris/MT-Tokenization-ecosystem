// [W-05]: QR multi-frame `MTWQR1:<i>/<n>:<sha256>:<chunk>` — ida y vuelta, frames en cualquier orden y repetidos, chunks
// de hasta 600 caracteres; contenido alterado, frames de otro contenido o QR ajenos se rechazan.
import { describe, expect, it } from 'vitest';
import { decodeFrames, encodeFrames, FrameCollector, MAX_CHUNK } from './frames.ts';

describe('QR multi-frame', () => {
  it('un sobre entra en un frame; un contenido grande se parte en chunks de hasta 600 y se reconstruye en cualquier orden', async () => {
    const small = JSON.stringify({ format: 'mtw-key-envelope', ciphertext: 'A'.repeat(64) });
    const [only, ...rest] = await encodeFrames(small);
    expect(rest).toHaveLength(0);
    expect(only).toMatch(/^MTWQR1:1\/1:[0-9a-f]{64}:[A-Za-z0-9_-]+$/);
    expect(await decodeFrames([only ?? ''])).toBe(small);

    const big = 'ñ'.repeat(1500);
    const frames = await encodeFrames(big);
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) expect(frame.split(':')[3]?.length).toBeLessThanOrEqual(MAX_CHUNK);
    const collector = new FrameCollector();
    for (const frame of [...frames].reverse()) collector.add(frame);
    collector.add(frames[0] ?? '');
    expect(collector.progress()).toEqual({ received: frames.length, total: frames.length });
    expect(await collector.content()).toBe(big);
  });

  it('faltan frames, otro contenido, chunk alterado o QR ajeno: no se acepta', async () => {
    const frames = await encodeFrames('x'.repeat(2000));
    const collector = new FrameCollector();
    collector.add(frames[0] ?? '');
    expect(await collector.content()).toBeNull();
    const other = await encodeFrames('otro contenido');
    expect(() => collector.add(other[0] ?? '')).toThrow('otro contenido');
    expect(() => collector.add('https://example.com')).toThrow('no es un QR de MT Wallet');
    expect(() => collector.add('MTWQR1:3/2:' + 'a'.repeat(64) + ':AAAA')).toThrow('inválido');
    await expect(decodeFrames(frames.slice(1))).rejects.toThrow('Faltan frames');
    // El primer chunk tiene 600 caracteres (grupos completos de base64url): cambiar el último cambia el contenido.
    const tampered = frames.map((f, i) => (i === 0 ? f.slice(0, -1) + (f.endsWith('A') ? 'B' : 'A') : f));
    await expect(decodeFrames(tampered)).rejects.toThrow('no reconstruyen');
  });
});
