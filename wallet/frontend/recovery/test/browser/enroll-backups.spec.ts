// Enrollment de R desde el enlace de la Wallet (segunda revisión de P17.MAN: NB1, N1, N2 del lado de Recovery y N11;
// tercera revisión: el sobre de R en este dispositivo, el vencimiento del pedido y los títulos de lo impreso) contra
// `vite preview`, con la API simulada (test/browser/helpers/mock-api.ts): la pantalla dice a qué hora vence el pedido
// (arriba y junto a «Firmar y enviar») y el step-up no promete 15 minutos; la Password R avisa que las palabras están
// en inglés y se pueden volver a ver si la confirmación falla, y el paso de cifrado ofrece recordar el sobre en este
// dispositivo (marcado por defecto); los backups dicen la verdad sobre qué permite R sin la plataforma (hace falta
// también U) y piden guardarlos lejos de los de U, el archivo y el QR piden guardarse sin la Password R al lado, el QR
// son cuadros quietos que juntos reconstruyen el sobre y se imprimen solos con su título, y las 17 palabras se imprimen
// solas con el suyo y cuentan como backup recién al reingresar 3 al azar (mientras están a la vista sin confirmar no se
// puede seguir). Al final, el enlace y el QR de regreso llevan el pedido, la dirección de R y el mismo secreto k del
// enlace de ida, que no viaja en ningún pedido a la API; y en los storages queda sólo el sobre cifrado (canario de
// [F-KEY-07]: ni R ni la Password R ni las 17 palabras). Sin recordar el sobre, nada queda (y se borra el de un pedido
// anterior), la pantalla final lo dice, y con un enlace de ida sin k no hay enlace de regreso: se copia a mano.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { getAddress } from 'viem';
import { wordsToRecoveryKey } from '../../src/crypto/backup-words.ts';
import { bytesToBase64Url, bytesToHex } from '../../src/crypto/encoding.ts';
import { parseRecoveryEnvelope } from '../../src/crypto/envelope.ts';
import { parseWordlist } from '../../src/crypto/words.ts';
import { requestExpiryText } from '../../src/enroll/enrollment.ts';
import {
  NEW_R_PER_REQUEST_TEXT,
  R_KEPT_TEXT,
  R_NOT_KEPT_TEXT,
  REMEMBER_R_LABEL,
  RETURN_QR_TEXT,
  RETURN_WITH_SECRET_TEXT,
  RETURN_WITHOUT_SECRET_TEXT,
} from '../../src/enroll/texts.ts';
import { FrameCollector } from '../../src/qr/frames.ts';
import {
  R_APART_FROM_U_WARNING,
  R_BACKUP_INTRO,
  R_WORDS_HANDWRITTEN,
  R_WORDS_TITLE,
  rQrTitle,
} from '../../src/backup/texts.ts';
import {
  accountRoutes,
  enrollmentStepUpRoutes,
  enrollmentView,
  mockApi,
  WALLET_ID,
  type MockRoute,
} from './helpers/mock-api.ts';
import { downloadedText } from './stack/helpers/download.ts';
import { readCanvasQr } from './stack/helpers/qr.ts';

test.use({ timezoneId: 'America/Argentina/Buenos_Aires' });

const ENROLLMENT_ID = '3c1d9a7e-5b2f-4e6a-9c8d-7f6e5d4c3b2a';
const NONCE = `0x${'cd'.repeat(32)}`;
/** Vencimiento del pedido que informa el backend simulado (15:25 UTC = 12:25 en Buenos Aires). */
const EXPIRES_AT = '2030-01-01T15:25:00.000Z';
const EXPIRY_TEXT = requestExpiryText(EXPIRES_AT, 'America/Argentina/Buenos_Aires');
const wordlist = parseWordlist(
  readFileSync(resolve(import.meta.dirname, '../../src/vendor/mtw-wordlist-v1.txt'), 'utf8'),
);

