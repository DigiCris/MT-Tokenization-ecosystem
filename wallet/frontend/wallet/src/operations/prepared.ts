// Operaciones preparadas en el backend que U todavía no firmó (P18). Cada prepare reserva un nonce de la Safe mientras
// la operación sigue CREATED (15 min, [B-NONCE-01/02]). Si la verificación propia falla, si el usuario cancela el
// review o lo abandona y prepara otra cosa, la app la cancela en el backend (CREATED → CANCELLED) y el nonce queda
// libre; si no, la siguiente operación firmada esperaría un nonce menor que nadie va a firmar. Sólo se cancela lo que
// sigue CREATED: una operación ya firmada nunca se cancela desde acá (eso pide firmar una NoOp, otra decisión de U).
import type { PlatformAuth } from '../api/request-signature.ts';
import type { WalletApi } from '../api/wallet-api.ts';

type OperationsApi = Pick<WalletApi, 'operation' | 'cancelOperation'>;

interface Prepared {
  operationId: string;
}

/** Preparadas en esta pestaña y todavía sin la firma de U. */
const unsigned = new Set<string>();

export function trackPrepared(operations: readonly Prepared[]): void {
  for (const operation of operations) unsigned.add(operation.operationId);
}

export function markSigned(operationId: string): void {
  unsigned.delete(operationId);
}

export function unsignedOperations(): string[] {
  return [...unsigned];
}

/** Cancela en el backend las preparadas sin firmar (las indicadas o todas las de esta pestaña). */
export async function releasePrepared(
  api: OperationsApi,
  platform: PlatformAuth,
  operationIds: readonly string[] = unsignedOperations(),
): Promise<void> {
  await Promise.all(
    operationIds.map(async (operationId) => {
      unsigned.delete(operationId);
      try {
        const current = await api.operation(operationId);
        if (current.status === 'CREATED') await api.cancelOperation(platform, operationId);
      } catch {
        // Ya venció o se canceló (su nonce está libre), o el backend no responde: vence sola a los 15 min.
      }
    }),
  );
}

/** Verifica lo preparado contra lo que arma la app; si no coincide, lo cancela en el backend y propaga el error. */
export async function verifiedOrReleased<T>(
  api: OperationsApi,
  platform: PlatformAuth,
  prepared: readonly Prepared[],
  verify: () => T | Promise<T>,
): Promise<T> {
  trackPrepared(prepared);
  try {
    return await verify();
  } catch (error) {
    await releasePrepared(
      api,
      platform,
      prepared.map((operation) => operation.operationId),
    );
    throw error;
  }
}
