// RecoveryGate con una R que no es firmante de la Safe (verificación de P17.MAN, N15) contra `vite preview`, con la API y
// Base simuladas (test/browser/helpers/mock-api.ts y mock-chain.ts): este dispositivo recuerda el sobre de la R vigente
// y el de una R de un pedido anterior. Con la del pedido anterior, la verificación propia de la Safe falla sólo por la
// recoveryKey y la pantalla lo dice con la dirección de esa R: «Usar otro sobre» vuelve a elegir sin borrar nada y
// «Olvidar este sobre» borra sólo el de esa R. Si la Safe que informa la plataforma no tiene código (N2), no se dice que
// R no es firmante ni se ofrece olvidar el sobre. Con varios sobres de la misma wallet, el aviso dice cómo elegir (N8).
import { argon2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { safeFailureText } from '../../src/chain/safe-check.ts';
import { sealRecoveryKey, type RecoveryEnvelope } from '../../src/crypto/envelope.ts';
import type { Argon2 } from '../../src/crypto/kdf.ts';
import { newPasswordR } from '../../src/crypto/password.ts';
import { addressOfKey, newPrivateKey } from '../../src/crypto/secp256k1.ts';
import { parseWordlist } from '../../src/crypto/words.ts';
import { notASignerText, SEVERAL_ENVELOPES_TEXT } from '../../src/session/texts.ts';
import { accountRoutes, buildConfig, mockApi, WALLET_ID, type MockRoute } from './helpers/mock-api.ts';
import { mockChain } from './helpers/mock-chain.ts';

/** Argon2id nativo de Node (mismos parámetros que el worker): el navegador abre estos sobres con la Password R. */
const nodeArgon2: Argon2 = (input) =>
  Promise.resolve(
    new Uint8Array(
      argon2Sync('argon2id', {
        message: Buffer.from(input.password),
        nonce: Buffer.from(input.salt),
        parallelism: input.parallelism,
        tagLength: input.outputLength,
        memory: input.memoryKiB,
        passes: input.iterations,
      }),
    ),
  );

const wordlist = parseWordlist(
  readFileSync(resolve(import.meta.dirname, '../../src/vendor/mtw-wordlist-v1.txt'), 'utf8'),
);
const address = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const SAFE = address(0x5afe);
const USER_KEY = address(0xa1);
const EXECUTOR = address(0xa3);

interface SealedR {
  envelope: RecoveryEnvelope;
  password: string;
}

/** Una R de esta wallet con su Password R de 5 palabras. */
async function sealedR(): Promise<SealedR> {
  const key = newPrivateKey();
  const password = newPasswordR(wordlist).join(' ');
  const opened = await sealRecoveryKey(
    key,
    password,
    { platformId: buildConfig.platformId, walletId: WALLET_ID, keyVersion: 1 },
    nodeArgon2,
  );
  if (opened.address !== addressOfKey(key)) throw new Error('el sobre no es de esa clave');
  return { envelope: opened.envelope, password };
}

/** Step-up RECOVERY: la sesión de la wallet con la Safe que diga `safe` (la que verifica RecoveryGate). */
function recoveryStepUpRoutes(safe: Address): MockRoute[] {
  return [
    {
      method: 'POST',
      path: /^\/platform-sessions\/step-up\/start$/,
      handle: () => ({
        status: 202,
        body: { challengeId: crypto.randomUUID(), expiresAt: '2030-01-01T15:10:00.000Z' },
      }),
    },
    {
      method: 'POST',
      path: /^\/platform-sessions\/step-up\/finish$/,
      handle: () => {
        const now = Date.now();
        return {
          body: {
            token: 'platform-session-recovery',
            csrfToken: 'csrf-de-prueba-2',
            session: {
              id: crypto.randomUUID(),
              scope: 'RECOVERY',
              authMethod: 'STEP_UP',
              walletId: WALLET_ID,
              safe,
              issuedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + 15 * 60_000).toISOString(),
            },
          },
        };
      },
    },
  ];
}

/** Los sobres recordados por Recovery en este dispositivo (IndexedDB `mtw-recovery`, `envelopes`): sus claves. */
async function rememberedKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolveKeys, reject) => {
        const request = indexedDB.open('mtw-recovery', 2);
        request.onsuccess = () => {
          const db = request.result;
          const keys = db.transaction('envelopes', 'readonly').objectStore('envelopes').getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolveKeys(keys.result.map(String).sort());
          };
          keys.onerror = () => {
            reject(keys.error ?? new Error('indexedDB'));
          };
        };
        request.onerror = () => {
          reject(request.error ?? new Error('indexedDB'));
        };
      }),
  );
}

/** Deja recordados en este dispositivo los sobres dados (como envelope-cache.ts: uno por clave de cada wallet). */
async function remember(page: Page, envelopes: RecoveryEnvelope[]): Promise<void> {
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
}

