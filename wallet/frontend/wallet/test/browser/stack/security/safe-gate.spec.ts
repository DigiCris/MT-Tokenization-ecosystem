// P18.SEC / P18.T02: la verificación propia de la Safe es obligatoria e independiente del backend. Si un contrato del
// sistema ya no tiene el código fijado en el build (aquí, la whitelist con un byte inalcanzable agregado: mismo
// comportamiento, otro codehash; el backend no lo nota y sigue informando la wallet ACTIVE), la app no opera con esa
// Safe y dice qué ítem falló.
import { expect, test } from '@playwright/test';
import type { Hex } from 'viem';
import { serializeEnvelope } from '../../../../src/crypto/envelope.ts';
import { anvil } from '../helpers/chain.ts';
import { activeWallet } from '../helpers/onboard.ts';
import { whitelistContract } from '../helpers/operate.ts';
import { login, unlockWithFile } from '../helpers/ui.ts';

test('un contrato del sistema con otro codehash: la app no opera aunque el backend diga ACTIVE', async ({ page }) => {
  test.setTimeout(300_000);
  const wallet = await activeWallet('gate');
  const whitelist = whitelistContract();
  const original = await anvil<Hex>('eth_getCode', [whitelist, 'latest']);
  await anvil('anvil_setCode', [whitelist, `${original}00`]);
  try {
    await login(page, wallet.email, wallet.password);
    await unlockWithFile(page, serializeEnvelope(wallet.envelope), wallet.passwordWords);
    await expect(page.getByText('La verificación propia de tu Safe falló.')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('li[data-item="CODEHASH_WHITELIST"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tu Safe' })).toHaveCount(0);
    // Navegación dentro de la app (sin recargar: el desbloqueo vive sólo en memoria) a otra pantalla de operación, que
    // no tiene link visible con la Safe bloqueada: una entrada de historial con la forma que usa React Router.
    await page.evaluate(() => {
      const current = window.history.state as { idx?: number } | null;
      window.history.pushState({ usr: null, key: 'p18-gate', idx: (current?.idx ?? 0) + 1 }, '', '/send');
      window.dispatchEvent(new PopStateEvent('popstate', { state: { usr: null, key: 'p18-gate' } }));
    });
    await expect(page).toHaveURL(/\/send$/);
    await expect(page.getByText('La verificación propia de tu Safe falló.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revisar el envío' })).toHaveCount(0);
    const { wallet: reported } = await wallet.api.myWallet();
    expect(reported?.status).toBe('ACTIVE');
  } finally {
    await anvil('anvil_setCode', [whitelist, original]);
  }
});
