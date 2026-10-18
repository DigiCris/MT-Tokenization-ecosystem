// P18.T02 contra los servicios reales y el fork: con R confirmada, la app calcula por su cuenta la dirección de la Safe
// (initializer + CREATE2 con las direcciones fijadas en su build) y la compara con la del backend, U firma la
// WalletCreationAuthorization, el gas tank despliega y la Safe se muestra operativa sólo tras la verificación propia por
// el RPC del frontend (V9 §16 y codehash de los contratos del sistema). Al desbloquear de nuevo, la app vuelve a
// verificar la Safe antes de mostrar el inicio.
import { expect, test } from '@playwright/test';
import { getAddress } from 'viem';
import { iSafeAbi } from '../../../src/chain/abis/ISafe.ts';
import { securityGuardAbi } from '../../../src/chain/abis/SecurityGuard.ts';
import { parseEnvelope } from '../../../src/crypto/envelope.ts';
import { confirmGroupsManually, onboardUpToRecovery } from './helpers/activation.ts';
import { chain } from './helpers/chain.ts';
import { submitRecovery } from './helpers/onboard.ts';
import { contract } from './helpers/operate.ts';
import { unlockWithFile } from './helpers/ui.ts';

test('crear la Safe: dirección propia, firma de U, deploy y verificación propia; re-verificación al desbloquear', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { account, envelopeJson, passwordWords, enrollment } = await onboardUpToRecovery(page, 'safe');
  const r = await submitRecovery(account, enrollment);
  await confirmGroupsManually(page, r.address);

  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  await page.getByRole('button', { name: 'Preparar la Safe' }).click();
  const summary = page.locator('[data-expected-safe]');
  await expect(summary).toBeVisible({ timeout: 60_000 });
  const expectedSafe = getAddress((await summary.getAttribute('data-expected-safe')) ?? '');
  await page.getByRole('button', { name: 'Firmar y crear la Safe' }).click();
  // El progreso pasa por el deploy y la verificación propia; al quedar ACTIVE la app muestra la Safe operativa.
  await expect(page.getByRole('heading', { name: 'Tu Safe está operativa' })).toBeVisible({ timeout: 300_000 });

  // La Safe que verificó la app es la que quedó en la cadena, con U, R y S en el Guard y como owners.
  const { wallet } = await account.api.myWallet();
  expect(wallet).toMatchObject({ status: 'ACTIVE', safe: expectedSafe });
  const envelope = parseEnvelope(JSON.parse(envelopeJson));
  const roles = await chain().readContract({
    address: contract('SecurityGuard'),
    abi: securityGuardAbi,
    functionName: 'rolesOf',
    args: [expectedSafe],
  });
  expect(getAddress(roles.userKey)).toBe(getAddress(envelope.keyAddress));
  expect(getAddress(roles.recoveryKey)).toBe(getAddress(r.address));
  const owners = await chain().readContract({ address: expectedSafe, abi: iSafeAbi, functionName: 'getOwners' });
  expect(owners.map((o) => getAddress(o)).sort()).toEqual(
    [roles.userKey, roles.recoveryKey, roles.executor].map((o) => getAddress(o)).sort(),
  );

  // Al desbloquear, la app re-verifica la Safe por su RPC antes de mostrar el inicio.
  await page.getByRole('link', { name: 'Ir al inicio' }).click();
  await expect(page.getByRole('link', { name: 'Desbloquear' })).toBeVisible();
  await unlockWithFile(page, envelopeJson, passwordWords);
  await expect(page.getByRole('heading', { name: 'Tu Safe' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`[data-address="${expectedSafe}"]`).first()).toBeVisible();
});
