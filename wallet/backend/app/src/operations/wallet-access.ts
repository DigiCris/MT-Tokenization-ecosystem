// Resolución de la wallet de un request crítico [B-AUTHZ]: la wallet tiene que ser del usuario de la sesión de cuenta
// (si no, 404: no se revela que existe), la PlatformSession tiene que estar atada a esa wallet y a su Safe, y la wallet
// tiene que estar ACTIVE (SOVEREIGN_MODIFIED tiene su propio error: la plataforma dejó de cooperar). La usan las
// operaciones (P13) y los flujos de whitelist, send y swap (P14).
import type { Kysely } from 'kysely';
import { isAddressEqual, type Address } from 'viem';
import { ApiError } from '../api/errors.ts';
import type { Database } from '../db/schema.ts';
import { bufferToAddress } from '../lib/bytes.ts';
import type { VerifiedPlatformSession } from '../platform-session/sessions.ts';

export interface ActorWallet {
  id: string;
  safe: Address;
  chainId: number;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function walletForActor(
  db: Kysely<Database>,
  actor: { userId: string; session: VerifiedPlatformSession },
  walletId: string,
): Promise<ActorWallet> {
  if (!isUuid(walletId)) throw new ApiError('NOT_FOUND');
  const wallet = await db
    .selectFrom('wallets')
    .select(['id', 'user_id', 'status', 'safe_address', 'chain_id'])
    .where('id', '=', walletId)
    .executeTakeFirst();
  if (wallet?.user_id !== actor.userId) throw new ApiError('NOT_FOUND');
  if (actor.session.claims.walletId !== wallet.id) {
    throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession es de otra wallet' });
  }
  if (wallet.status === 'SOVEREIGN_MODIFIED') throw new ApiError('SAFE_CONFIG_MODIFIED');
  if (wallet.status !== 'ACTIVE' || wallet.safe_address === null) throw new ApiError('WALLET_NOT_ACTIVE');
  const safe = bufferToAddress(wallet.safe_address);
  const claimed = actor.session.claims.safe;
  if (claimed === null || !isAddressEqual(claimed, safe)) {
    throw new ApiError('SCOPE_NOT_ALLOWED', { detail: 'la PlatformSession es de otra Safe' });
  }
  return { id: wallet.id, safe, chainId: wallet.chain_id };
}

/** Wallet del usuario para lecturas con la sesión de cuenta (sin PlatformSession): de otro usuario → 404. */
export async function walletOfUser(
  db: Kysely<Database>,
  userId: string,
  walletId: string,
): Promise<{ id: string; status: string; safe: Address | null; chainId: number }> {
  if (!isUuid(walletId)) throw new ApiError('NOT_FOUND');
  const wallet = await db
    .selectFrom('wallets')
    .select(['id', 'user_id', 'status', 'safe_address', 'chain_id'])
    .where('id', '=', walletId)
    .executeTakeFirst();
  if (wallet?.user_id !== userId) throw new ApiError('NOT_FOUND');
  return {
    id: wallet.id,
    status: wallet.status,
    safe: wallet.safe_address === null ? null : bufferToAddress(wallet.safe_address),
    chainId: wallet.chain_id,
  };
}
