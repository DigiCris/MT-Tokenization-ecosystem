// Challenges completados y ligados a una operación (P13; los crean los flujos de 2FA y de whitelist de P14): un
// HIGH_VALUE_TX por `two_factor_challenge_id` (ligado al SafeTxHash, la Safe y el destino) y un WHITELIST_ADD por el
// pedido de whitelist de la operación (ligado a la Safe y al destino), ambos ya consumidos por el usuario y con la
// atestación ChallengeCompletion guardada (la verifica el signer). Sin challenge válido el hecho queda en false.
import type { Kysely, Selectable } from 'kysely';
import { isAddressEqual, type Address } from 'viem';
import type { DecodedCall } from '../chain/decoders/safe-call.ts';
import type { Database, WalletOperationsTable } from '../db/schema.ts';
import { bufferToAddress, bufferToHex } from '../lib/bytes.ts';
import type { PolicyFacts } from '../policy/evaluate.ts';

type OperationRow = Selectable<WalletOperationsTable>;

export async function challengeFacts(
  db: Kysely<Database>,
  op: Pick<
    OperationRow,
    | 'id'
    | 'user_id'
    | 'safe_address'
    | 'safe_tx_hash'
    | 'requires_two_factor'
    | 'challenge_attestation'
    | 'two_factor_challenge_id'
  >,
  call: DecodedCall,
): Promise<Partial<PolicyFacts>> {
  const facts: Partial<PolicyFacts> = {};
  const bound = async (challengeId: string | null, type: 'HIGH_VALUE_TX' | 'WHITELIST_ADD', destination: Address) => {
    if (challengeId === null) return false;
    const row = await db
      .selectFrom('security_challenges')
      .select(['user_id', 'type', 'binding', 'consumed_at'])
      .where('id', '=', challengeId)
      .executeTakeFirst();
    const binding = (row?.binding ?? {}) as { safe?: string; destination?: string; safeTxHash?: string };
    return (
      row !== undefined &&
      row.user_id === op.user_id &&
      row.type === type &&
      row.consumed_at !== null &&
      typeof binding.destination === 'string' &&
      isAddressEqual(binding.destination as Address, destination) &&
      typeof binding.safe === 'string' &&
      isAddressEqual(binding.safe as Address, bufferToAddress(op.safe_address)) &&
      (type === 'WHITELIST_ADD' || binding.safeTxHash?.toLowerCase() === bufferToHex(op.safe_tx_hash))
    );
  };
  if (call.kind === 'ERC20_TRANSFER' && op.requires_two_factor) {
    facts.twoFactorVerified =
      op.challenge_attestation !== null && (await bound(op.two_factor_challenge_id, 'HIGH_VALUE_TX', call.recipient));
  }
  if (call.kind === 'WHITELIST_ADD') {
    const request = await db
      .selectFrom('whitelist_requests')
      .select('challenge_id')
      .where('operation_id', '=', op.id)
      .executeTakeFirst();
    facts.whitelistChallengeVerified =
      op.challenge_attestation !== null &&
      (await bound(request?.challenge_id ?? null, 'WHITELIST_ADD', call.destination));
  }
  return facts;
}
