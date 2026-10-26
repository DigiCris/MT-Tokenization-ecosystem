// P17.SEC [F-KEY-07]: test de canario. Tras recorrer los flujos con la clave en el navegador (onboarding con Drive real,
// desbloqueo y cambio de Password U), se buscan U (hex y base64/base64url), la Password U (vieja y nueva), AuthSecret_U
// y las 17 palabras en todos los requests (URL, headers y cuerpo, también los que van a Google) y en localStorage,
// sessionStorage, IndexedDB y cookies. Además, ni el token de PlatformSession ni el de Drive quedan en ningún storage.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { backupWordsToKey } from '../../../frontend/wallet/src/crypto/backup-words.ts';
import { fromBase64Url, toHex } from '../../../frontend/wallet/src/crypto/bytes.ts';
import { parseEnvelope } from '../../../frontend/wallet/src/crypto/envelope.ts';
import { deriveKeys } from '../../../frontend/wallet/src/crypto/kdf.ts';
import { answerGoogleConsent, driveTestToken, removeEnvelopeBackup } from '../../fixtures/wallet/drive.ts';
import { activeWallet, nodeArgon2, testWordlist, verifiedAccount } from '../../fixtures/wallet/onboard.ts';
import { serializeEnvelope } from '../../../frontend/wallet/src/crypto/envelope.ts';
import {
  backupToFile,
  completeStepUp,
  login,
  unlockWithFile,
  writeDownAndConfirmBackupWords,
  writeDownAndConfirmPassword,
} from '../../fixtures/wallet/ui.ts';

interface Captured {
  url: string;
  headers: string;
  body: string;
}

function capture(page: Page): { requests: Captured[]; tokens: string[] } {
  const requests: Captured[] = [];
  const tokens: string[] = [];
  page.on('request', (request) => {
    const buffer = request.postDataBuffer();
    requests.push({
      url: request.url(),
      headers: JSON.stringify(request.headers()),
      body: buffer ? buffer.toString('latin1') : '',
    });
  });
  page.on('response', async (response) => {
    if (!/\/platform-sessions\/(opaque\/finish|step-up\/finish)$/.test(response.url())) return;
    try {
      const body = (await response.json()) as { token?: string };
      if (body.token) tokens.push(body.token);
    } catch {
      // sin cuerpo JSON
    }
  });
  return { requests, tokens };
}

async function storages(page: Page, context: BrowserContext): Promise<string> {
  const web = await page.evaluate(async () => {
    const dump: string[] = [];
    for (const area of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i) ?? '';
        dump.push(`${key}=${area.getItem(key) ?? ''}`);
      }
    }
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolveDb, reject) => {
        const request = indexedDB.open(info.name ?? '');
        request.onsuccess = () => {
          resolveDb(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('indexedDB'));
        };
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>((resolveValues, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => {
            resolveValues(request.result as unknown[]);
          };
          request.onerror = () => {
            reject(request.error ?? new Error('indexedDB'));
          };
        });
        dump.push(`${info.name}/${store}=${JSON.stringify(values)}`);
      }
      db.close();
    }
    return dump.join('\n');
  });
  const cookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('\n');
  return `${web}\n${cookies}`;
}

function variants(key: Uint8Array): string[] {
  const hex = toHex(key).slice(2);
  const b64 = Buffer.from(key).toString('base64');
  const b64url = Buffer.from(key).toString('base64url');
  return [hex, hex.toUpperCase(), b64, b64url];
}

async function authSecretHex(envelopeJson: string, words: readonly string[]): Promise<string> {
  const envelope = parseEnvelope(JSON.parse(envelopeJson));
  const keys = await deriveKeys(words.join(' '), 'U', envelope.kdf, fromBase64Url(envelope.kdf.salt), nodeArgon2);
  return toHex(keys.authSecret ?? new Uint8Array()).slice(2);
}

function assertAbsent(haystack: string, canaries: Record<string, string[]>, where: string): void {
  for (const [name, values] of Object.entries(canaries)) {
    for (const value of values) {
      if (value.length < 8) continue;
      expect(haystack.includes(value), `${name} aparece en ${where}`).toBe(false);
    }
  }
}

