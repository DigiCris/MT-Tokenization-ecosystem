// Enrollment de R desde el enlace de la Wallet (segunda revisión de P17.MAN: NB1, N1, N2 del lado de Recovery y N11)
// contra `vite preview`, con la API simulada (test/browser/helpers/mock-api.ts): el step-up separa el vencimiento del
// código de los 15 minutos de la verificación; la Password R avisa que las palabras están en inglés y se pueden volver a
// ver si la confirmación falla; los backups dicen la verdad sobre qué permite R sin la plataforma (hace falta también
// U), el archivo y el QR piden guardarse sin la Password R al lado, el QR son cuadros quietos que juntos reconstruyen el
// sobre y se imprimen solos, y las 17 palabras se imprimen solas y cuentan como backup recién al reingresar 3 al azar
// (mientras están a la vista sin confirmar no se puede seguir). Al final, el enlace y el QR de regreso llevan el pedido,
// la dirección de R y el mismo secreto k del enlace de ida, que no viaja en ningún pedido a la API.
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { getAddress } from 'viem';
import { parseRecoveryEnvelope } from '../../src/crypto/envelope.ts';
import { FrameCollector } from '../../src/qr/frames.ts';
import { R_BACKUP_INTRO } from '../../src/backup/texts.ts';
import { accountRoutes, enrollmentStepUpRoutes, enrollmentView, mockApi, WALLET_ID } from './helpers/mock-api.ts';
import { downloadedText } from './stack/helpers/download.ts';
import { readCanvasQr } from './stack/helpers/qr.ts';

test.use({ timezoneId: 'America/Argentina/Buenos_Aires' });

const ENROLLMENT_ID = '3c1d9a7e-5b2f-4e6a-9c8d-7f6e5d4c3b2a';
const NONCE = `0x${'cd'.repeat(32)}`;

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
async function expectPrintsOnly(page: Page, visible: string, hidden: string[]): Promise<void> {
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator(visible).first()).toBeVisible();
  for (const selector of hidden) await expect(page.locator(selector).first()).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('body.printing-section')).toHaveCount(0);
  await expect(page.locator('.print-target')).toHaveCount(0);
}

test('backups de R veraces, QR quieto e imprimible, 17 palabras confirmadas y enlace de regreso con k', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const secret = randomBytes(16).toString('base64url');
  let submittedR: string | null = null;
  const calls = await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(),
    ...enrollmentStepUpRoutes('2030-01-01T15:10:00.000Z'),
    {
      method: 'GET',
      path: /^\/recovery\/enrollments\/([^/]+)$/,
      handle: (_request, [id = '']) => ({ body: enrollmentView(id, submittedR) }),
    },
    {
      method: 'POST',
      path: /^\/recovery\/enrollments\/([^/]+)\/enrollment-key$/,
      handle: (_request, [id = '']) => ({ body: enrollmentView(id, null, true) }),
    },
    {
      method: 'POST',
      path: /^\/recovery\/enrollments\/([^/]+)\/submit$/,
      handle: (request, [id = '']) => {
        const body = request.postDataJSON() as { enrollment: { R: string } };
        submittedR = body.enrollment.R;
        return { body: enrollmentView(id, submittedR) };
      },
    },
  ]);

  await page.goto(`/enroll#${new URLSearchParams({ eid: ENROLLMENT_ID, n: NONCE, k: secret }).toString()}`);
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  // El pedido sale de la URL apenas se lee.
  expect(await page.evaluate(() => window.location.hash)).toBe('');

  // Step-up: el vencimiento del código (del backend) y el plazo de la verificación son dos cosas distintas (N11).
  await expect(
    page.getByText(/te vamos a mandar un código por email\. Una vez verificado, tenés 15 minutos para terminar\./),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await expect(
    page.getByText(
      /te mandamos un código por email\. El código vence a las 12:10\. Una vez verificado, tenés 15 minutos para terminar\./,
    ),
  ).toBeVisible();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await page.getByRole('button', { name: 'Crear una clave R en este navegador' }).click();

  // Password R: en inglés, a copiar tal cual; si la confirmación falla, se pueden volver a ver.
  await page.getByRole('button', { name: 'Generar mi clave R' }).click();
  const passwordList = page.getByRole('list', { name: 'Password R' }).locator('.words__word');
  await expect(passwordList).toHaveCount(5);
  const passwordWords = await passwordList.allTextContents();
  await expect(page.getByText(/Están en inglés: copialas letra por letra, sin traducir ni corregir\./)).toBeVisible();
  await page.getByLabel('Anoté las 5 palabras en un lugar seguro').check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) await field.fill('equivocada');
  await page.getByRole('button', { name: 'Confirmar y cifrar' }).click();
  await expect(page.getByText('Las palabras no coinciden: revisá lo que anotaste.')).toBeVisible();
  await page.getByRole('button', { name: 'Volver a ver las palabras' }).click();
  await expect(passwordList).toHaveText(passwordWords);
  await page.getByLabel('Anoté las 5 palabras en un lugar seguro').check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await field.getAttribute('name'))?.replace('word-', ''));
    await field.fill(passwordWords[position] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar y cifrar' }).click();

  // Backups: qué permite R sin la plataforma (NB1) y nada para seguir sin un backup independiente.
  await expect(page.getByRole('heading', { name: 'Backups de tu clave R' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(R_BACKUP_INTRO)).toBeVisible();
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

  // QR: cuadros quietos, todos a la vista; juntos reconstruyen exactamente el sobre (N1).
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
  // «Imprimir QR» imprime sólo los cuadros, no la página (aviso de impresora de confianza).
  await stubPrint(page);
  await page.getByRole('button', { name: 'Imprimir QR' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await expectPrintsOnly(page, '#r-qr-print canvas', ['#backup-title', 'header']);
  await expect(page.getByText('Si lo imprimís, usá una impresora de confianza y no guardes el PDF.')).toBeVisible();

  // 17 palabras: a la vista no dejan seguir (aunque haya otro backup) hasta confirmarlas u ocultarlas (N8).
  await fileCheck.check();
  await expect(proceed).toBeEnabled();
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
  // «Imprimir sólo las palabras»: la página dedicada sin otros datos ([F-KEY-06].4).
  await page.getByRole('button', { name: 'Imprimir sólo las palabras' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(2);
  await expectPrintsOnly(page, '#r-words-print .words__word', ['#backup-title', '#r-qr-print canvas']);
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

  // Envío y regreso: la dirección en grupos, y el enlace y el QR con el pedido, R y el mismo k.
  await proceed.click();
  await page.getByRole('button', { name: 'Firmar y enviar' }).click();
  await expect(page.getByRole('heading', { name: 'Dirección de tu clave R enviada' })).toBeVisible();
  const sent = getAddress((await page.locator('[data-recovery-key]').getAttribute('data-recovery-key')) ?? '');
  expect(sent).toBe(envelope.keyAddress);
  expect(submittedR).toBe(sent);
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
  expect(await readCanvasQr(page.getByRole('img', { name: /^QR para volver a la Wallet/ }))).toBe(returnLink);
  await expect(page.getByText(/No los mandes por chat ni por email/)).toBeVisible();
  // k sólo viajó en los fragmentos: ningún pedido a la API lo lleva (ni en la ruta, ni en el cuerpo, ni en los headers).
  expect(calls.length).toBeGreaterThan(0);
  expect(
    calls.filter((call) => `${call.path} ${call.body ?? ''} ${JSON.stringify(call.headers)}`.includes(secret)),
  ).toEqual([]);
});
