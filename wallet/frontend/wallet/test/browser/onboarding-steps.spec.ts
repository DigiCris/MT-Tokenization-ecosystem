// Onboarding de U hasta el registro (revisión de P17.MAN) contra `vite preview`, con la API simulada
// (test/browser/helpers/mock-api.ts): el indicador marca el paso actual distinto de los completados (aria-current); el
// step-up dice que va a mandar el código y, ya enviado, cuándo vence según el `expiresAt` del backend; un botón que
// espera una acción no muestra el cursor de carga y uno que carga sí; la Password U avisa que las palabras están en
// inglés; el cifrado ofrece la opción avanzada de 128 MiB desactivada y con su advertencia, y el sobre elegido la lleva
// ([F-KEY-03]); los backups dicen qué pasa si se pierden U y R (B1) y qué abre cada backup (O2); y las 17 palabras
// cuentan como backup recién al reingresar 3 al azar: una casilla no las oculta, un error permite volver a verlas y,
// mientras están a la vista sin confirmar, no se puede seguir (se confirman o se ocultan, N8). Tercera revisión de
// P17.MAN: lo impreso (QR y 17 palabras) dice de qué app y de qué clave es, el QR avisa de la impresora de confianza y
// las 17 palabras se guardan lejos de los backups de R (U y R juntas mueven los fondos sin la plataforma).
import { expect, test, type Page } from '@playwright/test';
import { LOST_U_AND_R_WARNING, U_WORDS_HANDWRITTEN, U_WORDS_TITLE, uQrTitle } from '../../src/onboarding/user-key.ts';
import { accountRoutes, creatingWallet, mockApi, onboardingStepUpRoutes, WALLET_ID } from './helpers/mock-api.ts';
import { downloadedText } from './stack/helpers/download.ts';

test.use({ timezoneId: 'America/Argentina/Buenos_Aires' });

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
}

