// Vectores compartidos de contracts/test/vectors (los mismos que usan las apps, leídos de la fuente).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VECTORS = resolve(import.meta.dirname, '../../../../contracts/test/vectors');

export function vector(path: string): unknown {
  return JSON.parse(readFileSync(resolve(VECTORS, path), 'utf8'));
}

export interface EnvelopeVector {
  keyLabel: string;
  password: string;
  aad: string;
  envelope: Record<string, unknown> & { role: 'U' | 'R'; keyAddress: string; walletId: string };
}

export interface BackupVector {
  role: 'U' | 'R';
  keyLabel: string;
  keyAddress: string;
  words: string[];
}

export interface SafeTxVector {
  opType: string;
  to: string;
  value: string;
  data: string;
  operation: number;
  nonce: number;
  safeTxHash: string;
  signatureUser: string;
  signatureRecovery: string;
}
