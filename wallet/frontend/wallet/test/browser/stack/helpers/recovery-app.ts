// La app Recovery real para los recorridos de Wallet (P17.MAN, segunda revisión): se compila contra el stack del test
// (API de Recovery, RPC del fork, contratos y clave de atestación del stack, la Wallet de la vista previa como
// WALLET_ORIGIN) y se sirve con `vite preview` en el RECOVERY_ORIGIN con el que se compiló la Wallet y que acepta el
// backend del stack (http://localhost:5174), como hace el simulacro de integridad. Después, el enrollment de R por sus
// pantallas: login con la misma cuenta, step-up con el código del email, R interna con su Password R (recordando o no
// el sobre cifrado en ese dispositivo), backups (archivo, QR y 17 palabras con su confirmación) y el envío, con capturas
// opcionales de cada pantalla. La pantalla final dice si el sobre quedó recordado.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, type Page } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { downloadedText } from './download.ts';
import { nextCode } from './mailpit.ts';
import { ACCOUNT_PASSWORD, RECOVERY_ORIGIN } from './node-api.ts';
import { stack, walletOrigin } from './stack.ts';

const RECOVERY_ROOT = resolve(import.meta.dirname, '../../../../../recovery');

function ok(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd: RECOVERY_ROOT, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr.slice(-800)}`);
}

export interface RecoveryApp {
  origin: string;
  stop: () => void;
}

/** Compila Recovery para el stack del test y la sirve en RECOVERY_ORIGIN hasta `stop()`. */
export async function serveRecoveryApp(): Promise<RecoveryApp> {
  const state = stack();
  const port = new URL(RECOVERY_ORIGIN).port;
  ok('pnpm', ['install', '--frozen-lockfile']);
  ok('node', ['scripts/sync-design-tokens.mjs']);
  ok('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], {
    ...process.env,
    MTW_ENV: 'ci',
    PLATFORM_ID: state.platformId,
    RECOVERY_API_BASE_URL: state.urls.apiRecovery,
    RECOVERY_FRONTEND_RPC_URL: state.urls.anvil,
    WALLET_ORIGIN: walletOrigin(),
    GOOGLE_CLIENT_ID_RECOVERY: 'mtw-browser-tests.apps.googleusercontent.com',
    GOOGLE_OAUTH_REDIRECT_URI_RECOVERY: `${RECOVERY_ORIGIN}/oauth/google/callback`,
    SIGNER_ATTESTATION_PUBLIC_KEY: state.signerAttestationPublicKey,
    MTW_DEPLOYMENT_FILE: state.deploymentFile,
  });
  // Vite directo con este Node (no por pnpm): así `stop()` termina el proceso que tiene el puerto.
  const child: ChildProcess = spawn(
    process.execPath,
    [resolve(RECOVERY_ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', port, '--strictPort'],
    { cwd: RECOVERY_ROOT, stdio: 'ignore' },
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await fetch(`${RECOVERY_ORIGIN}/`)
      .then((response) => response.ok)
      .catch(() => false);
    if (up) break;
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`la vista previa de Recovery no respondió en ${RECOVERY_ORIGIN}`);
    }
    await sleep(500);
  }
  return {
    origin: RECOVERY_ORIGIN,
    stop: () => {
      child.kill('SIGTERM');
    },
  };
}

export interface RecoveryEnrollment {
  /** Dirección de la R que Recovery envió (la que muestra su pantalla final, en grupos). */
  recoveryKey: Address;
  /** Enlace de regreso que arma Recovery (con el `k` del enlace de ida). */
  returnLink: URL;
}

/**
 * El enrollment de R por las pantallas de Recovery desde el enlace de ida de la Wallet: login (si hace falta), step-up
 * con el código real del email, R interna con su Password R, backups y envío. `snap` captura cada pantalla con el nombre
 * dado (prefijo `recovery-`). Con `remember: false` se desmarca «Recordar el sobre cifrado de R en este dispositivo»
 * (marcado por defecto) y la pantalla final tiene que decir que el sobre no quedó.
 */
export async function enrollInRecovery(
  recovery: Page,
  account: { email: string },
  enrollLink: URL,
  options: { snap?: (name: string) => Promise<void>; allBackups?: boolean; remember?: boolean } = {},
): Promise<RecoveryEnrollment> {
  const snap = async (name: string) => options.snap?.(`recovery-${name}`);
  const remember = options.remember ?? true;
  await recovery.goto(enrollLink.toString());
  const login = recovery.getByLabel('Contraseña de cuenta');
  const stepUp = recovery.getByRole('heading', { name: 'Verificá que sos vos' });
  // Con la verificación de esta wallet todavía vigente en la misma pestaña (15 min), Recovery no la vuelve a pedir y
  // pasa directo a cómo va a tener R (el botón sólo aparece con esa verificación).
  const createR = recovery.getByRole('button', { name: 'Crear una clave R en este navegador' });
  await expect(login.or(stepUp).or(createR)).toBeVisible({ timeout: 30_000 });
  // El pedido sale de la URL apenas se lee.
  expect(await recovery.evaluate(() => window.location.hash)).toBe('');
  if (await login.isVisible()) {
    await snap('enroll-login');
    await recovery.getByLabel('Email').fill(account.email);
    await recovery.getByLabel('Contraseña de cuenta').fill(ACCOUNT_PASSWORD);
    await recovery.getByRole('button', { name: 'Iniciar sesión' }).click();
    await expect(stepUp.or(createR)).toBeVisible();
  }
  if (await stepUp.isVisible()) {
    await snap('enroll');
    await recovery.getByRole('button', { name: 'Mandarme el código' }).click();
    await expect(recovery.getByLabel('Código del email')).toBeVisible();
    await snap('enroll-codigo');
    await recovery.getByLabel('Código del email').fill(await nextCode(account.email));
    await recovery.getByRole('button', { name: 'Confirmar' }).click();
    await expect(stepUp).toHaveCount(0, { timeout: 30_000 });
  } else {
    await snap('enroll-verificacion-vigente');
  }

  await expect(createR).toBeVisible();
  // A qué hora vence el pedido de la Wallet (se ve en todas las pantallas del enrollment).
  await expect(recovery.locator('[data-request-expires]')).toContainText(
    /Este pedido de la app Wallet vence a las \d{2}:\d{2}: enviá la dirección antes\./,
  );
  await expect(recovery.getByRole('heading', { name: '¿Cómo vas a tener tu clave R?' })).toBeVisible();
  await snap('como-tener-r');
  await recovery.getByRole('button', { name: 'Crear una clave R en este navegador' }).click();
  await snap('crear-r');
  await recovery.getByRole('button', { name: 'Generar mi clave R' }).click();
  const passwordList = recovery.getByRole('list', { name: 'Password R' }).locator('.words__word');
  await expect(passwordList).toHaveCount(5);
  const passwordWords = await passwordList.allTextContents();
  await snap('password-r');
  await recovery.getByLabel('Anoté las 5 palabras en orden y las guardo fuera de este dispositivo.').check();
  await recovery.getByRole('button', { name: 'Ya las anoté' }).click();
  await expect(recovery.getByRole('heading', { name: 'Confirmá tu Password R' })).toBeVisible();
  // En el paso de cifrado, recordar el sobre en este dispositivo viene marcado (como en la Wallet).
  // Texto exacto: Recovery deja un espacio antes del texto de sus casillas y una regex con «^» no las encuentra.
  const rememberBox = recovery.getByLabel(
    'Recordar el sobre cifrado de R en este dispositivo (nunca la clave ni la Password R). Si el dispositivo es compartido, desmarcalo.',
    { exact: true },
  );
  await expect(rememberBox).toBeChecked();
  await snap('confirmar-password-r');
  for (const field of await recovery.getByLabel(/^Palabra \d$/).all()) {
    const position = Number((await field.getAttribute('name'))?.replace('word-', ''));
    await field.fill(passwordWords[position] ?? '');
  }
  if (!remember) await rememberBox.uncheck();
  await recovery.getByRole('button', { name: 'Confirmar y cifrar' }).click();

  await expect(recovery.getByRole('heading', { name: 'Backups de tu clave R' })).toBeVisible({ timeout: 120_000 });
  await snap('backups');
  const downloading = recovery.waitForEvent('download');
  await recovery.getByRole('button', { name: 'Descargar el archivo cifrado' }).click();
  expect(JSON.parse(await downloadedText(await downloading))).toMatchObject({ role: 'R' });
  // Recovery deja un espacio antes del texto de sus casillas: el string exacto lo ignora; una expresión con ^ no.
  await recovery
    .getByLabel('Guardé el archivo fuera de este dispositivo (sin la Password R al lado).', { exact: true })
    .check();
  if (options.allBackups === true) {
    await recovery.getByRole('button', { name: 'Mostrar el QR' }).click();
    await expect(recovery.getByRole('img', { name: /^QR del sobre cifrado de R, parte 1 de/ })).toBeVisible();
    await snap('backup-qr');
    await recovery.getByLabel(/Guardé o imprimí (el QR|las \d+ partes del QR) fuera de este dispositivo/).check();
    await recovery.getByRole('button', { name: 'Mostrar las 17 palabras' }).click();
    const list = recovery.getByRole('list', { name: '17 palabras de tu clave R' });
    await expect(list.locator('.words__word')).toHaveCount(17);
    const words = await list.locator('.words__word').allTextContents();
    await snap('backup-17-palabras');
    await recovery.getByLabel(/Anoté las 17 palabras/).check();
    await recovery.getByRole('button', { name: 'Ya las anoté' }).click();
    const fields = recovery.getByLabel(/^Palabra \d+ de 17$/);
    await expect(fields).toHaveCount(3);
    await snap('backup-17-palabras-confirmar');
    for (const field of await fields.all()) {
      const position = Number((await field.getAttribute('name'))?.replace('backup-word-', ''));
      await field.fill(words[position] ?? '');
    }
    await recovery.getByRole('button', { name: 'Confirmar las palabras' }).click();
    await expect(recovery.getByText('Palabras anotadas y confirmadas.')).toBeVisible();
    await snap('backups-completos');
  }
  await recovery.getByRole('button', { name: 'Continuar' }).click();
  await expect(recovery.getByRole('button', { name: 'Firmar y enviar' })).toBeVisible();
  await snap('enviar');
  await recovery.getByRole('button', { name: 'Firmar y enviar' }).click();
  await expect(recovery.getByRole('heading', { name: 'Dirección de tu clave R enviada' })).toBeVisible({
    timeout: 60_000,
  });
  // Lo que dice de dónde queda R es cierto en cada caso (con el sobre recordado o sin él).
  await expect(recovery.locator(`[data-kept="${remember ? 'remembered' : 'not-remembered'}"]`)).toBeVisible();
  await expect(
    recovery.getByText(
      remember ? /Queda cifrada en este dispositivo/ : /Esta app no la guarda: se borra de este navegador/,
    ),
  ).toBeVisible();
  await snap('direccion-enviada');
  const recoveryKey = getAddress(
    (await recovery.locator('[data-recovery-key]').getAttribute('data-recovery-key')) ?? '',
  );
  const returnLink = new URL((await recovery.locator('[data-return-link]').getAttribute('data-return-link')) ?? '');
  return { recoveryKey, returnLink };
}