test('onboarding con Drive: U, Password U, AuthSecret_U y las 17 palabras no salen del navegador ni quedan guardadas', async ({
  page,
  context,
}) => {
  const account = await verifiedAccount('canario');
  const seen = capture(page);
  await login(page, account.email, account.password);
  const consent = await answerGoogleConsent(page);
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await completeStepUp(page, account.email);
  const words = await writeDownAndConfirmPassword(page);
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click();
  await page.getByRole('button', { name: 'Subir a Drive y verificar' }).click();
  await expect(page.getByText('Sobre subido a Drive y verificado.')).toBeVisible();
  const file = await backupToFile(page);
  // Al confirmar 3 de ellas (tipeadas en la página), las palabras dejan de mostrarse y tampoco salen del navegador.
  const backupWords = await writeDownAndConfirmBackupWords(page);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  // Registrada la clave, el onboarding sigue con la activación de Recovery (P18).
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  try {
    const key = await backupWordsToKey('U', backupWords, testWordlist());
    const canaries = {
      U: variants(key),
      'Password U': [words.join(' '), words.join('')],
      AuthSecret_U: [await authSecretHex(file, words)],
      '17 palabras': [backupWords.join(' ')],
    };
    expect(seen.requests.length).toBeGreaterThan(10);
    expect(seen.requests.some((r) => r.url.startsWith('https://www.googleapis.com/upload/drive/v3/files'))).toBe(true);
    for (const request of seen.requests)
      assertAbsent(`${request.url}\n${request.headers}\n${request.body}`, canaries, request.url);
    const stored = await storages(page, context);
    assertAbsent(stored, canaries, 'los storages del navegador');
    assertAbsent(stored, { 'token de Drive': [await driveTestToken()], PlatformSession: seen.tokens }, 'los storages');
    // Al salir, la app revoca el token de Drive en Google ([F-DRV-01]); answerGoogleConsent intercepta ese pedido.
    expect(consent.revoked).toEqual([]);
    await page.getByRole('button', { name: 'Salir' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => consent.revoked).toEqual([await driveTestToken()]);
  } finally {
    await removeEnvelopeBackup(serializeEnvelope(parseEnvelope(JSON.parse(file))));
  }
});

test('desbloqueo y cambio de Password U: ni U ni las Password U (vieja y nueva) aparecen en requests o storages', async ({
  page,
  context,
}) => {
  test.setTimeout(600_000);
  const wallet = await activeWallet('canario-u');
  const seen = capture(page);
  await login(page, wallet.email, wallet.password);
  await unlockWithFile(page, serializeEnvelope(wallet.envelope), wallet.passwordWords, true);
  await expect(page.getByRole('status').filter({ hasText: 'Wallet desbloqueada' })).toBeVisible();
  await page.getByRole('link', { name: 'Seguridad' }).click();
  await page.getByRole('link', { name: 'Cambiar la Password U' }).click();
  await page.getByRole('button', { name: 'Generar la Password U nueva' }).click();
  const newWords = await writeDownAndConfirmPassword(page);
  const file = await backupToFile(page);
  await page.getByRole('button', { name: 'Cambiar la Password U' }).click();
  await expect(page.getByText('la Password U nueva quedó registrada')).toBeVisible();

  const canaries = {
    U: variants(wallet.userKey),
    'Password U vieja': [wallet.passwordWords.join(' '), wallet.passwordWords.join('')],
    'Password U nueva': [newWords.join(' '), newWords.join('')],
    'AuthSecret_U viejo': [await authSecretHex(serializeEnvelope(wallet.envelope), wallet.passwordWords)],
    'AuthSecret_U nuevo': [await authSecretHex(file, newWords)],
  };
  expect(seen.tokens.length).toBeGreaterThan(0);
  for (const request of seen.requests)
    assertAbsent(`${request.url}\n${request.headers}\n${request.body}`, canaries, request.url);
  const stored = await storages(page, context);
  assertAbsent(stored, canaries, 'los storages del navegador');
  assertAbsent(stored, { PlatformSession: seen.tokens }, 'los storages');
  // El sobre recordado en IndexedDB es el nuevo y está cifrado.
  expect(stored).toContain(parseEnvelope(JSON.parse(file)).ciphertext);
});
