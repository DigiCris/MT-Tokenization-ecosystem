// Flujo del modo soberano en Recovery (P19.T06), sin el backend: la Safe se lee por el RPC propio (owners, nonce, roles
// del Guard y la verificación del sistema, que acá sólo avisa: en modo soberano la Safe puede haber dejado la
// configuración asistida), cada acción tipada se arma con el nonce on-chain, R firma el hash que calcula la app y el
// documento se completa con la firma de U que vuelve de la Wallet. Antes de transmitir: firmas de U y R de dos owners
// vigentes distintos y el nonce de la SafeTx igual al de la Safe.
import { erc20Abi, isAddressEqual, recoverAddress, zeroAddress, type Address, type Hex } from 'viem';
import type { TokenSymbol } from '../api/recovery-api.ts';
import { parseAddressInput } from '../chain/address.ts';
import type { ChainReader } from '../chain/client.ts';
import { safeNonce, safeOwners, type SafeRoles } from '../chain/rotations.ts';
import { checkSafe } from '../chain/safe-check.ts';
import { MAX_QUEUED_NONCES } from '../chain/safe-tx.ts';
import type { PinnedChain } from '../config/chain.ts';
import type { SystemContracts } from '../config/system-contracts.ts';
import { strictSignature } from '../enroll/enrollment.ts';
import { signSafeTx, type RecoverySigner } from '../signer/recovery-signer.ts';
import { noop, replaceExecutor, setGuard, transferAll, updateRoles, type TypedSafeTx } from './actions.ts';
import {
  execTransactionData,
  newDocument,
  toSafeTx,
  verifySignatures,
  withSignature,
  type SovereignDocument,
} from './document.ts';

type Pinned = { system: SystemContracts; chain: PinnedChain };
type Reader = Pick<ChainReader, 'getCode' | 'getStorageAt' | 'readContract'>;

export class SovereignFlowError extends Error {
  override name = 'SovereignFlowError';
}

export interface SovereignSafe {
  safe: Address;
  owners: Address[];
  nonce: bigint;
  /** Roles del Guard del sistema para esta Safe (null si el Guard ya no la tiene registrada). */
  roles: SafeRoles | null;
  /** Ítems de la verificación del sistema que no coinciden: avisos, no bloquean el modo soberano. */
  warnings: string[];
}

/** Lee la Safe por el RPC propio. Falla si la dirección no es una Safe con owners. */
export async function readSovereignSafe(reader: Reader, pinned: Pinned, safe: Address): Promise<SovereignSafe> {
  const checked = await checkSafe(reader, pinned, safe);
  if (checked.failures.includes('SAFE_PROXY_CODEHASH')) {
    throw new SovereignFlowError('Esa dirección no es una Safe v1.5.0 en Base.');
  }
  const [owners, nonce] = await Promise.all([safeOwners(reader, safe), safeNonce(reader, safe)]);
  const roles = checked.failures.includes('NOT_REGISTERED') ? null : checked.roles;
  return { safe: checked.safe, owners, nonce, roles, warnings: checked.failures };
}

export function isOwner(state: Pick<SovereignSafe, 'owners'>, key: Address): boolean {
  return state.owners.some((owner) => isAddressEqual(owner, key));
}

export type ActionInput =
  | { type: 'TRANSFER'; token: TokenSymbol; destination: string }
  | { type: 'EXECUTOR_REPLACEMENT'; newExecutor: string }
  | { type: 'SET_GUARD' | 'SET_MODULE_GUARD'; guard: string; remove: boolean }
  | { type: 'UPDATE_ROLES'; userKey: string; recoveryKey: string; executor: string }
  | { type: 'NOOP'; nonce: string };

