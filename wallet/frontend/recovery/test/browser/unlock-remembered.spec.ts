// Desbloqueo de R antes de operar (RecoveryGate) contra `vite preview`, con la API simulada: cuarta revisión de P17.MAN
// (hallazgos 6 y 12). Cada sobre recordado en el dispositivo se ofrece con la dirección completa de su R en grupos (no
// sólo sus primeros caracteres), con un aviso si hay más de uno de la misma wallet (p. ej. el de un pedido anterior), y
// quien sólo tiene las 17 palabras ve el camino: restaurar R en «Restaurar mi clave R» (también en este dispositivo) y
// volver.
import { expect, test } from '@playwright/test';
import { getAddress } from 'viem';
import { toBufferSource } from '../../src/crypto/encoding.ts';
import { sealRecoveryKey } from '../../src/crypto/envelope.ts';
import type { Argon2 } from '../../src/crypto/kdf.ts';
import { newPrivateKey } from '../../src/crypto/secp256k1.ts';
import { accountRoutes, buildConfig, mockApi, WALLET_ID } from './helpers/mock-api.ts';

/** Argon2id de prueba (rápido): sólo para armar sobres válidos que esta pantalla lista sin abrir. */
const fastArgon2: Argon2 = async ({ password, salt }) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', toBufferSource(new Uint8Array([...password, ...salt]))));

const grouped = (address: string) => `0x ${(getAddress(address).slice(2).match(/.{4}/g) ?? []).join(' ')}`;

test('sobres recordados con la dirección completa, aviso si hay más de uno de la wallet y el camino de las 17 palabras', async ({
  page,
  context,
  baseURL,
}) => {
  await mockApi(context, new URL(baseURL ?? '').origin, accountRoutes());
  const sealed = await Promise.all(
    [0, 1].map(() =>
      sealRecoveryKey(
        newPrivateKey(),
        'una password de prueba',
        { platformId: buildConfig.platformId, walletId: WALLET_ID, keyVersion: 1 },
        fastArgon2,
      ),
    ),
  );
  const envelopes = sealed.map((s) => s.envelope);
  await page.goto('/');
  await page.evaluate(async (stored) => {
    await new Promise<void>((resolveDone, reject) => {
      const request = indexedDB.open('mtw-recovery', 2);
      request.onupgradeneeded = () => {
        for (const name of ['envelopes', 'safes']) request.result.createObjectStore(name);
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('envelopes', 'readwrite');
        for (const envelope of stored) {
          tx.objectStore('envelopes').put(
            JSON.stringify(envelope),
            `${envelope.walletId}:${envelope.keyAddress.toLowerCase()}`,
          );
        }
        tx.oncomplete = () => {
          db.close();
          resolveDone();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error('indexedDB'));
        };
      };
      request.onerror = () => {
        reject(request.error ?? new Error('indexedDB'));
      };
    });
  }, envelopes);

  await page.goto('/rotations');
  await expect(page.getByRole('heading', { name: 'Desbloqueá tu clave de recuperación (R)' })).toBeVisible();
  for (const envelope of envelopes) {
    const button = page.locator(`[data-remembered-envelope="${envelope.keyAddress}"]`);
    await expect(button).toHaveText(
      `Usar el sobre recordado de la clave R con la dirección ${grouped(envelope.keyAddress)}`,
    );
  }
  await expect(page.getByText(/^Este dispositivo recuerda más de un sobre de R de la misma wallet/)).toBeVisible();
  // Con sólo las 17 palabras: restaurar R primero (en este mismo dispositivo) y volver.
  const hint = page.locator('[data-words-hint]');
  await expect(hint).toHaveText(
    '¿Tenés sólo las 17 palabras de R? Primero restaurala en «Restaurar mi clave R» (sirve también en este dispositivo) y volvé.',
  );
  await expect(hint.getByRole('link', { name: '«Restaurar mi clave R»' })).toHaveAttribute('href', '/restore');
});
