// Acciones de UI comunes de los specs contra el stack (por rol y etiqueta, como las usa una persona).
import { expect, type Locator, type Page } from '@playwright/test';
import type { Address } from 'viem';
import { serializeEnvelope, type KeyEnvelope } from '../../../../src/crypto/envelope.ts';
import { addressGroups } from '../../../../src/recovery-activation/activation.ts';
import { downloadedText } from './download.ts';
import { nextCode } from './mailpit.ts';

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Contraseña de cuenta', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

/** Lee las 5 palabras de la Password U que muestra la app y confirma las 2 que pide. */
export async function writeDownAndConfirmPassword(page: Page): Promise<string[]> {
  const shown = page.locator('ol[aria-label="Password U"] .words__word');
  await expect(shown).toHaveCount(5, { timeout: 60_000 });
  const words = await shown.allTextContents();
  await page.getByLabel(/Anoté las 5 palabras/).check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const label of await page.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await label.getAttribute('name'))?.replace('word-', ''));
    await label.fill(words[position] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  return words;
}

/** Step-up por email (+ TOTP si se pasa) en la pantalla actual. */
export async function completeStepUp(page: Page, email: string, second?: () => Promise<string>): Promise<void> {
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill(await nextCode(email));
  if (second) await page.getByLabel(/app de autenticación o de recuperación/).fill(await second());
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
}

/** Descarga el archivo cifrado del paso de backups, lo confirma y devuelve su contenido. */
export async function backupToFile(page: Page): Promise<string> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar archivo cifrado' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^mtw-U-[0-9a-f-]{36}\.enc\.json$/);
  const content = await downloadedText(download);
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
