// P16.T04 [F-SEC-04]: al arrancar se desregistra todo service worker del origin y se reporta cada uno.
import { describe, expect, it } from 'vitest';
import { removeServiceWorkers } from './sw-killswitch.ts';

describe('kill-switch de service workers', () => {
  it('desregistra y reporta cada registro', async () => {
    const unregistered: string[] = [];
    const registration = (scope: string) =>
      ({
        scope,
        unregister: () => {
          unregistered.push(scope);
          return Promise.resolve(true);
        },
      }) as unknown as ServiceWorkerRegistration;
    const reported: string[] = [];
    const removed = await removeServiceWorkers(
      {
        getRegistrations: () =>
          Promise.resolve([registration('https://w.example/'), registration('https://w.example/app/')]),
      },
      (scope) => reported.push(scope),
    );
    expect(removed).toBe(2);
    expect(unregistered).toEqual(['https://w.example/', 'https://w.example/app/']);
    expect(reported).toEqual(unregistered);
  });

  it('sin registros o sin API de service workers no hace nada', async () => {
    const reported: string[] = [];
    expect(await removeServiceWorkers({ getRegistrations: () => Promise.resolve([]) }, (s) => reported.push(s))).toBe(
      0,
    );
    expect(await removeServiceWorkers(undefined, (s) => reported.push(s))).toBe(0);
    expect(reported).toEqual([]);
  });
});
