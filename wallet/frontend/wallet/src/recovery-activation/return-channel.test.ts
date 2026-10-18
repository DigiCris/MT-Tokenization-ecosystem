// [F-LNK-02]: el link de regreso abierto en otra pestaña le pasa la R a la pestaña que está activando Recovery (sólo
// para su enrollment) y sabe si alguna lo tomó.
import { describe, expect, it } from 'vitest';
import { listenForReturn, offerReturn } from './return-channel.ts';

const R = '0x7184D30100a188c9F869ccB6883392534ecD6C9d';

describe('canal del link de regreso', () => {
  it('la pestaña que espera ese enrollment lo toma y confirma', async () => {
    const received: string[] = [];
    const stop = listenForReturn('e1', (r) => received.push(r));
    try {
      await expect(offerReturn({ enrollmentId: 'e1', recoveryKey: R })).resolves.toBe(true);
      expect(received).toEqual([R]);
    } finally {
      stop();
    }
  });

  it('nadie espera ese enrollment: sigue la pestaña del link', async () => {
    const stop = listenForReturn('otro', () => undefined);
    try {
      await expect(offerReturn({ enrollmentId: 'e2', recoveryKey: R }, 200)).resolves.toBe(false);
    } finally {
      stop();
    }
  });
});
