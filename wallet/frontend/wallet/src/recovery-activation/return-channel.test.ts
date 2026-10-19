// [F-LNK-02], ADR-033: el enlace de regreso abierto en otra pestaña le pasa la R y el k del enlace a la pestaña que está
// activando Recovery (sólo para su enrollment; decide esa pestaña, la única que conoce el k del pedido) y sabe si alguna
// lo tomó.
import { describe, expect, it } from 'vitest';
import { listenForReturn, offerReturn } from './return-channel.ts';

const R = '0x7184D30100a188c9F869ccB6883392534ecD6C9d';
const K = 'q1Zs-0bM4_Lr8xWp2cYtNg';

describe('canal del enlace de regreso', () => {
  it('la pestaña que espera ese enrollment lo toma con el k del enlace (o sin k si no lo trae)', async () => {
    const received: [string, string | null][] = [];
    const stop = listenForReturn('e1', (r, secret) => received.push([r, secret]));
    try {
      await expect(offerReturn({ enrollmentId: 'e1', recoveryKey: R, secret: K })).resolves.toBe(true);
      await expect(offerReturn({ enrollmentId: 'e1', recoveryKey: R, secret: null })).resolves.toBe(true);
      expect(received).toEqual([
        [R, K],
        [R, null],
      ]);
    } finally {
      stop();
    }
  });

  it('nadie espera ese enrollment: sigue la pestaña del enlace', async () => {
    const stop = listenForReturn('otro', () => undefined);
    try {
      await expect(offerReturn({ enrollmentId: 'e2', recoveryKey: R, secret: K }, 200)).resolves.toBe(false);
    } finally {
      stop();
    }
  });
});
