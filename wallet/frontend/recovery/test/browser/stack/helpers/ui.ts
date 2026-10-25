// Pasos comunes de la UI de Recovery en los tests: login con la misma cuenta que en Wallet, step-up con el código real
// del email, desbloqueo de R desde el archivo cifrado con la Password R y la copia de una dirección de la otra app en
// los 10 grupos de una comparación.
import { expect, type Page } from '@playwright/test';
import { getAddress } from 'viem';
import { nextCode } from './mailpit.ts';
import { ACCOUNT_PASSWORD } from './api.ts';
import type { SealedRecovery } from './envelope.ts';

export async function login(page: Page, email: string, password = ACCOUNT_PASSWORD): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Contraseña de cuenta').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
}

/** Step-up de Recovery: pide el código, lo lee de Mailpit y confirma. */
export async function completeStepUp(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'Mandarme el código' }).click();
  await page.getByLabel('Código del email').fill(await nextCode(email));
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByRole('heading', { name: 'Verificá que sos vos' })).toHaveCount(0, { timeout: 30_000 });
}

/** Desbloquea R desde el archivo cifrado (como si el usuario lo eligiera de su disco). */
export async function unlockFromFile(page: Page, sealed: SealedRecovery, remember = false): Promise<void> {
  await page.getByLabel('Archivo del sobre cifrado (R.enc)').setInputFiles({
    name: `mtw-R-${sealed.envelope.walletId}.enc.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(sealed.file),
  });
  await page.getByLabel('Password R').fill(sealed.passwordWords.join(' '));
  if (remember) await page.getByLabel('Recordar el sobre cifrado en este dispositivo').check();
  await page.getByRole('button', { name: 'Desbloquear R' }).click();
}

/** Login + desbloqueo de R + step-up RECOVERY: lo que pide el RecoveryGate antes de operar. */
export async function throughGate(page: Page, email: string, sealed: SealedRecovery): Promise<void> {
  await login(page, email);
  await unlockFromFile(page, sealed);
  await completeStepUp(page, email);
}

/** El estado final de una operación seguida en el review (minada o más). */
export function settled(page: Page) {
  return page.locator('[data-status="MINED"], [data-status="CONFIRMED"], [data-status="FINALIZED"]').first();
}

/** Login + R externa (la wallet de prueba ya instalada en la página) + step-up RECOVERY. */
export async function throughGateWithWallet(page: Page, email: string): Promise<void> {
  await login(page, email);
  await page.getByRole('button', { name: 'Mi clave R es una wallet externa' }).click();
  await page.locator('[data-connector="test.mtw.wallet"]').click();
  await completeStepUp(page, email);
}

/** Navega dentro de la app (sin recargar: la sesión, R y la PlatformSession viven sólo en memoria). */
export async function openFromHome(page: Page, title: string): Promise<void> {
  await page.getByRole('link', { name: 'MT Recovery, inicio' }).click();
  await page.getByRole('link', { name: title }).click();
}

/** Genera la Password R en la app, la "anota" (lee las 5 palabras) y confirma las 2 que pide. */
export async function writeDownPasswordR(page: Page, generateLabel: string, confirmLabel: string): Promise<string[]> {
  await page.getByRole('button', { name: generateLabel }).click();
  const list = page.getByRole('list', { name: 'Password R' }).locator('.words__word');
  await expect(list).toHaveCount(5);
  const words = await list.allTextContents();
  await page.getByLabel('Anoté las 5 palabras en un lugar seguro').check();
  await page.getByRole('button', { name: 'Ya las anoté' }).click();
  for (const field of await page.getByLabel(/^Palabra \d$/).all()) {
    await field.fill(words[Number((await field.getAttribute('name'))?.replace('word-', ''))] ?? '');
  }
  await page.getByRole('button', { name: confirmLabel }).click();
  return words;
}

/** Los 10 grupos de 4 caracteres de una dirección, como los muestra la otra app (sin el 0x). */
export function addressGroupsOf(address: string): string[] {
  return getAddress(address).slice(2).match(/.{4}/g) ?? [];
}

/**
 * Copia en los 10 grupos de la comparación una dirección leída en la otra app: en el test, el dato del test (nunca lo
 * que muestra la pantalla de Recovery).
 */
export async function typeAddressGroups(page: Page, groups: readonly string[]): Promise<void> {
  for (const [i, group] of groups.entries()) {
    await page.getByLabel(`Grupo ${String(i + 1)} de 10`, { exact: true }).fill(group);
  }
}
