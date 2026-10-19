// Onboarding por la UI hasta "Activar Recovery" (sin Drive, backup en archivo) y la confirmación manual de la dirección
// de R, para los specs de activación de Recovery y creación de la Safe. La dirección se tipea desde la fuente
// independiente —lo que muestra la app Recovery: la R que el test envió por el listener de Recovery—, nunca desde el DOM
// de la Wallet, que no la muestra hasta que coincide ([F-LNK-02]). El enlace de regreso se arma con el secreto `k` que
// la Wallet puso en el enlace de ida (ADR-033), como lo haría la app Recovery.
import { expect, type Page } from '@playwright/test';
import { getAddress, type Address, type Hex } from 'viem';
import { addressGroups } from '../../../../src/recovery-activation/activation.ts';
import { verifiedAccount, type Account } from './onboard.ts';
import { backupToFile, completeStepUp, login, writeDownAndConfirmPassword } from './ui.ts';

/** El pedido del enlace de ida a Recovery que muestra la Wallet: id, nonce y el secreto `k`. */
export interface RecoveryRequest {
  enrollmentId: string;
  nonce: Hex;
  secret: string;
}

export interface ToRecovery {
  account: Account;
  envelopeJson: string;
  passwordWords: string[];
  link: URL;
  enrollment: RecoveryRequest;
}

/** El pedido del enlace (o el QR) para la app Recovery que muestra la Wallet. */
export async function recoveryRequest(page: Page): Promise<RecoveryRequest & { link: URL }> {
  const link = new URL((await page.locator('[data-recovery-link]').getAttribute('data-recovery-link')) ?? '');
  const fragment = new URLSearchParams(link.hash.slice(1));
  return {
    link,
    enrollmentId: fragment.get('eid') ?? '',
    nonce: (fragment.get('n') ?? '0x') as Hex,
    secret: fragment.get('k') ?? '',
  };
}

/**
 * El enlace de regreso que arma la app Recovery para ese pedido: `eid`, la dirección de R y el mismo `k` del enlace de
 * ida (`secret: null` lo arma sin `k`, como uno falsificado por quien no lo conoce).
 */
export function returnLinkPath(request: RecoveryRequest, recoveryKey: Address, secret: string | null = request.secret) {
  const params = new URLSearchParams({ eid: request.enrollmentId, r: getAddress(recoveryKey) });
  if (secret !== null) params.set('k', secret);
  return `/onboarding/confirm-recovery#${params.toString()}`;
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
  const { link, ...enrollment } = await recoveryRequest(page);
  return { account, envelopeJson, passwordWords, link, enrollment };
}

/**
 * Espera la comparación manual (Recovery ya informó R) y comprueba que la Wallet no muestra la R que recibió la
 * plataforma, ni completa ni en grupos.
 */
export async function waitForManualConfirmation(page: Page, reported: Address): Promise<void> {
  await expect(page.getByRole('button', { name: 'Confirmar la dirección de R' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`[data-address="${getAddress(reported)}"]`)).toHaveCount(0);
  const html = (await page.content()).toLowerCase();
  expect(html).not.toContain(reported.slice(2).toLowerCase());
  const groups = addressGroups(reported).map((g) => g.toLowerCase());
  for (let i = 0; i + 1 < groups.length; i++) expect(html).not.toContain(`${groups[i] ?? ''} ${groups[i + 1] ?? ''}`);
}

/** Tipea en los 10 campos los grupos copiados de Recovery y confirma. */
export async function typeRecoveryGroups(page: Page, groups: readonly string[]): Promise<void> {
  const fields = page.getByLabel(/^Grupo \d+ de 10$/);
  await expect(fields).toHaveCount(10);
  for (const field of await fields.all()) {
    const index = Number((await field.getAttribute('name'))?.replace('group-', ''));
    await field.fill(groups[index] ?? '');
  }
  await page.getByRole('button', { name: 'Confirmar la dirección de R' }).click();
}

/**
 * Copia de la pantalla de Recovery los 10 grupos de la dirección (con uno cambiado si se pide) y confirma; si coincide,
 * la Wallet recién ahí muestra la dirección confirmada y se sigue con «Continuar».
 */
export async function confirmGroupsManually(page: Page, recoveryKey: Address, wrongGroup?: number): Promise<void> {
  await waitForManualConfirmation(page, recoveryKey);
  const groups = addressGroups(recoveryKey).map((group, i) =>
    i === wrongGroup ? (group === '0000' ? '1111' : '0000') : group,
  );
  await typeRecoveryGroups(page, groups);
  if (wrongGroup !== undefined) return;
  const confirmed = page.getByRole('status').filter({ hasText: 'Dirección de tu clave R (confirmada):' });
  await expect(confirmed.locator(`[data-address="${getAddress(recoveryKey)}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
}
