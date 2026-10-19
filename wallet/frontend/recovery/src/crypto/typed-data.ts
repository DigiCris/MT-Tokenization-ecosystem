// Typed data EIP-712 que firma R ([F-CON-03]: sólo `eth_signTypedData_v4`, nunca `personal_sign`), con el dominio de
// la plataforma (`MTW Wallet`, verifyingContract = WalletFactory) o el del RotationTimelock para cancelar. La misma
// estructura sirve para R interna (hash con viem y firma local) y para una wallet externa (se le pasa el objeto).
import { hashTypedData, type Address, type Hex, type TypedDataDefinition } from 'viem';

export const BASE_CHAIN_ID = 8453;

/** Rol en los contratos (enum Role): 1 = U, 2 = R, 3 = S. */
export const ROLE = { U: 1, R: 2, S: 3 } as const;

export function platformDomain(walletFactory: Address) {
  return { name: 'MTW Wallet', version: '1', chainId: BASE_CHAIN_ID, verifyingContract: walletFactory } as const;
}

export const RECOVERY_PROOF_TYPES = {
  RecoveryProofOfControl: [
    { name: 'userId', type: 'string' },
    { name: 'platformId', type: 'string' },
    { name: 'enrollmentId', type: 'string' },
    { name: 'recoveryKey', type: 'address' },
  ],
} as const;

export const KEY_ACCEPTANCE_TYPES = {
  KeyAcceptance: [
    { name: 'walletId', type: 'string' },
    { name: 'role', type: 'uint8' },
    { name: 'newKey', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export const CANCEL_ROTATION_TYPES = {
  CancelRotation: [
    { name: 'proposalId', type: 'bytes32' },
    { name: 'safe', type: 'address' },
  ],
} as const;

/** Prueba de control de R para el enrollment (la firma R; recupera exactamente R). */
export function recoveryProofOfControl(
  walletFactory: Address,
  message: { userId: string; platformId: string; enrollmentId: string; recoveryKey: Address },
): TypedDataDefinition<typeof RECOVERY_PROOF_TYPES, 'RecoveryProofOfControl'> {
  return {
    domain: platformDomain(walletFactory),
    types: RECOVERY_PROOF_TYPES,
    primaryType: 'RecoveryProofOfControl',
    message,
  };
}

/** Aceptación de la clave nueva R′ de un reemplazo (la firma R′ con el nonce del enrollment). */
export function keyAcceptance(
  walletFactory: Address,
  message: { walletId: string; newKey: Address; nonce: Hex },
): TypedDataDefinition<typeof KEY_ACCEPTANCE_TYPES, 'KeyAcceptance'> {
  return {
    domain: platformDomain(walletFactory),
    types: KEY_ACCEPTANCE_TYPES,
    primaryType: 'KeyAcceptance',
    message: { walletId: message.walletId, role: ROLE.R, newKey: message.newKey, nonce: message.nonce },
  };
}

/** Cancelación individual de una propuesta del timelock (`cancelWithSignature`). */
export function cancelRotation(
  timelock: Address,
  message: { proposalId: Hex; safe: Address },
): TypedDataDefinition<typeof CANCEL_ROTATION_TYPES, 'CancelRotation'> {
  return {
    domain: { name: 'MTW RotationTimelock', version: '1', chainId: BASE_CHAIN_ID, verifyingContract: timelock },
    types: CANCEL_ROTATION_TYPES,
    primaryType: 'CancelRotation',
    message,
  };
}

export function typedDataDigest(definition: TypedDataDefinition): Hex {
  return hashTypedData(definition);
}
