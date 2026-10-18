// Creation code del proxy de Safe 1.5.0 (`SafeProxyFactory.proxyCreationCode()`, deployment canónico de Base): con él
// el backend calcula el init code hash del proxy (y la Safe esperada, P12.T04) sin consultar a la WalletFactory. Su
// keccak256 debe ser `proxyCreationCodeHash` de config/chains/base-mainnet.json (lo verifica
// test/chain/safe-proxy.test.ts junto con el vector contracts/test/vectors/create2.json).
import { concat, encodeAbiParameters, keccak256, type Address, type Hash, type Hex } from 'viem';

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

/** keccak256(creationCode ++ uint256(singleton)): el init code hash de CREATE2 de un proxy de esa singleton. */
export function safeProxyInitCodeHash(singleton: Address): Hash {
  return keccak256(concat([SAFE_PROXY_CREATION_CODE, encodeAbiParameters([{ type: 'address' }], [singleton])]));
}