/** Deja `window.print` sin diálogo (cuenta las llamadas) para revisar qué se imprimiría. */
async function stubPrint(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { printed: number };
    target.printed = 0;
    window.print = () => {
      target.printed += 1;
    };
  });
}

/** Con la hoja de impresión: lo marcado se ve y el resto de la página no; después vuelve todo a la normalidad. */
async function expectPrintsOnly(page: Page, visible: string[], hidden: string[]): Promise<void> {
  await page.emulateMedia({ media: 'print' });
  for (const selector of visible) await expect(page.locator(selector).first()).toBeVisible();
  for (const selector of hidden) await expect(page.locator(selector).first()).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('body.printing-section')).toHaveCount(0);
  await expect(page.locator('.print-target')).toHaveCount(0);
}

/**
 * Todo lo que quedó en localStorage, sessionStorage e IndexedDB (clave y valor, una línea por entrada) y las cookies; y
 * aparte, los sobres recordados por Recovery (IndexedDB `mtw-recovery`, `envelopes`).
 */
async function storages(
  page: Page,
  context: BrowserContext,
): Promise<{ dump: string; envelopes: [string, unknown][] }> {
  const found = await page.evaluate(async () => {
    const lines: string[] = [];
    const envelopes: [string, unknown][] = [];
    for (const area of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i) ?? '';
        lines.push(`${key}=${area.getItem(key) ?? ''}`);
      }
    }
    for (const info of await indexedDB.databases()) {
      const name = info.name ?? '';
      if (name === '') continue;
      const db = await new Promise<IDBDatabase>((resolveDb, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => {
          resolveDb(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('indexedDB'));
        };
      });
      for (const storeName of Array.from(db.objectStoreNames)) {
        const entries = await new Promise<[string, unknown][]>((resolveEntries, reject) => {
          const store = db.transaction(storeName, 'readonly').objectStore(storeName);
          const keys = store.getAllKeys();
          const values = store.getAll();
          values.onsuccess = () => {
            resolveEntries(
              keys.result.map((key, i) => [
                typeof key === 'string' ? key : JSON.stringify(key),
                values.result[i] as unknown,
              ]),
            );
          };
          values.onerror = () => {
            reject(values.error ?? new Error('indexedDB'));
          };
        });
        for (const [key, value] of entries) {
          lines.push(`${name}/${storeName}/${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
          if (name === 'mtw-recovery' && storeName === 'envelopes') envelopes.push([key, value]);
        }
      }
      db.close();
    }
    return { lines, envelopes };
  });
  const cookies = (await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`);
  return { dump: [...found.lines, ...cookies].join('\n'), envelopes: found.envelopes };
}

/** R (de sus 17 palabras), la Password R y las 17 palabras no están en ningún storage. */
async function expectNoSecretsStored(dump: string, backupWords: string[], passwordWords: string[]): Promise<void> {
  const key = await wordsToRecoveryKey(backupWords, wordlist);
  const keyHex = bytesToHex(key).slice(2);
  for (const secret of [
    keyHex,
    keyHex.toUpperCase(),
    bytesToBase64Url(key),
    Buffer.from(key).toString('base64'),
    passwordWords.join(' '),
    backupWords.join(' '),
  ]) {
    expect(dump).not.toContain(secret);
  }
}

/** API simulada del enrollment: el pedido (con su vencimiento fijo), la Enrollment Key y el envío de R. */
function enrollmentRoutes(state: { submittedR: string | null; failSubmit?: string }): MockRoute[] {
  return [
    {
      method: 'GET',
      path: /^\/recovery\/enrollments\/([^/]+)$/,
      handle: (_request, [id = '']) => ({ body: enrollmentView(id, state.submittedR, undefined, EXPIRES_AT) }),
    },
    {
      method: 'POST',
      path: /^\/recovery\/enrollments\/([^/]+)\/enrollment-key$/,
      handle: (_request, [id = '']) => ({ body: enrollmentView(id, null, true, EXPIRES_AT) }),
    },
    {
      method: 'POST',
      path: /^\/recovery\/enrollments\/([^/]+)\/submit$/,
      handle: (request, [id = '']) => {
        if (state.failSubmit !== undefined) {
          const code = state.failSubmit;
          delete state.failSubmit;
          return {
            status: 422,
            body: { type: 'about:blank', title: 'vencido', status: 422, code, requestId: 't' },
          };
        }
        const body = request.postDataJSON() as { enrollment: { R: string } };
        state.submittedR = body.enrollment.R;
        return { body: enrollmentView(id, state.submittedR, undefined, EXPIRES_AT) };
      },
    },
  ];
}

/** Step-up con el código del email y la elección de crear R en este navegador. */
async function verifyAndChooseInternal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await page.getByRole('button', { name: 'Crear una clave R en este navegador' }).click();
}

/** Genera la Password R, la "anota" y confirma las 2 palabras que pide (sin cifrar todavía). */
async function writeDownPasswordR(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'Generar mi clave R' }).click();
  const passwordList = page.getByRole('list', { name: 'Password R' }).locator('.words__word');
  await expect(passwordList).toHaveCount(5);
  const passwordWords = await passwordList.allTextContents();
  await page.getByLabel('Anoté las 5 palabras en orden y las guardo fuera de este dispositivo.').check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await field.getAttribute('name'))?.replace('word-', ''));
    await field.fill(passwordWords[position] ?? '');
  }
  return passwordWords;
}

