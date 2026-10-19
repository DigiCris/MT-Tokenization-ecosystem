// Documento soberano [W-05] en Recovery (P19.T06): `mtw-sovereign-safetx` v1 con la SafeTx, su hash, la acción tipada y
// las firmas. Al importar se recalcula el hash desde los bytes (nunca se confía en el del archivo) y cada firma tiene que
// recuperar a su firmante. Las firmas se combinan ordenadas por dirección del firmante (lo que exige la Safe) para la
// calldata de `execTransaction`, que transmite una wallet externa o cualquier relayer. Nada pasa por el backend.
import {
  concat,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';
import { canonicalize, type Json } from '../api/jcs.ts';
import { iSafeAbi } from '../chain/abis/ISafe.ts';
import { safeTxHash, type SafeTx } from '../chain/safe-tx.ts';

export const SOVEREIGN_FORMAT = 'mtw-sovereign-safetx';

export type SovereignRole = 'U' | 'R';

export interface SovereignSignature {
  signer: Address;
  role: SovereignRole;
  signature: Hex;
}

export interface SovereignDocument {
  format: typeof SOVEREIGN_FORMAT;
  version: 1;
  chainId: 8453;
  safe: Address;
  safeTx: {
    to: Address;
    value: string;
    data: Hex;
    operation: 0 | 1;
    safeTxGas: string;
    baseGas: string;
    gasPrice: string;
    gasToken: Address;
    refundReceiver: Address;
    nonce: string;
  };
  safeTxHash: Hex;
  action: { type: string; params: Record<string, string> };
  signatures: SovereignSignature[];
  createdAt: string;
}

export class SovereignDocumentError extends Error {
  override name = 'SovereignDocumentError';
}

const UINT = /^(0|[1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addressOf(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new SovereignDocumentError(`${field} inválido`);
  return getAddress(value);
}

function uintOf(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UINT.test(value)) throw new SovereignDocumentError(`${field} inválido`);
  return value;
}

export function toSafeTx(doc: Pick<SovereignDocument, 'safeTx'>): SafeTx {
  const t = doc.safeTx;
  return {
    to: t.to,
    value: BigInt(t.value),
    data: t.data,
    operation: t.operation,
    safeTxGas: BigInt(t.safeTxGas),
    baseGas: BigInt(t.baseGas),
    gasPrice: BigInt(t.gasPrice),
    gasToken: t.gasToken,
    refundReceiver: t.refundReceiver,
    nonce: BigInt(t.nonce),
  };
}

/** Valida un documento importado (archivo o QR) y exige que su hash sea el que calcula la app. */
export function parseSovereignDocument(value: unknown): SovereignDocument {
  if (!isRecord(value)) throw new SovereignDocumentError('el documento no es un objeto JSON');
  if (value.format !== SOVEREIGN_FORMAT || value.version !== 1) {
    throw new SovereignDocumentError('no es un documento mtw-sovereign-safetx v1');
  }
  if (value.chainId !== 8453) throw new SovereignDocumentError('el documento no es de Base (8453)');
  const safe = addressOf(value.safe, 'safe');
  const tx = value.safeTx;
  if (!isRecord(tx)) throw new SovereignDocumentError('safeTx inválida');
  if (tx.operation !== 0 && tx.operation !== 1) throw new SovereignDocumentError('operation inválida');
  const operation: 0 | 1 = tx.operation === 1 ? 1 : 0;
  if (typeof tx.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data))
    throw new SovereignDocumentError('data inválida');
  const safeTx = {
    to: addressOf(tx.to, 'to'),
    value: uintOf(tx.value, 'value'),
    data: tx.data.toLowerCase() as Hex,
    operation,
    safeTxGas: uintOf(tx.safeTxGas, 'safeTxGas'),
    baseGas: uintOf(tx.baseGas, 'baseGas'),
    gasPrice: uintOf(tx.gasPrice, 'gasPrice'),
    gasToken: addressOf(tx.gasToken, 'gasToken'),
    refundReceiver: addressOf(tx.refundReceiver, 'refundReceiver'),
    nonce: uintOf(tx.nonce, 'nonce'),
  };
  const hash = safeTxHash(8453, safe, toSafeTx({ safeTx }));
  if (typeof value.safeTxHash !== 'string' || value.safeTxHash.toLowerCase() !== hash) {
    throw new SovereignDocumentError('el safeTxHash del documento no es el de su SafeTx: no se usa');
  }
  const action = value.action;
  if (!isRecord(action) || typeof action.type !== 'string' || !isRecord(action.params)) {
    throw new SovereignDocumentError('acción inválida');
  }
  const params: Record<string, string> = {};
  for (const [key, param] of Object.entries(action.params)) {
    if (typeof param !== 'string') throw new SovereignDocumentError('parámetro de la acción inválido');
    params[key] = param;
  }
  if (!Array.isArray(value.signatures)) throw new SovereignDocumentError('firmas inválidas');
  const signatures = value.signatures.map((entry: unknown): SovereignSignature => {
    if (!isRecord(entry)) throw new SovereignDocumentError('firma inválida');
    const role = entry.role;
    if (role !== 'U' && role !== 'R') throw new SovereignDocumentError('firma inválida');
    if (typeof entry.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(entry.signature)) {
      throw new SovereignDocumentError('firma inválida');
    }
    return { signer: addressOf(entry.signer, 'signer'), role, signature: entry.signature.toLowerCase() as Hex };
  });
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw new SovereignDocumentError('createdAt inválido');
  }
  return {
    format: SOVEREIGN_FORMAT,
    version: 1,
    chainId: 8453,
    safe,
    safeTx,
    safeTxHash: hash,
    action: { type: action.type, params },
    signatures,
    createdAt: value.createdAt,
  };
}

