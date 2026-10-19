// [F-LNK-02], ADR-033: el enlace de regreso abierto en otra pestaña le pasa la R y el k del enlace a la pestaña que está
// activando Recovery (sólo para su enrollment; decide esa pestaña, la única que conoce el k del pedido). Revisión de
// seguridad de ADR-033: la pestaña del pedido responde «comprobando» y después el resultado real (confirmado, cancelado o
// sin red), así la del enlace no dice «Listo» para un enlace falsificado; los mensajes mal formados se ignoran.
import { describe, expect, it } from 'vitest';
import {
  listenForReturn,
  offerReturn,
  RETURN_CHANNEL,
  type ReturnResult,
  type ReturnStatus,
} from './return-channel.ts';

const R = '0x7184D30100a188c9F869ccB6883392534ecD6C9d';
const K = 'q1Zs-0bM4_Lr8xWp2cYtNg';

describe('canal del enlace de regreso', () => {
  it('la pestaña del pedido lo toma con el k del enlace (o sin k) y responde el resultado real', async () => {
    const received: [string, string | null][] = [];
    const results: ReturnResult[] = ['confirmed', 'aborted'];
    const stop = listenForReturn('e1', (r, secret) => {
      received.push([r, secret]);
      return Promise.resolve(results.shift() ?? 'retry');
    });
    try {
      const statuses: ReturnStatus[] = [];
      await expect(
        offerReturn({ enrollmentId: 'e1', recoveryKey: R, secret: K }, { onStatus: (s) => statuses.push(s) }),
      ).resolves.toBe('confirmed');
      expect(statuses).toEqual(['checking', 'confirmed']);
      await expect(offerReturn({ enrollmentId: 'e1', recoveryKey: R, secret: null })).resolves.toBe('aborted');
      expect(received).toEqual([
        [R, K],
        [R, null],
      ]);
    } finally {
      stop();
    }
  });

  it('nadie espera ese enrollment: sigue la pestaña del enlace', async () => {
    const stop = listenForReturn('otro', () => 'confirmed');
    try {
      await expect(offerReturn({ enrollmentId: 'e2', recoveryKey: R, secret: K }, { ackTimeoutMs: 200 })).resolves.toBe(
        'none',
      );
    } finally {
      stop();
    }
  });

  it('si el resultado tarda, la pestaña del enlace queda en «comprobando»; sin red, «reintentar»', async () => {
    let release: (result: ReturnResult) => void = () => undefined;
    const stop = listenForReturn(
      'e3',
      () =>
        new Promise<ReturnResult>((resolve) => {
          release = resolve;
        }),
    );
    try {
      await expect(
        offerReturn({ enrollmentId: 'e3', recoveryKey: R, secret: K }, { resultTimeoutMs: 200 }),
      ).resolves.toBe('checking');
      release('retry');
      const stopRetry = listenForReturn('e4', () => 'retry');
      try {
        await expect(offerReturn({ enrollmentId: 'e4', recoveryKey: R, secret: K })).resolves.toBe('retry');
      } finally {
        stopRetry();
      }
    } finally {
      stop();
    }
  });

  it('mensajes mal formados o de otro tipo: no se toman ni se responden', async () => {
    const received: unknown[] = [];
    const stop = listenForReturn('e5', (r, secret) => {
      received.push([r, secret]);
      return 'confirmed';
    });
    const sender = new BroadcastChannel(RETURN_CHANNEL);
    const answers: unknown[] = [];
    sender.addEventListener('message', (event: MessageEvent<unknown>) => answers.push(event.data));
    try {
      for (const message of [
        null,
        'recovery-return',
        { type: 'recovery-return', enrollmentId: 'e5' },
        { type: 'recovery-return', enrollmentId: 'e5', recoveryKey: 42, secret: K },
        { type: 'recovery-return', enrollmentId: 'e5', recoveryKey: R, secret: 7 },
        { type: 'recovery-return', enrollmentId: 'otro', recoveryKey: R, secret: K },
        { type: 'recovery-ack', enrollmentId: 'e5', status: 'confirmed' },
        { type: 'otro', enrollmentId: 'e5', recoveryKey: R, secret: K },
      ]) {
        sender.postMessage(message);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toEqual([]);
      expect(answers).toEqual([]);
      // Un ack falso de otra pestaña no confunde a la del enlace: tiene que traer un estado conocido.
      const offered = offerReturn({ enrollmentId: 'e6', recoveryKey: R, secret: K }, { ackTimeoutMs: 300 });
      sender.postMessage({ type: 'recovery-ack', enrollmentId: 'e6', status: 'Listo, copiá la dirección' });
      await expect(offered).resolves.toBe('none');
    } finally {
      sender.close();
      stop();
    }
  });
});