test('pasos, step-up, Password U, cifrado de 128 MiB y backups con las 17 palabras confirmadas', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  let wallet: ReturnType<typeof creatingWallet> | null = null;
  let releaseCode: () => void = () => undefined;
  const codeHeld = new Promise<void>((resolve) => {
    releaseCode = resolve;
  });
  await mockApi(context, new URL(baseURL ?? '').origin, [
    ...accountRoutes(() => wallet),
    // El pedido del código queda en espera hasta comprobar cómo se ve el botón mientras carga.
    {
      method: 'POST',
      path: /^\/platform-sessions\/step-up\/start$/,
      handle: async () => {
        await codeHeld;
        return { status: 202, body: { challengeId: crypto.randomUUID(), expiresAt: '2030-01-01T15:10:00.000Z' } };
      },
    },
    ...onboardingStepUpRoutes('2030-01-01T15:10:00.000Z', () => wallet?.id ?? null),
    {
      method: 'POST',
      path: /^\/wallets$/,
      handle: () => {
        wallet = creatingWallet();
        return { status: 201, body: wallet };
      },
    },
    {
      method: 'GET',
      path: /^\/wallets\/[^/]+\/deployment$/,
      handle: () => ({ body: { walletId: WALLET_ID, status: 'CREATING', U: null } }),
    },
  ]);

  await page.goto('/onboarding');
  const steps = page.getByRole('list', { name: 'Pasos' });
  const current = steps.locator('[aria-current="step"]');
  await expect(current).toHaveText('Drive');
  await expect(current).toHaveClass(/steps__item--current/);
  await expect(steps.locator('[aria-current]')).toHaveCount(1);
  // Drive: qué es la carpeta privada y qué pasa si se sigue sin Drive.
  await expect(page.getByText(/Esa carpeta no aparece entre tus archivos de Drive/)).toBeVisible();
  await expect(page.getByText(/^Sin Drive seguís igual/)).toBeVisible();
  await page.getByRole('button', { name: 'Seguir sin Drive' }).click();

  // El paso actual se distingue del completado.
  await expect(current).toHaveText('Identidad');
  const drive = steps.getByText('Drive', { exact: true });
  await expect(drive).toHaveClass(/steps__item--done/);
  await expect(drive).not.toHaveAttribute('aria-current', 'step');
  await expect(
    page.getByText('Para crear tu wallet te vamos a mandar un código de 8 dígitos a tu email.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  const sending = page.getByRole('button', { name: 'Enviando…' });
  await expect(sending).toBeDisabled();
  await expect(sending).toHaveAttribute('aria-busy', 'true');
  await expect(sending).toHaveCSS('cursor', 'progress');
  releaseCode();
  // El vencimiento sale del expiresAt del backend (15:10 UTC = 12:10 en Buenos Aires), no de un plazo fijo.
  await expect(page.getByText('Código enviado. Vence a las 12:10.')).toBeVisible();
  await expect(
    page.getByText('Para crear tu wallet ingresá el código de 8 dígitos que te mandamos a tu email.'),
  ).toBeVisible();
  await page.getByLabel('Código del email').fill('12345678');
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();

  // Password U: palabras en inglés, a copiar tal cual; el botón espera la casilla (no está cargando).
  const shown = page.locator('ol[aria-label="Password U"] .words__word');
  await expect(shown).toHaveCount(5, { timeout: 30_000 });
  await expect(current).toHaveText('Password U');
  await expect(page.getByText(/Están en inglés: copialas letra por letra, sin traducir ni corregir\./)).toBeVisible();
  const words = await shown.allTextContents();
  const written = page.getByRole('button', { name: 'Ya las anoté' });
  await expect(written).toBeDisabled();
  await expect(written).toHaveCSS('cursor', 'not-allowed');
  await page.getByLabel(/Anoté las 5 palabras/).check();
  await written.click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await field.getAttribute('name'))?.replace('word-', ''));
    await field.fill(words[position] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();

  // Cifrado: recordar el sobre viene marcado (con el aviso para computadoras compartidas) y la opción de 128 MiB no.
  await expect(page.getByRole('heading', { name: 'Cifrar tu clave' })).toBeVisible();
  await expect(page.getByLabel(/^Recordar el sobre cifrado en este dispositivo/)).toBeChecked();
  await expect(page.getByText(/Si la computadora es compartida, desmarcalo\./)).toBeVisible();
  const strong = page.getByLabel(/128 MiB de memoria en lugar de 64 MiB/);
  await expect(strong).toBeHidden();
  await page.getByText('Opciones avanzadas').click();
  await expect(strong).not.toBeChecked();
  await expect(page.getByText(/Un sobre cifrado con 128 MiB puede no abrir en celulares/)).toBeVisible();
  await strong.check();
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click();

  // Backups: qué pasa si se pierden U y R, y qué abre cada backup independiente.
  await expect(page.getByText('Drive no está conectado en esta sesión: este backup queda pendiente.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(current).toHaveText('Backups');
  await expect(page.getByText(LOST_U_AND_R_WARNING)).toBeVisible();
  await expect(
    page.getByText(/El archivo y el QR sólo se abren con tu Password U; las 17 palabras no la necesitan\./),
  ).toBeVisible();
  await expect(
    page.getByText(/Sin la plataforma, para mover tus fondos también vas a necesitar tu clave R\./),
  ).toBeVisible();
  // El sobre se cifró con los 128 MiB elegidos.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar el archivo cifrado' }).click();
  const envelope = JSON.parse(await downloadedText(await downloading)) as { kdf: { memoryKiB: number } };
  expect(envelope.kdf.memoryKiB).toBe(131_072);

  // QR: si son varias partes, hacen falta todas; la casilla pide guardarlo sin la Password U al lado.
  await page.getByRole('button', { name: 'Mostrar QR' }).click();
  const frames = page.getByRole('img', { name: /QR del sobre cifrado/ });
  await expect(frames.first()).toBeVisible();
  const parts = await frames.count();
  if (parts > 1) {
    await expect(
      page.getByText(
        `El QR tiene ${String(parts)} partes y para restaurar hacen falta todas: guardá o imprimí las ${String(parts)}.`,
      ),
    ).toBeVisible();
    await expect(
      page.getByLabel(
        `Guardé o imprimí las ${String(parts)} partes del QR fuera de este dispositivo (sin la Password U al lado).`,
      ),
    ).toBeVisible();
  } else {
    await expect(
      page.getByLabel('Guardé o imprimí el QR fuera de este dispositivo (sin la Password U al lado).'),
    ).toBeVisible();
  }
  // Cada cuadro dice de qué app y qué clave es, qué parte y con qué se abre; se imprimen solos, con ese título, y se
  // avisa de la impresora de confianza (hallazgos 7 y 9).
  for (let part = 1; part <= parts; part++) await expect(page.getByText(uQrTitle(part, parts))).toBeVisible();
  await expect(page.getByText('Si lo imprimís, usá una impresora de confianza y no guardes el PDF.')).toBeVisible();
  await stubPrint(page);
  await page.getByRole('button', { name: 'Imprimir QR' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await expectPrintsOnly(page, ['#qr-print canvas', '#qr-print figcaption'], ['#backup-file', 'header']);

  // 17 palabras: a la vista sin confirmar no dejan seguir (N8): hay que confirmarlas u ocultarlas.
  const openWords = page.getByText(
    'Antes de seguir, confirmá las 17 palabras u ocultalas: después de este paso no se vuelven a mostrar.',
  );
  await expect(openWords).toHaveCount(0);
  await page.getByRole('button', { name: 'Mostrar las 17 palabras' }).click();
  const list = page.getByRole('list', { name: '17 palabras de la clave' });
  await expect(list.locator('.words__word')).toHaveCount(17);
  const backupWords = await list.locator('.words__word').allTextContents();
  await expect(openWords).toBeVisible();
  await page.getByRole('button', { name: 'Ocultar las palabras' }).click();
  await expect(list).toHaveCount(0);
  await expect(openWords).toHaveCount(0);
  // Se pueden volver a mostrar (las mismas) hasta confirmarlas; marcar la casilla no las oculta ni las da por anotadas.
  await page.getByRole('button', { name: 'Mostrar las 17 palabras' }).click();
  await expect(list.locator('.words__word')).toHaveText(backupWords);
  await expect(openWords).toBeVisible();
  await expect(page.getByText(/Están en inglés: copialas letra por letra/)).toBeVisible();
  await expect(page.getByText('Si las imprimís, usá una impresora de confianza y no guardes el PDF.')).toBeVisible();
  // Lejos de la Password U y de los backups de R: U y R juntas mueven los fondos sin la plataforma (hallazgo 1).
  await expect(
    page.getByText(
      /guardalas lejos de la Password U y de los backups de tu clave R: quien junte tu clave U y tu clave R puede mover tus fondos sin la plataforma\./,
    ),
  ).toBeVisible();
  // Con su título, también impreso, y el pedido de anotarlo a mano (hallazgo 7).
  await expect(page.locator('#words-print').getByText(U_WORDS_TITLE)).toBeVisible();
  await expect(page.getByText(U_WORDS_HANDWRITTEN)).toBeVisible();
  await page.getByRole('button', { name: 'Imprimir sólo las palabras' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(2);
  await expectPrintsOnly(
    page,
    ['#words-print .words__word', '#words-print .print-title'],
    ['#backup-file', '#qr-print canvas'],
  );
  await page.getByLabel(/Anoté las 17 palabras/).check();
  await expect(list).toBeVisible();
  const proceed = page.getByRole('button', { name: 'Continuar' });
  await expect(proceed).toBeDisabled();
  await expect(proceed).toHaveCSS('cursor', 'not-allowed');
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  const fields = page.getByLabel(/^Palabra \d+ de 17$/);
  await expect(fields).toHaveCount(3);
  await expect(list).toHaveCount(0);
  // Una palabra mal no se acepta, y las palabras se pueden volver a ver.
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
  await expect(page.getByRole('button', { name: 'Mostrar las 17 palabras' })).toHaveCount(0);
  await expect(openWords).toHaveCount(0);

  // Con las palabras confirmadas alcanza el backup independiente; el registro dice qué recibe la plataforma.
  await proceed.click();
  await expect(current).toHaveText('Registro');
  await expect(
    page.getByText(
      'La plataforma recibe sólo la dirección de tu clave, los parámetros públicos del cifrado, qué backups hiciste y un registro que le permite comprobar tu Password U sin conocerla.',
    ),
  ).toBeVisible();
});
