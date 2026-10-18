// Mensajes EIP-712 de la plataforma que firma U ([W-01]): dominio "MTW Wallet" v1 en Base (8453) con la WalletFactory
// fijada del entorno como verifyingContract. Los mismos tipos verifican el backend y el signer (vectores en
// test/vectors/wire/eip712.json). `role` sigue el enum Role de los contratos: 1 = U, 2 = R, 3 = S.
import type { Address, Hex, TypedDataDefinition } from 'viem';

export const PLATFORM_DOMAIN_NAME = 'MTW Wallet';
export const BASE_CHAIN_ID = 8453;
export const KEY_ROLE = { U: 1, R: 2, S: 3 } as const;

export const PLATFORM_TYPES = {
  WalletCreationAuthorization: [
    { name: 'userId', type: 'string' },
    { name: 'platformId', type: 'string' },
    { name: 'walletId', type: 'string' },
    { name: 'userKey', type: 'address' },
    { name: 'recoveryKey', type: 'address' },
    { name: 'executor', type: 'address' },
    { name: 'saltNonce', type: 'uint256' },
    { name: 'expectedSafe', type: 'address' },
    { name: 'enrollmentNonce', type: 'bytes32' },
  ],
  KeyAcceptance: [
    { name: 'walletId', type: 'string' },
    { name: 'role', type: 'uint8' },
    { name: 'newKey', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
  ],
  KeyRestore: [
    { name: 'userId', type: 'string' },
    { name: 'walletId', type: 'string' },
    { name: 'keyAddress', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function platformDomain(walletFactory: Address) {
  return {
    name: PLATFORM_DOMAIN_NAME,
    version: '1',
    chainId: BASE_CHAIN_ID,
    verifyingContract: walletFactory,
  } as const;
}

export function walletCreationAuthorization(
  walletFactory: Address,
  message: {
    userId: string;
    platformId: string;
    walletId: string;
    userKey: Address;
    recoveryKey: Address;
    executor: Address;
    saltNonce: bigint;
    expectedSafe: Address;
    enrollmentNonce: Hex;
  },
): TypedDataDefinition<typeof PLATFORM_TYPES, 'WalletCreationAuthorization'> {
  return {
    domain: platformDomain(walletFactory),
    types: PLATFORM_TYPES,
    primaryType: 'WalletCreationAuthorization',
    message,
  };
}

/** La clave nueva acepta su rol en esa wallet (U' del flujo "perdí mi Password U"). */
export function keyAcceptance(
  walletFactory: Address,
  message: { walletId: string; role: keyof typeof KEY_ROLE; newKey: Address; nonce: Hex },
): TypedDataDefinition<typeof PLATFORM_TYPES, 'KeyAcceptance'> {
  return {
    domain: platformDomain(walletFactory),
    types: PLATFORM_TYPES,
    primaryType: 'KeyAcceptance',
    message: { ...message, role: KEY_ROLE[message.role] },
  };
}

/** Prueba de posesión de la U restaurada para el step-up KEY_RESTORE ([B-PSES-03]). */
export function keyRestore(
  walletFactory: Address,
  message: { userId: string; walletId: string; keyAddress: Address; nonce: Hex },
): TypedDataDefinition<typeof PLATFORM_TYPES, 'KeyRestore'> {
  return { domain: platformDomain(walletFactory), types: PLATFORM_TYPES, primaryType: 'KeyRestore', message };
}