/** Arma la(s) SafeTx de la acción con el nonce on-chain (la transferencia, con el saldo leído de la cadena). */
export async function buildActions(
  reader: Pick<ChainReader, 'readContract'>,
  pinned: Pinned,
  state: SovereignSafe,
  input: ActionInput,
): Promise<TypedSafeTx[]> {
  const { safe, nonce } = state;
  switch (input.type) {
    case 'TRANSFER': {
      const token = pinned.chain.tokens[input.token];
      const destination = parseAddressInput(input.destination);
      if (isAddressEqual(destination, safe)) throw new SovereignFlowError('El destino no puede ser la misma Safe.');
      const balance = await reader.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [safe],
      });
      return [transferAll(token, destination, balance, nonce)];
    }
    case 'EXECUTOR_REPLACEMENT': {
      if (state.roles === null) {
        throw new SovereignFlowError(
          'El Guard no tiene los roles de esta Safe: sin ellos no se arma el reemplazo de S.',
        );
      }
      const next = parseAddressInput(input.newExecutor);
      return replaceExecutor(safe, pinned.system.contracts.guard.address, state.roles, state.owners, next, nonce);
    }
    case 'SET_GUARD':
    case 'SET_MODULE_GUARD': {
      const guard = input.remove ? zeroAddress : parseAddressInput(input.guard);
      return [setGuard(safe, input.type === 'SET_GUARD' ? 'GUARD' : 'MODULE_GUARD', guard, nonce)];
    }
    case 'UPDATE_ROLES': {
      const roles = {
        userKey: parseAddressInput(input.userKey),
        recoveryKey: parseAddressInput(input.recoveryKey),
        executor: parseAddressInput(input.executor),
      };
      for (const key of Object.values(roles)) {
        if (!isOwner(state, key))
          throw new SovereignFlowError(`${key} no es owner de la Safe: los roles tienen que serlo.`);
      }
      return [updateRoles(pinned.system.contracts.guard.address, roles, nonce)];
    }
    case 'NOOP': {
      if (!/^\d{1,20}$/.test(input.nonce.trim())) throw new SovereignFlowError('El nonce es un número entero.');
      const target = BigInt(input.nonce.trim());
      if (target < nonce || target >= nonce + MAX_QUEUED_NONCES) {
        throw new SovereignFlowError(
          `El nonce tiene que estar entre ${nonce.toString()} (el actual de la Safe) y ${(nonce + MAX_QUEUED_NONCES - 1n).toString()}.`,
        );
      }
      return [noop(safe, target)];
    }
  }
}

export function documentsFor(safe: Address, actions: readonly TypedSafeTx[], now: Date): SovereignDocument[] {
  return actions.map((action) => newDocument(safe, action.tx, action.action, now));
}

/** R firma el hash de la SafeTx que calcula la app; la firma tiene que recuperar a R y queda en formato estricto. */
export async function signWithRecovery(doc: SovereignDocument, signer: RecoverySigner): Promise<SovereignDocument> {
  const signature = strictSignature(await signSafeTx(signer, 8453, doc.safe, toSafeTx(doc)));
  const recovered = await recoverAddress({ hash: doc.safeTxHash, signature });
  if (!isAddressEqual(recovered, signer.address)) throw new SovereignFlowError('La firma no es de tu clave R.');
  return withSignature(doc, { signer: signer.address, role: 'R', signature });
}

export type Readiness = { ready: true; data: Hex } | { ready: false; reason: string };

/** ¿Se puede transmitir ya? Firmas válidas de U y R, de dos owners vigentes distintos, y el nonce que sigue. */
export async function executionReadiness(
  doc: SovereignDocument,
  state: Pick<SovereignSafe, 'owners' | 'nonce'>,
): Promise<Readiness> {
  await verifySignatures(doc);
  const user = doc.signatures.find((s) => s.role === 'U');
  const recovery = doc.signatures.find((s) => s.role === 'R');
  if (!recovery) return { ready: false, reason: 'Falta la firma de R.' };
  if (!user) return { ready: false, reason: 'Falta la firma de U: exportá el documento y firmalo en la app Wallet.' };
  if (isAddressEqual(user.signer, recovery.signer)) return { ready: false, reason: 'U y R son la misma clave.' };
  for (const entry of [user, recovery]) {
    if (!isOwner(state, entry.signer)) {
      return { ready: false, reason: `La clave ${entry.role} que firmó ya no es owner de la Safe.` };
    }
  }
  const nonce = BigInt(doc.safeTx.nonce);
  if (nonce < state.nonce) return { ready: false, reason: 'Ese nonce ya se usó: la operación no se puede ejecutar.' };
  if (nonce > state.nonce) {
    return {
      ready: false,
      reason: `Antes tiene que ejecutarse la operación con nonce ${state.nonce.toString()} (esta usa el ${nonce.toString()}).`,
    };
  }
  return { ready: true, data: execTransactionData(doc) };
}

/** Archivo con la calldata para cualquier relayer: `execTransaction` a la Safe, sin valor. */
export function calldataFile(doc: SovereignDocument, data: Hex): string {
  return `${JSON.stringify(
    { chainId: 8453, to: doc.safe, value: '0', data, safeTxHash: doc.safeTxHash, action: doc.action },
    null,
    2,
  )}\n`;
}
