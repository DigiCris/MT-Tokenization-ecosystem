// Co-firma soberana en Wallet (P18.T10, [W-05], [F-LNK-03]): importa el documento `mtw-sovereign-safetx` que arma la
// app Recovery (archivo JSON o QR multi-frame), verifica que sea de esta Safe y de Base, recalcula el hash de la SafeTx
// (el del documento no se usa para firmar), la decodifica para mostrarla y verifica las firmas que ya trae; U firma el
// hash propio (descifrada sólo para esa firma) y la app exporta el documento con la firma agregada. Nada pasa por el
// backend.
import { getAddress, isAddress, isAddressEqual, recoverAddress, type Address, type Hex } from 'viem';
import type { SafeTxJson } from '../api/wallet-api.ts';
import { canonicalize, type Json } from '../api/jcs.ts';
import { decodeSafeTx, type DecodeContext, type DecodedCall } from '../chain/decoders.ts';
import { parseSafeTx, safeTxHash } from '../chain/safe-tx.ts';
import { fromHex } from '../crypto/bytes.ts';
import type { KeyEnvelope } from '../crypto/envelope.ts';
import { signDigest, withKey } from '../crypto/sign.ts';

export type SovereignRole = 'U' | 'R' | 'S';

export interface SovereignSignature {
  signer: Address;
  role: SovereignRole;
  signature: Hex;
}

export interface SovereignDocument {
  format: 'mtw-sovereign-safetx';
  version: 1;
  chainId: number;
  safe: Address;
  safeTx: SafeTxJson;
  safeTxHash: Hex;
  action: { type: string; params: Record<string, string> };
  signatures: SovereignSignature[];
  createdAt: string;
}

export class SovereignDocumentError extends Error {
  override name = 'SovereignDocumentError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HEX = /^0x[0-9a-fA-F]*$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;

function safeTxOf(value: unknown): SafeTxJson {
  if (!isRecord(value)) throw new SovereignDocumentError('El documento no trae la SafeTx.');
  const { to, value: amount, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce } = value;
  const ok =
    typeof to === 'string' &&
    isAddress(to) &&
    typeof data === 'string' &&
    HEX.test(data) &&
    (operation === 0 || operation === 1) &&
    [amount, safeTxGas, baseGas, gasPrice, nonce].every((v) => typeof v === 'string' && UINT.test(v)) &&
    typeof gasToken === 'string' &&
    isAddress(gasToken) &&
    typeof refundReceiver === 'string' &&
    isAddress(refundReceiver);
  if (!ok) throw new SovereignDocumentError('La SafeTx del documento está mal formada.');
  return value as unknown as SafeTxJson;
}

export function parseSovereignDocument(text: string): SovereignDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SovereignDocumentError('El archivo no es un documento de operación soberana.');
  }
  if (!isRecord(value) || value.format !== 'mtw-sovereign-safetx' || value.version !== 1) {
    throw new SovereignDocumentError('El archivo no es un documento de operación soberana (mtw-sovereign-safetx v1).');
  }
  const { chainId, safe, safeTxHash: hash, action, signatures, createdAt } = value;
  if (typeof chainId !== 'number' || typeof safe !== 'string' || !isAddress(safe)) {
    throw new SovereignDocumentError('El documento no indica la Safe o la red.');
  }
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash) || typeof createdAt !== 'string') {
    throw new SovereignDocumentError('El documento está incompleto.');
  }
  if (!isRecord(action) || typeof action.type !== 'string' || !isRecord(action.params)) {
    throw new SovereignDocumentError('El documento no describe la acción.');
  }
  if (!Array.isArray(signatures)) throw new SovereignDocumentError('El documento no trae la lista de firmas.');
  const parsedSignatures = signatures.map((s: unknown): SovereignSignature => {
    if (
      !isRecord(s) ||
      typeof s.signer !== 'string' ||
      !isAddress(s.signer) ||
      (s.role !== 'U' && s.role !== 'R' && s.role !== 'S') ||
      typeof s.signature !== 'string' ||
      !/^0x[0-9a-fA-F]{130}$/.test(s.signature)
    ) {
      throw new SovereignDocumentError('Una de las firmas del documento está mal formada.');
    }
    return { signer: getAddress(s.signer), role: s.role, signature: s.signature as Hex };
  });
  return {
    format: 'mtw-sovereign-safetx',
    version: 1,
    chainId,
    safe: getAddress(safe),
    safeTx: safeTxOf(value.safeTx),
    safeTxHash: hash as Hex,
    action: { type: action.type, params: action.params as Record<string, string> },
    signatures: parsedSignatures,
    createdAt,
  };
}

export interface SovereignReview {
  hash: Hex;
  decoded: DecodedCall;
  /** Firmas del documento que recuperan exactamente su firmante. */
  validSignatures: SovereignSignature[];
}

/** Verifica el documento para esta Safe y lo decodifica; el hash es el recalculado por la app. */
export async function reviewSovereign(doc: SovereignDocument, ctx: DecodeContext): Promise<SovereignReview> {
  if (doc.chainId !== 8453) throw new SovereignDocumentError('El documento es de otra red (sólo Base, 8453).');
  if (!isAddressEqual(doc.safe, ctx.safe)) throw new SovereignDocumentError('El documento es de otra Safe.');
  const tx = parseSafeTx(doc.safeTx);
  const hash = safeTxHash(8453, doc.safe, tx);
  if (hash !== doc.safeTxHash.toLowerCase()) {
    throw new SovereignDocumentError('El hash del documento no es el de su SafeTx: no se firma.');
  }
  const validSignatures: SovereignSignature[] = [];
  for (const s of doc.signatures) {
    const recovered = await recoverAddress({ hash, signature: s.signature }).catch(() => null);
    if (recovered !== null && isAddressEqual(recovered, s.signer)) validSignatures.push(s);
  }
  return { hash, decoded: decodeSafeTx(tx, ctx), validSignatures };
}

/** Documento con la firma de U agregada (reemplaza una firma anterior de la misma U). */
export async function addUserSignature(
  doc: SovereignDocument,
  review: SovereignReview,
  key: { envelope: KeyEnvelope; encryptionKey: CryptoKey },
): Promise<SovereignDocument> {
  const signature = await withKey(key.envelope, key.encryptionKey, (privateKey) =>
    signDigest(fromHex(review.hash), privateKey),
  );
  const signer = getAddress(key.envelope.keyAddress);
  return {
    ...doc,
    signatures: [...doc.signatures.filter((s) => !isAddressEqual(s.signer, signer)), { signer, role: 'U', signature }],
  };
}

/** Contenido JCS del documento: el del archivo exportado y el que viaja en el QR multi-frame. */
export function sovereignContent(doc: SovereignDocument): string {
  return canonicalize(doc as unknown as Json);
}
