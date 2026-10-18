// Onboarding por la UI hasta "Activar Recovery" (sin Drive, backup en archivo) y la confirmación manual de R con la
// dirección completa, para los specs de activación de Recovery y creación de la Safe.
import { expect, type Page } from '@playwright/test';
import type { Address, Hex } from 'viem';
import { addressGroups } from '../../../../src/recovery-activation/activation.ts';
import { verifiedAccount, type Account } from './onboard.ts';
import { backupToFile, completeStepUp, login, writeDownAndConfirmPassword } from './ui.ts';

export interface ToRecovery {
  account: Account;
  envelopeJson: string;
  passwordWords: string[];
  link: URL;
  enrollment: { enrollmentId: string; nonce: Hex };
}

export async function onboardUpToRecovery(page: Page, prefix: string): Promise<ToRecovery> {
  const account = await verifiedAccount(prefix);
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('button', { name: 'Seguir sin Drive' }).click();
  await completeStepUp(page, account.email);
  const passwordWords = await writeDownAndConfirmPassword(page);
  await page.getByRole('button', { name: 'Cifrar', exact: true }).click();
  const envelopeJson = await backupToFile(page);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activar Recovery' })).toBeVisible();
  const link = new URL((await page.locator('[data-recovery-link]').getAttribute('data-recovery-link')) ?? '');
  const fragment = new URLSearchParams(link.hash.slice(1));
  return {
    account,
    envelopeJson,
    passwordWords,
    link,
    enrollment: { enrollmentId: fragment.get('eid') ?? '', nonce: (fragment.get('n') ?? '0x') as Hex },
  };
}

/** Copia de la pantalla de Recovery los 10 grupos de la dirección (con uno cambiado si se pide) y confirma. */
export async function confirmGroupsManually(page: Page, recoveryKey: Address, wrongGroup?: number): Promise<void> {
  await expect(page.getByText('Recovery envió esta clave R:')).toBeVisible({ timeout: 60_000 });
  const groups = addressGroups(recoveryKey);
  const fields = page.getByLabel(/^Grupo \d+ de 10$/);
  await expect(fields).toHaveCount(10);
  for (const field of await fields.all()) {
    const index = Number((await field.getAttribute('name'))?.replace('group-', ''));
    const group = groups[index] ?? '';
    await field.fill(index === wrongGroup ? (group === '0000' ? '1111' : '0000') : group);
  }
  await page.getByRole('button', { name: 'Confirmar la clave R' }).click();
}
