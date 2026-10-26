// P22.T06: entrega real de email. Con el stack levantado con `--email mailgun` (scripts/test-e2e.mjs lo hace para este
// spec), el worker manda los emails por Mailgun con el dominio sandbox a la casilla autorizada (EMAIL_TEST_ADDRESS) y el
// test lee los códigos y el enlace con la Gmail API: crear la cuenta con esa casilla, verificarla con el código que llegó
// y recuperar la contraseña con el enlace que llegó. El dominio sandbox compartido a veces es rechazado por Gmail
// (alineación DMARC): ante una demora larga se pide otro envío, como haría el usuario. El resto del E2E usa Mailpit.
import { expect, test } from '@playwright/test';
import { codeIn, nextGmail, resetLinkIn, testAddress } from '../fixtures/gmail.ts';
import { ACCOUNT_PASSWORD } from '../fixtures/wallet/node-api.ts';
import { login } from '../fixtures/wallet/ui.ts';

test('crear la cuenta, verificar el email y recuperar la contraseña con emails entregados de verdad', async ({
  page,
}) => {
  test.setTimeout(1_800_000);
  const email = testAddress();
  const seen = new Set<string>();

  const registered = Date.now();
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Contraseña de cuenta', { exact: true }).fill(ACCOUNT_PASSWORD);
  await page.getByLabel('Repetir contraseña de cuenta').fill(ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page).toHaveURL(/\/verify-email$/);
  const verification = await nextGmail('Verificá tu email', registered, {
    seen,
    onWait: async () => {
      await page.getByRole('button', { name: 'Mandarme otro código' }).click();
    },
  });
  await page.getByLabel('Código de verificación').fill(codeIn(verification));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('button', { name: 'Salir' }).click();
  await expect(page).toHaveURL(/\/login$/);

  const requested = Date.now();
  const askForReset = async () => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Mandarme el enlace' }).click();
    await expect(page.getByText('Si la cuenta existe, te mandamos un enlace')).toBeVisible();
  };
  await askForReset();
  const reset = await nextGmail('Restablecé tu contraseña', requested, { seen, onWait: askForReset });
  const link = new URL(resetLinkIn(reset));
  await page.goto(`${link.pathname}${link.hash}`);
  await expect(page).toHaveURL(/\/reset-password$/);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  const newPassword = 'Contraseña nueva del email real 2026!';
  await page.getByLabel('Contraseña de cuenta nueva').fill(newPassword);
  await page.getByLabel('Repetir contraseña').fill(newPassword);
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByText('se cerraron todas las sesiones')).toBeVisible();
  await login(page, email, newPassword);
});
