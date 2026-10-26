// P18.SEC / P18.T01–T02 contra los servicios reales: una asignación de S adulterada en el camino (la respuesta del
// backend cambiada antes de llegar a la app) no se firma ni llega a incorporarse. Una dirección de Safe que no es la que
// calcula la app falla por la dirección y por el typed data; una S de otro (con la dirección, el config hash y el typed
// data recalculados para esa S, todo coherente) falla porque no la atestó el signer de la clave fijada en el build.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, type Address } from 'viem';
import type { ExecutorAssignment } from '../../../frontend/wallet/src/api/wallet-api.ts';
import { predictSafeAddress, safeInitializer } from '../../../frontend/wallet/src/safe/predict.ts';
import { confirmGroupsManually, onboardUpToRecovery } from '../../fixtures/wallet/activation.ts';
import { submitRecovery } from '../../fixtures/wallet/onboard.ts';
import { contract, randomAddress } from '../../fixtures/wallet/operate.ts';

const pinned = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../frontend/wallet/src/config/chain.base.json'), 'utf8'),
) as { contracts: Record<string, { address: Address }> };

async function readyToPrepare(page: Page, prefix: string): Promise<string[]> {
  const { account, enrollment } = await onboardUpToRecovery(page, prefix);
  const r = await submitRecovery(account, enrollment);
  await confirmGroupsManually(page, r.address);
  await expect(page.getByRole('heading', { name: 'Crear tu Safe' })).toBeVisible();
  const incorporated: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/incorporate')) incorporated.push(request.url());
  });
  return incorporated;
}

async function tamperAssignment(page: Page, change: (body: ExecutorAssignment) => void): Promise<void> {
  await page.route('**/api/v1/wallets/*/executor', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ExecutorAssignment;
    change(body);
    await route.fulfill({ response, json: body });
  });
}

test('otra dirección de Safe: no se firma ni se incorpora', async ({ page }) => {
  test.setTimeout(240_000);
  const incorporated = await readyToPrepare(page, 'tamper-safe');
  await tamperAssignment(page, (body) => {
    const forged = '0x000000000000000000000000000000000000dEaD';
    body.expectedSafe = forged;
    body.typedData.message.expectedSafe = forged;
  });
  await page.getByRole('button', { name: 'Preparar la Safe' }).click();
  await expect(page.getByText(/no puede confirmar \(EXPECTED_SAFE, TYPED_DATA_MESSAGE\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Firmar y crear la Safe' })).toHaveCount(0);
  expect(incorporated).toEqual([]);
});

test('una S que no atestó el signer fijado, aunque todo lo demás sea coherente: no se firma ni se incorpora', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const incorporated = await readyToPrepare(page, 'tamper-executor');
  await tamperAssignment(page, (body) => {
    const executor = randomAddress();
    const keys = { userKey: body.userKey, recoveryKey: body.recoveryKey, executor };
    const bootstrap = contract('SafeBootstrap');
    const expectedSafe = predictSafeAddress(keys, BigInt(body.saltNonce), {
      safeProxyFactory: pinned.contracts.safeProxyFactory?.address ?? '0x',
      safeSingleton: pinned.contracts.safeL2Singleton?.address ?? '0x',
      safeBootstrap: bootstrap,
    });
    body.executor = executor;
    body.expectedSafe = expectedSafe;
    body.configHash = keccak256(safeInitializer(keys, bootstrap));
    body.typedData.message.executor = executor;
    body.typedData.message.expectedSafe = expectedSafe;
  });
  await page.getByRole('button', { name: 'Preparar la Safe' }).click();
  await expect(page.getByText(/no puede confirmar \(EXECUTOR_ATTESTATION\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Firmar y crear la Safe' })).toHaveCount(0);
  expect(incorporated).toEqual([]);
});