/** Elige el sobre recordado de esa R, lo abre con su Password R y, si hace falta, verifica la identidad. */
async function unlockR(page: Page, r: SealedR): Promise<void> {
  await page.locator(`[data-remembered-envelope="${r.envelope.keyAddress}"]`).click();
  await page.getByLabel('Password R').fill(r.password);
  await page.getByRole('button', { name: 'Desbloquear R' }).click();
  const stepUp = page.getByRole('button', { name: 'Mandarme el código' });
  const checking = page.getByText('Verificando tu Safe en Base…');
  const result = page.getByText('La verificación propia de tu Safe falló: no se opera con ella.');
  await expect(stepUp.or(checking).or(result)).toBeVisible({ timeout: 60_000 });
  if (await stepUp.isVisible()) {
    await stepUp.click();
    await page.getByLabel('Código del email').fill('12345678');
    await page.getByRole('button', { name: 'Confirmar' }).click();
  }
}

const grouped = (value: Address) => `0x ${(getAddress(value).slice(2).match(/.{4}/g) ?? []).join(' ')}`;

let current: SealedR;
let previous: SealedR;

test.beforeAll(async () => {
  [current, previous] = await Promise.all([sealedR(), sealedR()]);
});

test('una R que no es firmante: «Usar otro sobre» no borra nada y «Olvidar este sobre» borra sólo el suyo', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL ?? '').origin;
  await mockApi(context, origin, [...accountRoutes(), ...recoveryStepUpRoutes(SAFE)]);
  await mockChain(context, origin, {
    safe: SAFE,
    roles: { userKey: USER_KEY, recoveryKey: current.envelope.keyAddress, executor: EXECUTOR },
  });
  await page.goto('/');
  await remember(page, [current.envelope, previous.envelope]);
  const both = [current, previous].map((r) => `${WALLET_ID}:${r.envelope.keyAddress.toLowerCase()}`).sort();

  await page.goto('/rotations');
  await expect(page.getByRole('heading', { name: 'Desbloqueá tu clave de recuperación (R)' })).toBeVisible();
  // Dos sobres de la misma wallet: cómo saber cuál es el vigente, también sin ver la Wallet desbloqueada (N8).
  await expect(page.getByText(SEVERAL_ENVELOPES_TEXT)).toBeVisible();

  // El de un pedido anterior: la Safe es la esperada, salvo que esa R no es su clave de recuperación.
  await unlockR(page, previous);
  const card = page.locator(`[data-not-a-signer="${previous.envelope.keyAddress}"]`);
  await expect(card.getByRole('heading', { name: 'Esta clave R no es firmante de tu Safe' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('[data-item]')).toHaveCount(1);
  await expect(page.locator('[data-item="RECOVERY_KEY"]')).toHaveText(safeFailureText('RECOVERY_KEY'));
  await expect(card).toContainText(
    `Dirección de la clave R que desbloqueaste: ${grouped(previous.envelope.keyAddress)}`,
  );
  await expect(card.getByText(notASignerText(true))).toBeVisible();

  // «Usar otro sobre»: vuelve a elegir, con los dos sobres todavía recordados.
  await card.getByRole('button', { name: 'Usar otro sobre' }).click();
  await expect(page.getByRole('heading', { name: 'Desbloqueá tu clave de recuperación (R)' })).toBeVisible();
  for (const r of [current, previous]) {
    await expect(page.locator(`[data-remembered-envelope="${r.envelope.keyAddress}"]`)).toBeVisible();
  }
  expect(await rememberedKeys(page)).toEqual(both);

  // Otra vez el del pedido anterior (con la misma verificación): «Olvidar este sobre» borra sólo ése.
  await unlockR(page, previous);
  await expect(card.getByRole('button', { name: 'Olvidar este sobre' })).toBeVisible({ timeout: 60_000 });
  await card.getByRole('button', { name: 'Olvidar este sobre' }).click();
  await expect(page.getByRole('heading', { name: 'Desbloqueá tu clave de recuperación (R)' })).toBeVisible();
  await expect(page.locator(`[data-remembered-envelope="${previous.envelope.keyAddress}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-remembered-envelope="${current.envelope.keyAddress}"]`)).toBeVisible();
  await expect(page.getByText(SEVERAL_ENVELOPES_TEXT)).toHaveCount(0);
  await expect.poll(() => rememberedKeys(page)).toEqual([`${WALLET_ID}:${current.envelope.keyAddress.toLowerCase()}`]);
});

test('una Safe sin código no hace decir «no es firmante» ni ofrece olvidar el sobre (N2)', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL ?? '').origin;
  // La plataforma informa otra dirección (sin código): la verificación falla entera, no por R.
  const elsewhere = address(0xbad5afe);
  await mockApi(context, origin, [...accountRoutes(), ...recoveryStepUpRoutes(elsewhere)]);
  await mockChain(context, origin, {
    safe: SAFE,
    roles: { userKey: USER_KEY, recoveryKey: current.envelope.keyAddress, executor: EXECUTOR },
  });
  await page.goto('/');
  await remember(page, [current.envelope, previous.envelope]);
  await page.goto('/rotations');
  await unlockR(page, previous);
  await expect(page.getByText('La verificación propia de tu Safe falló: no se opera con ella.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('[data-item="SAFE_PROXY_CODEHASH"]')).toHaveText(safeFailureText('SAFE_PROXY_CODEHASH'));
  await expect(page.locator('[data-item="RECOVERY_KEY"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Esta clave R no es firmante de tu Safe' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Olvidar este sobre' })).toHaveCount(0);
  expect(await rememberedKeys(page)).toEqual(
    [current, previous].map((r) => `${WALLET_ID}:${r.envelope.keyAddress.toLowerCase()}`).sort(),
  );
});
