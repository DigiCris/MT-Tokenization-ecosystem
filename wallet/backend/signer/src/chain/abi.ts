// Decodificación estricta de calldata (implementación propia del signer, espejo de CallDecoder [C-DEC]): selector y
// argumentos estáticos con LONGITUD EXACTA, palabras canónicas (direcciones con 12 bytes en cero, uint8 < 256). Un
// encoding ambiguo, bytes de más o de menos → error. Más un encoder mínimo para armar llamadas de lectura y
// execTransaction.
import { bytesToBigInt, bytesToHex, concatBytes, type Hex, hexToBytes, uint256ToBytes } from '../crypto/bytes.ts';
import { checksumAddress, selectorOf, type Address } from '../crypto/keccak.ts';

export class CalldataError extends Error {
  override name = 'CalldataError';
}

export const SELECTORS = {
  transfer: selectorOf('transfer(address,uint256)'),
  approve: selectorOf('approve(address,uint256)'),
  swap: selectorOf('swap(address,uint256,uint256,uint256)'),
  addDestination: selectorOf('addDestination(address)'),
  removeDestination: selectorOf('removeDestination(address)'),
  propose: selectorOf('propose(uint8,address,address)'),
  cancel: selectorOf('cancel(bytes32)'),
  swapOwner: selectorOf('swapOwner(address,address,address)'),
  setGuard: selectorOf('setGuard(address)'),
  setModuleGuard: selectorOf('setModuleGuard(address)'),
  execTransaction: selectorOf(
    'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
  ),
  createWallet: selectorOf('createWallet(address,address,address,uint256)'),
  cancelWithSignature: selectorOf('cancelWithSignature(bytes32,bytes)'),
} as const;

/** `null` si la calldata está vacía; error si tiene 1–3 bytes ([C-DEC-01]). */
export function selectorOfCalldata(data: Uint8Array): Hex | null {
  if (data.length === 0) return null;
  if (data.length < 4) throw new CalldataError('calldata de 1 a 3 bytes');
  return bytesToHex(data.subarray(0, 4));
}

type ArgType = 'address' | 'uint256' | 'uint8' | 'bytes32';
type Decoded<T extends readonly ArgType[]> = {
  [K in keyof T]: T[K] extends 'address' ? Address : T[K] extends 'bytes32' ? Hex : bigint;
};

/** Argumentos estáticos de una llamada con selector `selector`, exigiendo longitud 4 + 32·n exacta. */
export function decodeStatic<const T extends readonly ArgType[]>(
  data: Uint8Array,
  selector: Hex,
  types: T,
): Decoded<T> {
  if (data.length !== 4 + 32 * types.length) {
    throw new CalldataError(`longitud ${data.length}: se esperaban ${4 + 32 * types.length} bytes`);
  }
  if (bytesToHex(data.subarray(0, 4)) !== selector) throw new CalldataError('selector inesperado');
  return types.map((type, i) => decodeWord(data.subarray(4 + 32 * i, 36 + 32 * i), type)) as Decoded<T>;
}

function decodeWord(word: Uint8Array, type: ArgType): Address | bigint {
  switch (type) {
    case 'address':
      if (word.subarray(0, 12).some((b) => b !== 0)) throw new CalldataError('dirección no canónica');
      return checksumAddress(bytesToHex(word.subarray(12)));
    case 'uint8':
      if (word.subarray(0, 31).some((b) => b !== 0)) throw new CalldataError('uint8 fuera de rango');
      return BigInt(word[31] ?? 0);
    case 'uint256':
      return bytesToBigInt(word);
    case 'bytes32':
      return bytesToHex(word);
  }
}

export function wordAddress(address: Address): Uint8Array {
  return concatBytes(new Uint8Array(12), hexToBytes(address.toLowerCase(), 20));
}

export function wordUint(value: bigint | number): Uint8Array {
  return uint256ToBytes(BigInt(value));
}

/** Llamada con argumentos estáticos (palabras ya codificadas). */
export function encodeCall(selector: Hex, ...words: Uint8Array[]): Hex {
  return bytesToHex(concatBytes(hexToBytes(selector, 4), ...words));
}

/** `bytes` dinámico: longitud + contenido con padding a 32. */
export function encodeDynamicBytes(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32);
  padded.set(data);
  return concatBytes(wordUint(data.length), padded);
}
