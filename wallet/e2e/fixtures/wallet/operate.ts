// Escenarios del camino asistido desde Node con el mismo código de la app (para preparar lo que un spec no prueba por
// la UI): desbloqueo con OPAQUE, SafeTx armada y verificada localmente contra la del backend, firma de U con el envelope
// de envío y espera del estado. Por ejemplo, un destino de la whitelist ya activo o un envío ya hecho para los specs de
// envío y actividad. También una propuesta de rotación por el camino soberano U + R (sin la plataforma).
import { encodeFunctionData, getAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { iSafeAbi } from '../../../frontend/wallet/src/chain/abis/ISafe.ts';
import { rotationTimelockAbi } from '../../../frontend/wallet/src/chain/abis/RotationTimelock.ts';
import { verifyPrepared } from '../../../frontend/wallet/src/chain/safe-tx.ts';
import { signAndSubmit, waitForOperation, SETTLED_STATES } from '../../../frontend/wallet/src/operations/sign.ts';
import { transferCall } from '../../../frontend/wallet/src/send/send.ts';
import { unlockWallet, type UnlockedWallet } from '../../../frontend/wallet/src/unlock/unlock.ts';
import { addDestinationCall } from '../../../frontend/wallet/src/whitelist/whitelist.ts';
import { accountSigner, chain, execSovereign, increaseTime, USDC, userSigner } from './chain.ts';
import { codeFrom, nextMail } from '../mailpit.ts';
import { nodeArgon2, type ActiveWallet } from './onboard.ts';
import { deployment } from '../stack.ts';

/** Dirección de un contrato del sistema en el deployment del stack. */
export function contract(name: string): Address {
  const address = deployment().contracts[name]?.address;
  if (!address) throw new Error(`el deployment del stack no tiene ${name}`);
  return address;
}

export function whitelistContract(): Address {
  return contract('DestinationWhitelist');
}

export function randomAddress(): Address {
  return getAddress(privateKeyToAccount(generatePrivateKey()).address);
}

/** Desbloqueo de la wallet desde Node (Argon2id nativo, OPAQUE real). */
export function unlockInNode(wallet: ActiveWallet): Promise<UnlockedWallet> {
  return unlockWallet(wallet.api, wallet.envelope, wallet.passwordWords.join(' '), nodeArgon2);
}

/** Destino agregado a la whitelist por el camino asistido y activo (la cadena adelantada 24 h). */
export async function activeDestination(wallet: ActiveWallet, label = 'Destino de prueba'): Promise<Address> {
  const unlocked = await unlockInNode(wallet);
  const destination = randomAddress();
  const request = await wallet.api.requestWhitelistDestination(unlocked.platform, wallet.wallet.id, {
    destination,
    label,
  });
  const code = codeFrom(
    await nextMail(
      wallet.email,
      (mail) => mail.text.includes(destination.slice(2, 6)) && /Código: \d{8}/.test(mail.text),
    ),
  );
  const { operation } = await wallet.api.confirmWhitelistRequest(unlocked.platform, request.id, code);
  const nonce = await chain().readContract({ address: wallet.wallet.safe, abi: iSafeAbi, functionName: 'nonce' });
  const verified = verifyPrepared(operation, {
    safe: wallet.wallet.safe,
    chainId: 8453,
    onchainNonce: nonce,
    build: (n) => addDestinationCall(whitelistContract(), destination, n),
  });
  await signAndSubmit(wallet.api, unlocked, verified);
  const status = await waitForOperation(wallet.api, operation.operationId, { timeoutMs: 240_000 });
  if (!SETTLED_STATES.includes(status.status)) throw new Error(`el alta del destino quedó ${status.status}`);
  // El label lo da el backend cuando su indexer ve el alta on-chain (unos segundos después de minada).
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { entries } = await wallet.api.whitelist(wallet.wallet.id);
    if (entries.some((e) => e.destination.toLowerCase() === destination.toLowerCase() && e.label === label)) break;
    if (Date.now() > deadline) throw new Error('el backend no registró el destino con su label');
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  await increaseTime(24 * 3600 + 60);
  await wallet.api.revokePlatformSession(unlocked.platform.sessionId).catch(() => undefined);
  return destination;
}

/** Envío de USDC por el camino asistido (prepare del backend verificado contra la SafeTx propia y firma de U). */
export async function sendFromNode(wallet: ActiveWallet, destination: Address, amount: bigint): Promise<void> {
  const unlocked = await unlockInNode(wallet);
  try {
    const operation = await wallet.api.prepareSend(unlocked.platform, wallet.wallet.id, {
      token: 'USDC',
      destination,
      amount: amount.toString(),
    });
    const nonce = await chain().readContract({ address: wallet.wallet.safe, abi: iSafeAbi, functionName: 'nonce' });
    const verified = verifyPrepared(operation, {
      safe: wallet.wallet.safe,
      chainId: 8453,
      onchainNonce: nonce,
      build: (n) => transferCall({ address: USDC }, destination, amount, n),
    });
    await signAndSubmit(wallet.api, unlocked, verified);
    const status = await waitForOperation(wallet.api, operation.operationId, { timeoutMs: 240_000 });
    if (!SETTLED_STATES.includes(status.status)) throw new Error(`el envío quedó ${status.status}`);
  } finally {
    await wallet.api.revokePlatformSession(unlocked.platform.sessionId).catch(() => undefined);
  }
}

/** RotationKind del RotationTimelock (contracts/src/libraries/Roles.sol). */
export const ROTATION_KIND = { U: 0, R: 1, S: 2 } as const;

/**
 * Propuesta de rotación de R hacia una dirección nueva, firmada por U y R y transmitida por un relayer cualquiera (el
 * camino soberano, sin la plataforma): queda pendiente en el timelock on-chain.
 */
export async function proposeRecoveryRotationSovereign(wallet: ActiveWallet): Promise<Address> {
  const newRecovery = randomAddress();
  const mined = await execSovereign(
    wallet.wallet.safe,
    {
      to: contract('RotationTimelock'),
      data: encodeFunctionData({
        abi: rotationTimelockAbi,
        functionName: 'propose',
        args: [ROTATION_KIND.R, getAddress(wallet.recovery.address), newRecovery],
      }),
    },
    [userSigner(wallet.userAddress, wallet.userKey), accountSigner(wallet.recovery)],
  );
  if (mined.status !== 'success') throw new Error('la propuesta soberana revirtió');
  return newRecovery;
}

/** El backend ya registró la propuesta on-chain de ese rol (su sync de eventos va unos segundos detrás de la cadena). */
export async function backendKnowsProposal(wallet: ActiveWallet, role: 'U' | 'R' | 'S'): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { items } = await wallet.api.listRotations(wallet.wallet.id);
    const known = items.some(
      (r) => r.role === role && r.proposalId !== null && ['PENDING_TIMELOCK', 'READY_TO_EXECUTE'].includes(r.status),
    );
    if (known) return;
    if (Date.now() > deadline) throw new Error(`el backend no registró la propuesta de ${role}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
}
