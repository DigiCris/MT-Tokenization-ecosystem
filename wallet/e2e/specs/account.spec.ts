// P17.T03: pantallas de cuenta contra el backend real (emails por el worker → Mailpit): registro, verificación del email,
// login (+TOTP y código de recuperación), logout, olvido y reset (token en el fragmento, limpiado de la URL), sesiones
// (listar y revocar) y configuración de TOTP. Texto explícito: la contraseña de cuenta no es la Password U.
import { expect, test } from '@playwright/test';
import { nextCode, nextMail, resetLinkFrom } from '../fixtures/mailpit.ts';
import { ACCOUNT_PASSWORD, uniqueEmail } from '../fixtures/wallet/node-api.ts';
import { verifiedAccount } from '../fixtures/wallet/onboard.ts';
import { freshTotp, totp } from '../fixtures/wallet/totp.ts';
import { login } from '../fixtures/wallet/ui.ts';

test('registro → código del email → sesión; logout y login; contraseña incorrecta', async ({ page }) => {
  const email = uniqueEmail('registro');
  await page.goto('/register');
  await expect(page.getByText('Esta contraseña NO es tu Password U.')).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Contraseña de cuenta', { exact: true }).fill(ACCOUNT_PASSWORD);
  await page.getByLabel('Repetir contraseña de cuenta').fill(ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email);
  await page.getByLabel('Código de verificación').fill(await nextCode(email));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: 'Crear tu wallet' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Cuenta' })).toContainText(email);

  await page.getByRole('button', { name: 'Salir' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Contraseña de cuenta', { exact: true }).fill('otra contraseña que no es');
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByRole('alert')).toContainText('Email o contraseña de cuenta incorrectos.');
  await page.getByLabel('Contraseña de cuenta', { exact: true }).fill(ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
});

test('olvido y reset: el token del enlace se usa y desaparece de la URL; la contraseña vieja deja de servir', async ({
  page,
}) => {
  const account = await verifiedAccount('reset');
  await page.goto('/forgot-password');
  await expect(page.getByText('No recupera tu Password U')).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByRole('button', { name: 'Mandarme el enlace' }).click();
  await expect(page.getByText('Si la cuenta existe, te mandamos un enlace')).toBeVisible();
  const link = new URL(resetLinkFrom(await nextMail(account.email, (m) => m.text.includes('#token='))));
  await page.goto(`${link.pathname}${link.hash}`);
  await expect(page).toHaveURL(/\/reset-password$/);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  const newPassword = 'Otra contraseña de cuenta 2026!';
  await page.getByLabel('Contraseña de cuenta nueva').fill(newPassword);
  await page.getByLabel('Repetir contraseña').fill(newPassword);
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByText('se cerraron todas las sesiones')).toBeVisible();
  // La sesión que tenía la cuenta (en Node) quedó revocada por el reset.
  await expect(account.api.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Contraseña de cuenta', { exact: true }).fill(ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrectos');
  await login(page, account.email, newPassword);
});

test('TOTP: activar con QR y clave, login con el código, códigos de recuperación de un uso y desactivar', async ({
  page,
}) => {
  const account = await verifiedAccount('totp');
  const used = new Set<string>();
  await login(page, account.email, account.password);
  await page.goto('/security/totp');
  await page.getByRole('button', { name: 'Configurar' }).click();
  await expect(page.getByRole('img', { name: 'Código QR para la app de autenticación' })).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').textContent()) ?? '';
  used.add(totp(secret));
  await page.getByLabel('Código de 6 dígitos').fill(totp(secret));
  await page.getByRole('button', { name: 'Activar' }).click();
  const codeItems = page.getByRole('list', { name: 'Códigos de recuperación' }).locator('li');
  await expect(codeItems).toHaveCount(10);
  const codes = await codeItems.allTextContents();

  await page.getByRole('button', { name: 'Salir' }).click();
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Contraseña de cuenta', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByLabel('Código de verificación en dos pasos')).toBeVisible();
  await page.getByLabel('Código de verificación en dos pasos').fill(await freshTotp(secret, used));
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.goto('/security/totp');
  await expect(page.getByText('La verificación en dos pasos está activa.')).toBeVisible();
  await page.getByLabel('Contraseña de cuenta').fill(account.password);
  await page.getByLabel('Código de la app o de recuperación').fill(codes[0]?.trim() ?? '');
  await page.getByRole('button', { name: 'Desactivar verificación en dos pasos' }).click();
  await expect(page.getByRole('button', { name: 'Configurar' })).toBeVisible();
});

test('sesiones: la actual marcada; cerrar las demás revoca la de otro dispositivo', async ({ page }) => {
  const account = await verifiedAccount('sesiones');
  await login(page, account.email, account.password);
  await page.goto('/security/sessions');
  const list = page.getByRole('list', { name: 'Sesiones' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByText('Esta sesión', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Cerrar todas las demás sesiones' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(account.api.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  await page.getByRole('button', { name: 'Cerrar esta sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
