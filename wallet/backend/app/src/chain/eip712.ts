// Dominios y tipos EIP-712 de plataforma y del timelock [W-01] (chainId 8453). Los mismos tipos los implementan, por
// separado, el signer y ambos frontends; todos se validan contra contracts/test/vectors/wire/eip712.json.
import {
  concat,
  hashDomain,
  hashStruct,
  hashTypedData,
  keccak256,
  toBytes,
  type Address,
  type Hash,
  type Hex,
} from 'viem';

export const PLATFORM_DOMAIN_NAME = 'MTW Wallet';
export const TIMELOCK_DOMAIN_NAME = 'MTW RotationTimelock';
const DOMAIN_VERSION = '1';

const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

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
  RecoveryProofOfControl: [
    { name: 'userId', type: 'string' },
    { name: 'platformId', type: 'string' },
    { name: 'enrollmentId', type: 'string' },
    { name: 'recoveryKey', type: 'address' },
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

export const TIMELOCK_TYPES = {
  CancelRotation: [
    { name: 'proposalId', type: 'bytes32' },
    { name: 'safe', type: 'address' },
  ],
} as const;

export type PlatformPrimaryType = keyof typeof PLATFORM_TYPES;

export interface PlatformMessages {
  WalletCreationAuthorization: {
    userId: string;
    platformId: string;
    walletId: string;
    userKey: Address;
    recoveryKey: Address;
    executor: Address;
    saltNonce: bigint;
    expectedSafe: Address;
    enrollmentNonce: Hex;
  };
  RecoveryProofOfControl: { userId: string; platformId: string; enrollmentId: string; recoveryKey: Address };
  KeyAcceptance: { walletId: string; role: number; newKey: Address; nonce: Hex };
  KeyRestore: { userId: string; walletId: string; keyAddress: Address; nonce: Hex };
}

export function platformDomain(chainId: number, walletFactory: Address) {
  return { name: PLATFORM_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: walletFactory } as const;
}

export function timelockDomain(chainId: number, rotationTimelock: Address) {
  return { name: TIMELOCK_DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: rotationTimelock } as const;
}

export function domainSeparator(domain: ReturnType<typeof platformDomain> | ReturnType<typeof timelockDomain>): Hash {
  return hashDomain({ domain: { ...domain, chainId: BigInt(domain.chainId) }, types: { EIP712Domain: EIP712_DOMAIN } });
}

/** Typehash de un tipo de plataforma (`keccak256("Tipo(campos)")`). */
export function typeHash(primaryType: PlatformPrimaryType | 'CancelRotation'): Hash {
  const fields = primaryType === 'CancelRotation' ? TIMELOCK_TYPES.CancelRotation : PLATFORM_TYPES[primaryType];
  return keccak256(toBytes(`${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`));
}

export function platformTypedData<T extends PlatformPrimaryType>(
  chainId: number,
  walletFactory: Address,
  primaryType: T,
  message: PlatformMessages[T],
) {
  return { domain: platformDomain(chainId, walletFactory), types: PLATFORM_TYPES, primaryType, message };
}

export function platformStructHash<T extends PlatformPrimaryType>(primaryType: T, message: PlatformMessages[T]): Hash {
  // El tipo genérico de viem no se resuelve con un primaryType genérico: el contenido lo validan los vectores [W-01].
  const parameters: unknown = { data: message, primaryType, types: PLATFORM_TYPES };
  return hashStruct(parameters as Parameters<typeof hashStruct>[0]);
}

export function platformDigest<T extends PlatformPrimaryType>(
  chainId: number,
  walletFactory: Address,
  primaryType: T,
  message: PlatformMessages[T],
): Hash {
  // EIP-712: keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message)).
  return keccak256(
    concat([
      '0x1901',
      domainSeparator(platformDomain(chainId, walletFactory)),
      platformStructHash(primaryType, message),
    ]),
  );
}

export function cancelRotationDigest(chainId: number, rotationTimelock: Address, proposalId: Hex, safe: Address): Hash {
  return hashTypedData({
    domain: timelockDomain(chainId, rotationTimelock),
    types: TIMELOCK_TYPES,
    primaryType: 'CancelRotation',
    message: { proposalId, safe },
  });
}