/** Las firmas del documento recuperan a sus firmantes (sobre el hash recalculado). */
export async function verifySignatures(doc: SovereignDocument): Promise<void> {
  for (const entry of doc.signatures) {
    const recovered = await recoverAddress({ hash: doc.safeTxHash, signature: entry.signature });
    if (!isAddressEqual(recovered, entry.signer)) {
      throw new SovereignDocumentError(`la firma de ${entry.role} no es de ${entry.signer}`);
    }
  }
}

/** Documento nuevo (sin firmas) para una SafeTx tipada. */
export function newDocument(
  safe: Address,
  tx: SafeTx,
  action: { type: string; params: Record<string, string> },
  now: Date,
): SovereignDocument {
  return {
    format: SOVEREIGN_FORMAT,
    version: 1,
    chainId: 8453,
    safe: getAddress(safe),
    safeTx: {
      to: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas.toString(),
      baseGas: tx.baseGas.toString(),
      gasPrice: tx.gasPrice.toString(),
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: tx.nonce.toString(),
    },
    safeTxHash: safeTxHash(8453, safe, tx),
    action,
    signatures: [],
    createdAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** Agrega (o reemplaza) la firma de un rol; la firma tiene que recuperar al firmante declarado. */
export async function withSignature(doc: SovereignDocument, entry: SovereignSignature): Promise<SovereignDocument> {
  const recovered = await recoverAddress({ hash: doc.safeTxHash, signature: entry.signature });
  if (!isAddressEqual(recovered, entry.signer)) throw new SovereignDocumentError(`la firma no es de ${entry.signer}`);
  return { ...doc, signatures: [...doc.signatures.filter((s) => s.role !== entry.role), entry] };
}

/** Une las firmas de otro documento con el mismo hash (p. ej. el que devolvió la Wallet firmado por U). */
export async function mergeSignatures(doc: SovereignDocument, other: SovereignDocument): Promise<SovereignDocument> {
  if (other.safeTxHash !== doc.safeTxHash || !isAddressEqual(other.safe, doc.safe)) {
    throw new SovereignDocumentError('el documento importado es de otra operación');
  }
  let merged = doc;
  for (const entry of other.signatures) merged = await withSignature(merged, entry);
  return merged;
}

/** Calldata de execTransaction con las firmas ordenadas por firmante (ascendente), como las verifica la Safe. */
export function execTransactionData(doc: SovereignDocument): Hex {
  if (doc.signatures.length < 2) throw new SovereignDocumentError('faltan firmas: hacen falta U y R');
  const sorted = [...doc.signatures].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  const tx = toSafeTx(doc);
  return encodeFunctionData({
    abi: iSafeAbi,
    functionName: 'execTransaction',
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      concat(sorted.map((s) => s.signature)),
    ],
  });
}

/** Contenido del QR (JCS del documento) y del archivo (JSON legible). */
export function sovereignContent(doc: SovereignDocument): string {
  return canonicalize(doc as unknown as Json);
}

export function sovereignFile(doc: SovereignDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function sovereignFileName(doc: SovereignDocument): string {
  return `mtw-sovereign-${doc.safeTxHash.slice(2, 10)}-${
    doc.signatures
      .map((s) => s.role)
      .sort()
      .join('') || 'sin-firmas'
  }.json`;
}
