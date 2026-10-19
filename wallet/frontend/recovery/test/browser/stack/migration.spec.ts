// P19.T10 contra los servicios reales y el fork, con una autorización de migración real y R como credencial sana: dos
// operadores abren y aprueban el caso (CLI con TOTP) → la wallet vieja queda MIGRATING; la Safe nueva del mismo usuario
// conserva R (con una U nueva, onboarding por la API); la Governance Safe del deploy (admin del PolicyRegistry,
// suplantado en Anvil) propone la autorización y, tras las 24 h, se activa. En `/migration` R (sobre de la wallet vieja)
// pide la preparación, la app verifica on-chain la Safe destino y arma el MIGRATION_TRANSFER del saldo completo; R lo
// firma y los fondos llegan a la Safe nueva.
import { expect, test } from '@playwright/test';
import { decodeEventLog, encodeFunctionData, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { policyRegistryAbi } from '../../../src/chain/abis/PolicyRegistry.ts';
import { anvil, fund, increaseTime, receipt, tokenBalance, USDC, USDC_HOLDER } from './helpers/chain.ts';
import { sealRecovery } from './helpers/envelope.ts';
import { activeWallet, finishOnboarding, onboardUntilEnrollment, submitRecoveryByApi } from './helpers/onboard.ts';
import { addOperator } from './helpers/operators.ts';
import { advanceRateLimitWindows, deployment } from './helpers/stack.ts';
import { settled, throughGate } from './helpers/ui.ts';

async function asAccount(from: Address, to: Address, data: Hex) {
  await anvil('anvil_setBalance', [from, `0x${(10n ** 18n).toString(16)}`]);
  await anvil('anvil_impersonateAccount', [from]);
  try {
    return await receipt(await anvil<Hex>('eth_sendTransaction', [{ from, to, data, gas: '0x7a1200' }]));
  } finally {
    await anvil('anvil_stopImpersonatingAccount', [from]);
  }
}

test('migración excepcional con credencial sana R: Safe destino verificada on-chain y transfer firmado por R', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const key = generatePrivateKey();
  const recovery = privateKeyToAccount(key);
  const old = await activeWallet('migrate-r', recovery);
  const sealed = await sealRecovery(recovery, key, old.walletId);
  await fund(USDC, USDC_HOLDER, old.safe, 25_000_000n);
  const [alice, bob] = await Promise.all([addOperator('mig-a'), addOperator('mig-b')]);
  const opened = (await alice.command([
    'migration:request',
    '--wallet',
    old.walletId,
    '--healthy',
    'R',
    '--reason',
    'credencial U comprometida: prueba de migración excepcional desde Recovery',
  ])) as { id: string };
  await bob.command(['migration:approve', '--case', opened.id]);

  // Safe nueva de la misma cuenta: U nueva y la misma R. La cuenta ya pidió códigos por email (alta, onboarding y
  // enrollment de la wallet vieja): se adelanta la ventana de rate limiting ([B-RL]).
  advanceRateLimitWindows();
  const next = await onboardUntilEnrollment(undefined, old.account);
  await submitRecoveryByApi(next, recovery);
  const fresh = await finishOnboarding(next, recovery);
  expect(fresh.walletId).not.toBe(old.walletId);

  const deploy = deployment() as ReturnType<typeof deployment> & { policy: { admin: Address } };
  const registry = deploy.contracts.PolicyRegistry?.address ?? '0x';
  const proposed = await asAccount(
    deploy.policy.admin,
    registry,
    encodeFunctionData({
      abi: policyRegistryAbi,
      functionName: 'proposeMigrationAuthorization',
      args: [old.safe, fresh.safe],
    }),
  );
  let changeId: Hex | null = null;
  for (const log of proposed.logs) {
    try {
      const event = decodeEventLog({ abi: policyRegistryAbi, data: log.data, topics: log.topics });
      if (event.eventName === 'ChangeProposed') changeId = event.args.id;
    } catch {
      // otro evento
    }
  }
  expect(changeId).not.toBeNull();
  await increaseTime(24 * 3600 + 60);
  const activated = await asAccount(
    USDC_HOLDER,
    registry,
    encodeFunctionData({ abi: policyRegistryAbi, functionName: 'activateChange', args: [changeId ?? '0x'] }),
  );
  expect(activated.status).toBe('success');

  advanceRateLimitWindows();
  await page.goto('/migration');
  await throughGate(page, old.account.email, sealed);
  await page.getByRole('button', { name: 'Preparar y verificar la migración' }).click();
  await expect(page.getByText('Safe destino verificada en Base:')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(`[data-address="${fresh.safe}"]`).first()).toBeVisible();
  await expect(page.getByText(/Enviar 25,00 USDC a 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave R' }).click();
  await expect(settled(page).or(page.getByText('Migración enviada: tus fondos están en la Safe nueva.'))).toBeVisible({
    timeout: 300_000,
  });
  await expect.poll(() => tokenBalance(USDC, fresh.safe), { timeout: 120_000 }).toBe(25_000_000n);
  expect(await tokenBalance(USDC, old.safe)).toBe(0n);
});
