// Operaciones de U por la API real (lo que hace la app Wallet con la sesión OPERATIONS): preparar la baja de un destino
// y firmarla con U (firma de la SafeTx + sobre de envío firmado por la session key). Sirven para dejar operaciones
// pendientes —sin firmar, o firmadas y esperando un nonce anterior— que R anula desde Emergencia.
import { expect } from '@playwright/test';
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { newIdempotencyKey } from '../../../../src/api/client.ts';
import type { OperationStatus, PreparedOperation } from '../../../../src/api/recovery-api.ts';
import { signSubmission } from '../../../../src/api/submission.ts';
import { destinationWhitelistAbi } from '../../../../src/chain/abis/DestinationWhitelist.ts';
import { asSafe } from './chain.ts';
import type { ActiveWallet, Session } from './onboard.ts';
import { contract } from './stack.ts';

/** Destinos agregados por la propia Safe (estado on-chain de partida) y vistos por el indexer del backend. */
export async function whitelistBySafe(wallet: ActiveWallet, destinations: readonly Address[]): Promise<void> {
  for (const destination of destinations) {
    await asSafe(wallet.safe, {
      to: contract('DestinationWhitelist'),
      data: encodeFunctionData({ abi: destinationWhitelistAbi, functionName: 'addDestination', args: [destination] }),
    });
  }
  await expect
    .poll(
      async () => {
        const { entries } = await wallet.account.wallet.request<{ entries: { destination: Address }[] }>(
          'GET',
          `/wallets/${wallet.walletId}/whitelist`,
        );
        const known = new Set(entries.map((e) => getAddress(e.destination)));
        return destinations.every((d) => known.has(getAddress(d)));
      },
      { timeout: 120_000 },
    )
    .toBe(true);
}

/** U prepara la baja de un destino (queda CREATED con su nonce reservado). */
export function prepareRemoval(
  wallet: ActiveWallet,
  session: Session,
  destination: Address,
): Promise<PreparedOperation> {
  return wallet.account.wallet.request<PreparedOperation>(
    'POST',
    `/wallets/${wallet.walletId}/whitelist/${destination}/remove`,
    { platform: session.platform, idempotencyKey: newIdempotencyKey() },
  );
}

/** U firma una operación preparada: su firma de la SafeTx y el sobre de envío firmado por la session key. */
export async function signAsUser(wallet: ActiveWallet, session: Session, prepared: PreparedOperation): Promise<void> {
  const ownerSignature: Hex = await wallet.user.account.sign({ hash: prepared.safeTxHash });
  const envelope = await signSubmission(
    session.platform.key,
    { operationId: prepared.operationId, safeTxHash: prepared.safeTxHash, sessionId: session.platform.sessionId },
    wallet.account.wallet.clock.nowSeconds(),
  );
  await wallet.account.wallet.request('POST', `/operations/${prepared.operationId}/signatures`, {
    platform: session.platform,
    idempotencyKey: newIdempotencyKey(),
    body: { ownerRole: 'U', ownerSignature, ...envelope },
  });
}

export function operationStatus(wallet: ActiveWallet, operationId: string): Promise<OperationStatus> {
  return wallet.account.wallet.request<OperationStatus>('GET', `/operations/${operationId}`);
}
