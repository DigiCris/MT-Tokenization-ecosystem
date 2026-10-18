// Hechos de la policy de una rotación (P15, [B-POL-03], [B-SIG-02]) a partir de su pedido (`rotation_requests`):
// - U' o R': la KeyAcceptance [W-01] (EIP-712 de la plataforma, firmada por la clave NUEVA) es válida para esta
//   wallet, este rol y esta clave;
// - S': la clave nueva la creó un signer para esta wallet (fila de `signer_keys` con su SignerKeyAttestation).
// El signer vuelve a verificar ambas cosas por su cuenta (con la clave de atestación fijada para S').
import type { Kysely, Selectable } from 'kysely';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { RotationKind } from '../chain/constants.ts';
import type { DecodedCall } from '../chain/decoders/safe-call.ts';
import { platformDigest } from '../chain/eip712.ts';
import { InvalidSignatureError, recoverStrictSigner } from '../chain/signatures.ts';
import type { Database, RotationRequestsTable, WalletOperationsTable } from '../db/schema.ts';
import { addressToBuffer, bufferToAddress } from '../lib/bytes.ts';
import type { PolicyFacts } from '../policy/evaluate.ts';
import type { BackendPolicySnapshot } from '../policy/snapshot.ts';

type RotationRow = Selectable<RotationRequestsTable>;

/** `role` de KeyAcceptance (enum Role de los contratos, igual que el signer). */
export const KEY_ACCEPTANCE_ROLE = { U: 1, R: 2 } as const;

export async function keyAcceptanceValid(
  snapshot: BackendPolicySnapshot,
  input: { walletId: string; role: 'U' | 'R'; newKey: Address; nonce: Hex; signature: Hex },
): Promise<boolean> {
  const digest = platformDigest(snapshot.chainId, snapshot.contracts.walletFactory, 'KeyAcceptance', {
    walletId: input.walletId,
    role: KEY_ACCEPTANCE_ROLE[input.role],
    newKey: input.newKey,
    nonce: input.nonce,
  });
  try {
    return isAddressEqual(await recoverStrictSigner(digest, input.signature), input.newKey);
  } catch (error) {
    if (error instanceof InvalidSignatureError) return false;
    throw error;
  }
}

/** Pedido de rotación de una operación (de propuesta o de ejecución). */
export async function rotationOfOperation(db: Kysely<Database>, operationId: string): Promise<RotationRow | undefined> {
  return db
    .selectFrom('rotation_requests')
    .selectAll()
    .where((eb) => eb.or([eb('propose_operation_id', '=', operationId), eb('execute_operation_id', '=', operationId)]))
    .executeTakeFirst();
}

/** La clave nueva de S fue creada por un signer para esta wallet (y atestada). */
export async function isSignerKeyOf(db: Kysely<Database>, walletId: string, key: Address): Promise<boolean> {
  const row = await db
    .selectFrom('signer_keys')
    .select(['status', 'attestation'])
    .where('wallet_id', '=', walletId)
    .where('address', '=', addressToBuffer(key))
    .where('status', 'in', ['PENDING', 'ACTIVE'])
    .executeTakeFirst();
  return row !== undefined && row.attestation !== null;
}

const ROLE_OF_KIND: Readonly<Record<number, 'U' | 'R' | 'S' | undefined>> = {
  [RotationKind.User]: 'U',
  [RotationKind.Recovery]: 'R',
  [RotationKind.Executor]: 'S',
};

/**
 * Hechos de rotación de una operación ya guardada (envío de la firma y paso 6 del worker): la clave nueva y su
 * material salen del pedido de rotación ligado a la operación, nunca de lo que mande el cliente.
 */
export async function rotationFacts(
  db: Kysely<Database>,
  snapshot: BackendPolicySnapshot,
  op: Pick<Selectable<WalletOperationsTable>, 'id' | 'wallet_id'>,
  call: DecodedCall,
): Promise<Partial<PolicyFacts>> {
  let role: 'U' | 'R' | 'S' | undefined;
  let newKey: Address;
  if (call.kind === 'ROTATION_PROPOSE') {
    role = ROLE_OF_KIND[call.rotationKind];
    newKey = call.newValue;
  } else if (call.kind === 'SWAP_OWNER') {
    newKey = call.newOwner;
  } else {
    return {};
  }
  const rotation = await rotationOfOperation(db, op.id);
  if (!rotation || !isAddressEqual(bufferToAddress(rotation.new_key), newKey)) {
    return { keyAcceptanceValid: false, newKeyIsSignerKey: false };
  }
  role ??= rotation.role === 'U' || rotation.role === 'R' || rotation.role === 'S' ? rotation.role : undefined;
  if (role === 'S') return { newKeyIsSignerKey: await isSignerKeyOf(db, op.wallet_id, newKey) };
  if (role === 'U' || role === 'R') {
    const ka = rotation.key_acceptance;
    if (!ka) return { keyAcceptanceValid: false };
    return {
      keyAcceptanceValid: await keyAcceptanceValid(snapshot, {
        walletId: op.wallet_id,
        role,
        newKey,
        nonce: ka.nonce as Hex,
        signature: ka.signature as Hex,
      }),
    };
  }
  return {};
}

/** Material de la clave nueva que el worker le manda al signer ([B-SIG-02]). */
export async function rotationSignerFields(
  db: Kysely<Database>,
  operationId: string,
): Promise<Record<string, unknown>> {
  const rotation = await rotationOfOperation(db, operationId);
  if (!rotation) return {};
  const newKey = bufferToAddress(rotation.new_key);
  if ((rotation.role === 'U' || rotation.role === 'R') && rotation.key_acceptance) {
    return {
      keyAcceptance: {
        walletId: rotation.wallet_id,
        role: KEY_ACCEPTANCE_ROLE[rotation.role],
        newKey,
        nonce: rotation.key_acceptance.nonce,
        signature: rotation.key_acceptance.signature,
      },
    };
  }
  if (rotation.role === 'S' && rotation.new_key_attestation) return { newKeyAttestation: rotation.new_key_attestation };
  return {};
}