test('backups de R veraces, QR quieto e imprimible, 17 palabras confirmadas, sobre recordado y enlace de regreso con k', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const secret = randomBytes(16).toString('base64url');
  const state: { submittedR: string | null } = { submittedR: null };
  const calls = await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(),
    ...enrollmentStepUpRoutes('2030-01-01T15:10:00.000Z'),
    ...enrollmentRoutes(state),
  ]);

  await page.goto(`/enroll#${new URLSearchParams({ eid: ENROLLMENT_ID, n: NONCE, k: secret }).toString()}`);
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  // El pedido sale de la URL apenas se lee.
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  // R se crea y se usa acá (no «vive» acá), y el pedido vence a una hora: la que informa el backend (hallazgo 3).
  await expect(page.getByText(/R se crea y se usa en esta app, separada de la Wallet/)).toBeVisible();
  await expect(page.getByText(/R vive en esta app/)).toHaveCount(0);
  await expect(page.getByText(EXPIRY_TEXT)).toBeVisible();
  expect(EXPIRY_TEXT).toBe('Este pedido de la app Wallet vence a las 12:25: enviá la dirección antes.');
  await expect(
    page.getByText(
      /Igual vas a necesitar un backup que no dependa de la plataforma ni de Drive \(archivo, QR o las 17 palabras\)\./,
    ),
  ).toBeVisible();

  // Step-up: el vencimiento del código (del backend) y, en vez de «15 minutos», el plazo del pedido (N11, hallazgo 3).
  await expect(
    page.getByText(
      /te vamos a mandar un código por email\. Una vez verificado, enviá la dirección antes de que venza el pedido de la app Wallet\./,
    ),
  ).toBeVisible();
  await expect(page.getByText(/tenés 15 minutos para terminar/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await expect(
    page.getByText(
      /te mandamos un código por email\. El código vence a las 12:10\. Una vez verificado, enviá la dirección antes de que venza el pedido de la app Wallet\./,
    ),
  ).toBeVisible();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar' }).click();

  // Cómo se va a tener R: cada opción con su explicación.
  await expect(page.getByRole('heading', { name: '¿Cómo vas a tener tu clave R?' })).toBeVisible();
  await expect(page.getByText(/Esta app genera R, la cifra con una Password R de 5 palabras/)).toBeVisible();
  await expect(page.getByText(/R es una cuenta común \(EOA\) de una wallet tuya/)).toBeVisible();
  await page.getByRole('button', { name: 'Crear una clave R en este navegador' }).click();
  // Cada pedido crea una R nueva (la de un pedido anterior ya no se usa).
  await expect(page.getByText(NEW_R_PER_REQUEST_TEXT)).toBeVisible();

  // Password R: en inglés, a copiar tal cual; si la confirmación falla, se pueden volver a ver.
  await page.getByRole('button', { name: 'Generar mi clave R' }).click();
  const passwordList = page.getByRole('list', { name: 'Password R' }).locator('.words__word');
  await expect(passwordList).toHaveCount(5);
  const passwordWords = await passwordList.allTextContents();
  await expect(page.getByText(/Están en inglés: copialas letra por letra, sin traducir ni corregir\./)).toBeVisible();
  // La misma casilla que la de la Password U en la Wallet.
  const noted = page.getByLabel('Anoté las 5 palabras en orden y las guardo fuera de este dispositivo.');
  await noted.check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) await field.fill('equivocada');
  await page.getByRole('button', { name: 'Confirmar y cifrar' }).click();
  await expect(page.getByText('Las palabras no coinciden: revisá lo que anotaste.')).toBeVisible();
  await page.getByRole('button', { name: 'Volver a ver las palabras' }).click();
  await expect(passwordList).toHaveText(passwordWords);
  await noted.check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await field.getAttribute('name'))?.replace('word-', ''));
    await field.fill(passwordWords[position] ?? '');
  }
  // En el paso de cifrado, recordar el sobre en este dispositivo viene marcado (como en la Wallet).
  await expect(page.getByLabel(REMEMBER_R_LABEL)).toBeChecked();
  await page.getByRole('button', { name: 'Confirmar y cifrar' }).click();

  // Backups: qué permite R sin la plataforma (NB1), lejos de los de U (hallazgo 1) y nada para seguir sin un backup
  // independiente.
  await expect(page.getByRole('heading', { name: 'Backups de tu clave R' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(R_BACKUP_INTRO)).toBeVisible();
  await expect(page.getByText(R_APART_FROM_U_WARNING)).toBeVisible();
  await expect(page.getByText(/con él y tu Password R vas a poder recuperar tu wallet/i)).toHaveCount(0);
  const proceed = page.getByRole('button', { name: 'Continuar' });
  await expect(proceed).toBeDisabled();
  await expect(page.getByText('Falta al menos un backup: archivo, QR o las 17 palabras.')).toBeVisible();

  // Archivo: se marca recién después de descargarlo, sin la Password R al lado.
  const fileCheck = page.getByLabel('Guardé el archivo fuera de este dispositivo (sin la Password R al lado).');
  await expect(fileCheck).toBeDisabled();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar el archivo cifrado' }).click();
  const file = await downloadedText(await downloading);
  const envelope = parseRecoveryEnvelope(JSON.parse(file));
  expect(envelope).toMatchObject({ role: 'R', walletId: WALLET_ID });
  await expect(fileCheck).toBeEnabled();

  // QR: cuadros quietos, todos a la vista; juntos reconstruyen exactamente el sobre (N1), cada uno con su título.
  await page.getByRole('button', { name: 'Mostrar el QR' }).click();
  const frames = page.getByRole('img', { name: /^QR del sobre cifrado de R, parte \d+ de \d+$/ });
  await expect(frames.first()).toBeVisible();
  const parts = await frames.count();
  const collector = new FrameCollector();
  for (const frame of await frames.all()) collector.add(await readCanvasQr(frame));
  expect(JSON.parse((await collector.content()) ?? 'null')).toEqual(JSON.parse(file));
  await page.waitForTimeout(1_200);
  await expect(frames).toHaveCount(parts);
  await expect(page.getByText(/^Cuadro \d+ de \d+$/)).toHaveCount(0);
  for (let part = 1; part <= parts; part++) await expect(page.getByText(rQrTitle(part, parts))).toBeVisible();
  expect(rQrTitle(1, parts)).toBe(
    `MT Recovery: QR del sobre de tu clave R, parte 1 de ${String(parts)} (se abre con la Password R)`,
  );
  if (parts > 1) {
    await expect(
      page.getByText(
        `El QR tiene ${String(parts)} partes y para restaurar hacen falta todas: guardá o imprimí las ${String(parts)}.`,
      ),
    ).toBeVisible();
  }
  await expect(
    page.getByLabel(
      parts > 1
        ? `Guardé o imprimí las ${String(parts)} partes del QR fuera de este dispositivo (sin la Password R al lado).`
        : 'Guardé o imprimí el QR fuera de este dispositivo (sin la Password R al lado).',
    ),
  ).toBeVisible();
  // «Imprimir QR» imprime sólo los cuadros con su título, no la página (aviso de impresora de confianza).
  await stubPrint(page);
  await page.getByRole('button', { name: 'Imprimir QR' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await expectPrintsOnly(page, ['#r-qr-print canvas', '#r-qr-print figcaption'], ['#backup-title', 'header']);
  await expect(page.getByText('Si lo imprimís, usá una impresora de confianza y no guardes el PDF.')).toBeVisible();

  // 17 palabras: a la vista no dejan seguir (aunque haya otro backup) hasta confirmarlas u ocultarlas (N8).
  await fileCheck.check();
  await expect(proceed).toBeEnabled();
  await expect(
    page.getByText(/guardalas lejos de la Password R y de los backups de tu clave U\. Están en inglés/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mostrar las 17 palabras' }).click();
  const list = page.getByRole('list', { name: '17 palabras de tu clave R' });
  await expect(list.locator('.words__word')).toHaveCount(17);
  const backupWords = await list.locator('.words__word').allTextContents();
  await expect(proceed).toBeDisabled();
  await expect(
    page.getByText(
      'Antes de seguir, confirmá las 17 palabras u ocultalas: después de este paso no se vuelven a mostrar.',
    ),
  ).toBeVisible();
  await expect(page.getByText(/Están en inglés: copialas letra por letra/).last()).toBeVisible();
  // El título de lo que se imprime, y el pedido de anotarlo a mano (hallazgo 7).
  await expect(page.locator('#r-words-print').getByText(R_WORDS_TITLE)).toBeVisible();
  expect(R_WORDS_TITLE).toBe('MT Recovery: 17 palabras de tu clave R');
  await expect(page.getByText(R_WORDS_HANDWRITTEN)).toBeVisible();
  // Una palabra larga no baja debajo de su número (hallazgo 9): cada casilla ocupa una sola línea.
  const heights = await list
    .locator('.words__item')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(2);
  // «Imprimir sólo las palabras»: la página dedicada sin otros datos ([F-KEY-06].4), con su título.
  await page.getByRole('button', { name: 'Imprimir sólo las palabras' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(2);
  await expectPrintsOnly(
    page,
    ['#r-words-print .words__word', '#r-words-print .print-title'],
    ['#backup-title', '#r-qr-print canvas'],
  );
  // Marcar la casilla no las oculta ni las da por anotadas: hay que reingresar 3 al azar.
  await page.getByLabel(/Anoté las 17 palabras/).check();
  await expect(list).toBeVisible();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  const fields = page.getByLabel(/^Palabra \d+ de 17$/);
  await expect(fields).toHaveCount(3);
  await expect(list).toHaveCount(0);
  for (const field of await fields.all()) await field.fill('equivocada');
  await page.getByRole('button', { name: 'Confirmar las palabras' }).click();
  await expect(page.getByText('Alguna palabra no coincide: revisá lo que anotaste.')).toBeVisible();
  await expect(proceed).toBeDisabled();
  await page.getByRole('button', { name: 'Volver a ver las palabras' }).click();
  await expect(list.locator('.words__word')).toHaveText(backupWords);
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await fields.all()) {
    const position = Number((await field.getAttribute('name'))?.replace('backup-word-', ''));
    await field.fill((backupWords[position] ?? '').toUpperCase());
  }
  await page.getByRole('button', { name: 'Confirmar las palabras' }).click();
  await expect(page.getByText('Palabras anotadas y confirmadas.')).toBeVisible();
  await expect(list).toHaveCount(0);
  await expect(proceed).toBeEnabled();

  // Hasta enviar la dirección no se guarda nada en el dispositivo.
  expect((await storages(page, context)).envelopes).toEqual([]);

  // Envío: el vencimiento también junto a «Firmar y enviar»; y el regreso: la dirección en grupos, y el enlace y el QR
  // con el pedido, R y el mismo k.
  await proceed.click();
  const send = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Enviar la dirección de tu clave R' }) });
  await expect(send.getByText(EXPIRY_TEXT)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar y enviar' }).click();
  await expect(page.getByRole('heading', { name: 'Dirección de tu clave R enviada' })).toBeVisible();
  const sent = getAddress((await page.locator('[data-recovery-key]').getAttribute('data-recovery-key')) ?? '');
  expect(sent).toBe(envelope.keyAddress);
  expect(state.submittedR).toBe(sent);
  // Con el sobre recordado: queda cifrado acá, y los backups siguen haciendo falta (bloqueante).
  await expect(page.locator('[data-kept="remembered"]')).toBeVisible();
  await expect(page.getByText(R_KEPT_TEXT, { exact: false })).toBeVisible();
  await expect(page.getByText(/Tu clave R queda en esta app/)).toHaveCount(0);
  await expect(page.getByText(RETURN_WITH_SECRET_TEXT)).toBeVisible();
  await expect(page.locator('[data-recovery-key]')).toContainText(
    `0x ${(sent.slice(2).match(/.{4}/g) ?? []).join(' ')}`,
  );
  const returnLink = (await page.locator('[data-return-link]').getAttribute('data-return-link')) ?? '';
  const link = new URL(returnLink);
  expect(link.pathname).toBe('/onboarding/confirm-recovery');
  expect(Object.fromEntries(new URLSearchParams(link.hash.slice(1)))).toEqual({
    eid: ENROLLMENT_ID,
    r: sent,
    k: secret,
  });
  // Para qué sirve el QR de regreso (hallazgo 9).
  await expect(page.getByText(RETURN_QR_TEXT)).toBeVisible();
  expect(await readCanvasQr(page.getByRole('img', { name: /^QR para volver a la Wallet/ }))).toBe(returnLink);
  await expect(page.getByText(/No los mandes por chat ni por email/)).toBeVisible();
  // k sólo viajó en los fragmentos: ningún pedido a la API lo lleva (ni en la ruta, ni en el cuerpo, ni en los headers).
  expect(calls.length).toBeGreaterThan(0);
  expect(
    calls.filter((call) => `${call.path} ${call.body ?? ''} ${JSON.stringify(call.headers)}`.includes(secret)),
  ).toEqual([]);

  // Canario de [F-KEY-07]: en el dispositivo quedó el sobre cifrado (el mismo del archivo) y nada más de R.
  const { dump, envelopes } = await storages(page, context);
  // Uno por clave de cada wallet (en un reemplazo conviven el de la R vigente y el de R′).
  expect(envelopes.map(([key]) => key)).toEqual([`${WALLET_ID}:${envelope.keyAddress.toLowerCase()}`]);
  const remembered = envelopes[0]?.[1];
  expect(typeof remembered).toBe('string');
  expect(parseRecoveryEnvelope(JSON.parse(String(remembered)))).toEqual(envelope);
  await expectNoSecretsStored(dump, backupWords, passwordWords);
  expect(dump).not.toContain(secret);
});

test('sin recordar el sobre nada queda (se borra el de un pedido anterior); sin k no hay enlace de regreso; un pedido vencido al enviar', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const state: { submittedR: string | null; failSubmit?: string } = {
    submittedR: null,
    failSubmit: 'ENROLLMENT_EXPIRED',
  };
  await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(),
    ...enrollmentStepUpRoutes('2030-01-01T15:10:00.000Z'),
    ...enrollmentRoutes(state),
  ]);

  // Un enlace de ida sin k (de una Wallet anterior o recortado en el camino).
  await page.goto(`/enroll#${new URLSearchParams({ eid: ENROLLMENT_ID, n: NONCE }).toString()}`);
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  // En este dispositivo quedó el sobre de la R de un pedido anterior de esta misma wallet (todavía en creación), con la
  // clave con la que se guardaba antes (sólo la wallet).
  await page.evaluate(async (walletId) => {
    await new Promise<void>((resolveDone, reject) => {
      const request = indexedDB.open('mtw-recovery', 2);
      request.onupgradeneeded = () => {
        for (const name of ['envelopes', 'safes']) request.result.createObjectStore(name);
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('envelopes', 'readwrite');
        tx.objectStore('envelopes').put('{"de":"un pedido anterior"}', walletId);
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
  }, WALLET_ID);
  expect((await storages(page, context)).envelopes.map(([key]) => key)).toEqual([WALLET_ID]);

  await verifyAndChooseInternal(page);
  const passwordWords = await writeDownPasswordR(page);
  // Sin recordar el sobre (dispositivo compartido).
  await page.getByLabel(REMEMBER_R_LABEL).uncheck();
  await page.getByRole('button', { name: 'Confirmar y cifrar' }).click();
  await expect(page.getByRole('heading', { name: 'Backups de tu clave R' })).toBeVisible({ timeout: 60_000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar el archivo cifrado' }).click();
  const envelope = parseRecoveryEnvelope(JSON.parse(await downloadedText(await downloading)));
  await page.getByLabel('Guardé el archivo fuera de este dispositivo (sin la Password R al lado).').check();
  await page.getByRole('button', { name: 'Mostrar las 17 palabras' }).click();
  const backupWords = await page
    .getByRole('list', { name: '17 palabras de tu clave R' })
    .locator('.words__word')
    .allTextContents();
  expect(backupWords).toHaveLength(17);
  await page.getByRole('button', { name: 'Ocultar las palabras' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();

  // El pedido venció antes de enviar: esta R no se va a usar y hay que destruir sus backups (hallazgo 3); no se guardó
  // nada ni se borró el sobre anterior.
  await page.getByRole('button', { name: 'Firmar y enviar' }).click();
  await expect(
    page.getByText(
      'El pedido venció antes de enviar la dirección: esta clave R no se va a usar; destruí sus backups y generá un pedido nuevo desde la app Wallet.',
    ),
  ).toBeVisible();
  expect((await storages(page, context)).envelopes.map(([key]) => key)).toEqual([WALLET_ID]);

  // (La API simulada acepta el segundo intento.) Enviada sin recordar: la pantalla dice que no queda nada y qué hace
  // falta para usarla después; y sin k, ni enlace ni QR de regreso: se copia a mano.
  await page.getByRole('button', { name: 'Firmar y enviar' }).click();
  await expect(page.getByRole('heading', { name: 'Dirección de tu clave R enviada' })).toBeVisible();
  expect(getAddress((await page.locator('[data-recovery-key]').getAttribute('data-recovery-key')) ?? '')).toBe(
    envelope.keyAddress,
  );
  await expect(page.locator('[data-kept="not-remembered"]')).toBeVisible();
  await expect(page.getByText(R_NOT_KEPT_TEXT, { exact: false })).toBeVisible();
  await expect(page.getByText(RETURN_WITHOUT_SECRET_TEXT)).toBeVisible();
  await expect(page.getByText(/se confirma sola/)).toHaveCount(0);
  await expect(page.locator('[data-return-link]')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /^QR para volver a la Wallet/ })).toHaveCount(0);
  // Nada de R en el dispositivo: tampoco el sobre del pedido anterior (en el onboarding su R ya no se usa).
  const { dump, envelopes } = await storages(page, context);
  expect(envelopes).toEqual([]);
  await expectNoSecretsStored(dump, backupWords, passwordWords);
});
