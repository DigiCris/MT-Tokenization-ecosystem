// Acciones de UI comunes de los specs contra el stack (por rol y etiqueta, como las usa una persona).
import { expect, type Locator, type Page } from '@playwright/test';
import type { Address } from 'viem';
import { parseEnvelope, serializeEnvelope, type KeyEnvelope } from '../../../../src/crypto/envelope.ts';
import { addressGroups } from '../../../../src/recovery-activation/activation.ts';
import { envelopeFileName } from '../../../../src/ui/download.ts';
import { downloadedText } from './download.ts';
import { nextCode } from './mailpit.ts';

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Contraseña de cuenta', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

/**
 * Lee las 5 palabras de la Password U que muestra la app y confirma las 2 que pide (`onConfirmScreen` corre con la
 * pantalla de confirmación a la vista, antes de completarla).
 */
export async function writeDownAndConfirmPassword(
  page: Page,
  onConfirmScreen?: () => Promise<void>,
): Promise<string[]> {
  const shown = page.locator('ol[aria-label="Password U"] .words__word');
  await expect(shown).toHaveCount(5, { timeout: 60_000 });
  const words = await shown.allTextContents();
  await page.getByLabel(/Anoté las 5 palabras/).check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  await expect(page.getByRole('heading', { name: 'Confirmá tu Password U' })).toBeVisible();
  await onConfirmScreen?.();
  for (const label of await page.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await label.getAttribute('name'))?.replace('word-', ''));
    await label.fill(words[position] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  return words;
}

/**
 * Las 17 palabras del paso de backups: las muestra, las "anota" (las lee de la pantalla), confirma las 3 que pide la app
 * y devuelve las 17. Los hooks corren con las palabras a la vista y con la confirmación a la vista, antes de completarla.
 */
export async function writeDownAndConfirmBackupWords(
  page: Page,
  hooks: { onShown?: () => Promise<void>; onConfirmScreen?: () => Promise<void> } = {},
): Promise<string[]> {
  await page.getByRole('button', { name: 'Mostrar las 17 palabras' }).click();
  const list = page.getByRole('list', { name: '17 palabras de la clave' });
  await expect(list.locator('.words__word')).toHaveCount(17);
  const words = await list.locator('.words__word').allTextContents();
  await hooks.onShown?.();
  await page.getByLabel(/Anoté las 17 palabras/).check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  const fields = page.getByLabel(/^Palabra \d+ de 17$/);
  await expect(fields).toHaveCount(3);
  await hooks.onConfirmScreen?.();
  for (const field of await fields.all()) {
    const position = Number((await field.getAttribute('name'))?.replace('backup-word-', ''));
    await field.fill(words[position] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar las palabras' }).click();
  await expect(page.getByText('Palabras anotadas y confirmadas.')).toBeVisible();
  // Confirmadas, dejan de mostrarse (y de estar en memoria).
  await expect(list).toHaveCount(0);
  return words;
}

/** Step-up por email (+ TOTP si se pasa) en la pantalla actual. */
export async function completeStepUp(page: Page, email: string, second?: () => Promise<string>): Promise<void> {
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill(await nextCode(email));
  if (second) await page.getByLabel(/app de autenticación o de recuperación/).fill(await second());
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
}

/**
 * Descarga el archivo cifrado del paso de backups, lo confirma y devuelve su contenido. El nombre lleva el principio y
 * el final de la dirección de la clave (cuarta revisión de P17.MAN).
 */
export async function backupToFile(page: Page): Promise<string> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar el archivo cifrado' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^mtw-U-[0-9a-f-]{36}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}\.enc\.json$/);
  const content = await downloadedText(download);
  expect(download.suggestedFilename()).toBe(envelopeFileName(parseEnvelope(JSON.parse(content))));
  await page.getByLabel(/Guardé el archivo fuera de este dispositivo/).check();
  return content;
}

export async function unlockWithFile(
  page: Page,
  envelopeJson: string,
  passwordWords: readonly string[],
  remember = false,
) {
  await page.goto('/unlock');
  await page.getByRole('button', { name: 'Desde un archivo' }).click();
  await page.getByLabel(/Archivo del sobre cifrado/).setInputFiles({
    name: 'mtw-U.enc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(envelopeJson),
  });
  await page.getByLabel('Password U').fill(passwordWords.join(' '));
  if (remember) await page.getByLabel('Recordar el sobre cifrado en este dispositivo').check();
  await page.getByRole('button', { name: 'Desbloquear' }).click();
}

/** Login, desbloqueo con el archivo del sobre y la Password U, y el inicio con la Safe verificada por la app. */
export async function unlockToHome(
  page: Page,
  wallet: { email: string; password: string; envelope: KeyEnvelope; passwordWords: readonly string[] },
): Promise<void> {
  await login(page, wallet.email, wallet.password);
  await unlockWithFile(page, serializeEnvelope(wallet.envelope), wallet.passwordWords);
  await expect(page.getByRole('heading', { name: 'Tu Safe' })).toBeVisible({ timeout: 60_000 });
}

// Con la wallet desbloqueada se navega por los links de la app: el desbloqueo vive sólo en memoria y `page.goto`
// recarga la página (la app vuelve a pedir el desbloqueo).

/** Vuelve al inicio pasando por Seguridad, así el inicio se monta de nuevo y relee la cadena y el backend. */
export async function goHome(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Seguridad', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Seguridad', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'MT Wallet, inicio' }).click();
  await expect(page.getByRole('heading', { name: 'Tu Safe' })).toBeVisible({ timeout: 60_000 });
}

/** Una pantalla de operación desde los links del inicio (Enviar, Swap, Whitelist, Activos, actividad). */
export async function openFromHome(page: Page, link: string): Promise<void> {
  await goHome(page);
  await page.getByRole('link', { name: link, exact: true }).click();
}

/** Una pantalla de Seguridad desde el link de la cuenta. */
export async function openSecurity(page: Page, link: string): Promise<void> {
  await page.getByRole('link', { name: 'Seguridad', exact: true }).click();
  await page.getByRole('link', { name: link, exact: true }).click();
}

/** Estado de una operación que ya quedó en la cadena. */
export function settled(page: Page): Locator {
  return page.locator('[data-status="MINED"], [data-status="CONFIRMED"], [data-status="FINALIZED"]');
}

/** Una dirección como la muestra la app: EIP-55 en grupos de 4 caracteres. */
export function shownAddress(address: Address): string {
  return `0x ${addressGroups(address).join(' ')}`;
}
