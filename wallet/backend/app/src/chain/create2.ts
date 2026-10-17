// Dirección esperada de una Safe del sistema (cálculo local, P12.T04): el initializer es
// `Safe.setup([U, R, S], 2, SafeBootstrap, SafeBootstrap.bootstrap(U, R, S), 0, 0, 0, 0)` y la factory de Safe usa
// `salt = keccak256(keccak256(initializer) ‖ saltNonce)` con CREATE2 sobre el init code del proxy.
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { iSafeAbi, safeBootstrapAbi } from './abis/index.ts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const SAFE_THRESHOLD = 2n;

export interface WalletKeys {
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
}

export function safeInitializer(keys: WalletKeys, safeBootstrap: Address): Hex {
  const bootstrapCall = encodeFunctionData({
    abi: safeBootstrapAbi,
    functionName: 'bootstrap',
    args: [keys.userKey, keys.recoveryKey, keys.executor],
  });
  return encodeFunctionData({
    abi: iSafeAbi,
    functionName: 'setup',
    args: [
      [keys.userKey, keys.recoveryKey, keys.executor],
      SAFE_THRESHOLD,
      safeBootstrap,
      bootstrapCall,
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      0n,
      ZERO_ADDRESS,
    ],
  });
}

export function safeSalt(initializer: Hex, saltNonce: bigint): Hash {
  return keccak256(concat([keccak256(initializer), encodeAbiParameters([{ type: 'uint256' }], [saltNonce])]));
}

export function predictSafeAddress(params: {
  safeProxyFactory: Address;
  initCodeHash: Hash;
  initializer: Hex;
  saltNonce: bigint;
}): Address {
  return getContractAddress({
    opcode: 'CREATE2',
    from: params.safeProxyFactory,
    salt: safeSalt(params.initializer, params.saltNonce),
    bytecodeHash: params.initCodeHash,
  });
}
