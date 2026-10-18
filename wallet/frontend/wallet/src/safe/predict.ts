// Dirección esperada de la Safe calculada por la app (P18.T02, [C-FAC-03], V9 §16), sin preguntarle a nadie: initializer
// `Safe.setup([U, R, S], 2, SafeBootstrap, SafeBootstrap.bootstrap(U, R, S), 0, 0, 0, 0)`, `saltNonce =
// uint256(keccak256(abi.encode("MTW_SALT_V1", platformId, walletId)))` y CREATE2 de la SafeProxyFactory fijada sobre el
// init code del proxy (creation code propio, cuyo keccak256 es el `proxyCreationCodeHash` fijado, más la singleton
// SafeL2). Usa sólo direcciones propias (chain.base.json y los contratos del sistema del build): la Safe que informe el
// backend se compara contra esta.
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
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { safeBootstrapAbi } from '../chain/abis/SafeBootstrap.ts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const SAFE_THRESHOLD = 2n;

/** Creation code del proxy de Safe 1.5.0 (`SafeProxyFactory.proxyCreationCode()` del deployment canónico de Base). */
export const SAFE_PROXY_CREATION_CODE: Hex = `0x${[
  '608060405234801561001057600080fd5b506040516101b63803806101b68339818101604052602081101561003357600080fd5b',
  '8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffff',
  'ffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000',
  '000081526004018080602001828103825260228152602001806101946022913960400191505060405180910390fd5b8060008061',
  '01000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffff',
  'ff16021790555050607b806101196000396000f3fe608060405260005463a619486e60003560e01c14156024578060601b606c52',
  '60206060f35b3660008037600080366000845af43d6000803e806040573d6000fd5b3d6000f3fea2646970667358221220e61834',
  'ebd2d8cd909d362bf67c47ef58fd665df38e6dd036ce65611101d072e964736f6c63430007060033496e76616c69642073696e67',
  '6c65746f6e20616464726573732070726f7669646564',
].join('')}`;

export interface WalletKeys {
  userKey: Address;
  recoveryKey: Address;
  executor: Address;
}

export interface PredictionContracts {
  safeProxyFactory: Address;
  safeSingleton: Address;
  safeBootstrap: Address;
}

/** `uint256(keccak256(abi.encode("MTW_SALT_V1", platformId, walletId)))` (P12.T04). */
export function walletSaltNonce(platformId: string, walletId: string): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'string' }],
        ['MTW_SALT_V1', platformId, walletId],
      ),
    ),
  );
}

export function safeInitializer(keys: WalletKeys, safeBootstrap: Address): Hex {
  const owners = [keys.userKey, keys.recoveryKey, keys.executor] as const;
  const bootstrapCall = encodeFunctionData({ abi: safeBootstrapAbi, functionName: 'bootstrap', args: owners });
  return encodeFunctionData({
    abi: iSafeAbi,
    functionName: 'setup',
    args: [[...owners], SAFE_THRESHOLD, safeBootstrap, bootstrapCall, ZERO_ADDRESS, ZERO_ADDRESS, 0n, ZERO_ADDRESS],
  });
}

/** keccak256(creationCode ‖ uint256(singleton)): init code hash de CREATE2 de un proxy de esa singleton. */
export function safeProxyInitCodeHash(singleton: Address): Hash {
  return keccak256(concat([SAFE_PROXY_CREATION_CODE, encodeAbiParameters([{ type: 'address' }], [singleton])]));
}

export function safeSalt(initializer: Hex, saltNonce: bigint): Hash {
  return keccak256(concat([keccak256(initializer), encodeAbiParameters([{ type: 'uint256' }], [saltNonce])]));
}

export function predictSafeAddress(keys: WalletKeys, saltNonce: bigint, contracts: PredictionContracts): Address {
  return getContractAddress({
    opcode: 'CREATE2',
    from: contracts.safeProxyFactory,
    salt: safeSalt(safeInitializer(keys, contracts.safeBootstrap), saltNonce),
    bytecodeHash: safeProxyInitCodeHash(contracts.safeSingleton),
  });
}
