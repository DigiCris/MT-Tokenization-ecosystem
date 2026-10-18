// P18.T11 contra los servicios reales y el fork, con una autorización de migración real: dos operadores abren y aprueban
// el caso (CLI con TOTP; credencial sana U) → wallet vieja MIGRATING; la Safe nueva del mismo usuario reutiliza U con
// una R nueva (onboarding por la API); la Governance Safe del deploy (admin del PolicyRegistry, impersonado en Anvil)
// propone la autorización y, tras las 24 h, se activa. En `/security/migration` U desbloquea la wallet vieja, la app
// verifica on-chain la Safe destino y arma el MIGRATION_TRANSFER del saldo completo; U lo firma y los fondos llegan.
import { expect, test } from '@playwright/test';
import { decodeEventLog, encodeFunctionData, type Address, type Hex } from 'viem';
import { policyRegistryAbi } from '../../../src/chain/abis/PolicyRegistry.ts';
import { serializeEnvelope } from '../../../src/crypto/envelope.ts';
import { anvil, fund, increaseTime, receipt, tokenBalance, USDC, USDC_HOLDER } from './helpers/chain.ts';
import { activeWallet, onboardWallet } from './helpers/onboard.ts';
import { addOperator } from './helpers/operators.ts';
import { advanceRateLimitWindows, deployment } from './helpers/stack.ts';
import { login } from './helpers/ui.ts';

async function asAccount(from: Address, to: Address, data: Hex) {
  await anvil('anvil_setBalance', [from, `0x${(10n ** 18n).toString(16)}`]);
  await anvil('anvil_impersonateAccount', [from]);
  try {
    return await receipt(await anvil<Hex>('eth_sendTransaction', [{ from, to, data, gas: '0x7a1200' }]));
  } finally {
    await anvil('anvil_stopImpersonatingAccount', [from]);
  }
}

test('migración excepcional con credencial sana U: Safe destino verificada on-chain y transfer firmado por U', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const old = await activeWallet('migrate');
  await fund(USDC, USDC_HOLDER, old.wallet.safe, 25_000_000n);
  const [alice, bob] = await Promise.all([addOperator('mig-a'), addOperator('mig-b')]);
  const opened = (await alice.command([
    'migration:request',
    '--wallet',
    old.wallet.id,
    '--healthy',
    'U',
    '--reason',
    'credencial R comprometida: prueba de migración excepcional desde Wallet',
  ])) as { id: string };
  await bob.command(['migration:approve', '--case', opened.id]);

  // Safe nueva: la misma U (Password U nueva para esa wallet) y una R nueva. La misma cuenta ya pidió dos códigos por
  // email (alta y enrollment de la wallet vieja) y pide otros dos: el límite es 3 cada 10 min por cuenta ([B-RL]), así
  // que se adelanta esa ventana (en la realidad, la migración ocurre mucho después del alta).
  advanceRateLimitWindows();
  const fresh = await onboardWallet(old, old.userKey);
  expect(fresh.wallet.id).not.toBe(old.wallet.id);

  // Autorización on-chain de la Governance Safe (24 h) y activación por cualquiera.
  const deploy = deployment() as ReturnType<typeof deployment> & { policy: { admin: Address } };
  const registry = deploy.contracts.PolicyRegistry?.address ?? '0x';
  const proposed = await asAccount(
    deploy.policy.admin,
    registry,
    encodeFunctionData({
      abi: policyRegistryAbi,
      functionName: 'proposeMigrationAuthorization',
      args: [old.wallet.safe, fresh.wallet.safe],
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

  await login(page, old.email, old.password);
  await page.goto('/security/migration');
  await page.getByRole('button', { name: 'Desde un archivo' }).click();
  await page.getByLabel(/Archivo del sobre cifrado/).setInputFiles({
    name: 'mtw-U-old.enc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeEnvelope(old.envelope)),
  });
  await page.getByLabel('Password U').fill(old.passwordWords.join(' '));
  await page.getByRole('button', { name: 'Desbloquear la wallet que se migra' }).click();
  await page.getByRole('button', { name: 'Preparar y verificar la migración' }).click();
  await expect(page.getByText('Safe destino verificada en Base:')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(`[data-address="${fresh.wallet.safe}"]`).first()).toBeVisible();
  await expect(page.getByText(/Enviar 25,00 USDC a 0x/)).toBeVisible();
  await page.getByRole('button', { name: 'Firmar con tu clave U' }).click();
  await expect(page.locator('[data-status="MINED"], [data-status="CONFIRMED"], [data-status="FINALIZED"]')).toBeVisible(
    {
      timeout: 300_000,
    },
  );
  expect(await tokenBalance(USDC, fresh.wallet.safe)).toBe(25_000_000n);
  expect(await tokenBalance(USDC, old.wallet.safe)).toBe(0n);
});
