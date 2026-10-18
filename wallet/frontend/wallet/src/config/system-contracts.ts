// Contratos del sistema fijados en el build ([F-SEC-08], P16.T09): el archivo system-contracts.<env>.json embebido
// (cubierto por el manifest firmado) es la referencia; las direcciones que informe el backend (p. ej.
// GET /wallets/{id}/deployment) se comparan contra él y ante cualquier diferencia la app se niega a operar.
import { getAddress, isAddress } from 'viem';

export const SYSTEM_ROLES = [
  'guard',
  'timelock',
  'policyRegistry',
  'whitelist',
  'swapExecutor',
  'bootstrap',
  'factory',
  'moduleGuard',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

export interface PinnedContract {
  name: string;
  address: `0x${string}`;
  codehash: `0x${string}`;
}

export interface SystemContracts {
  format: 'mtw-system-contracts';
  formatVersion: 1;
  environment: string;
  chainId: 8453;
  deploymentBlock: number;
  contracts: Readonly<Record<SystemRole, Readonly<PinnedContract>>>;
  signerAttestationPublicKey: string;
}

export class SystemContractsMismatchError extends Error {
  readonly roles: readonly SystemRole[];

  constructor(roles: readonly SystemRole[]) {
    super(`el backend informó contratos del sistema distintos de los fijados en el build: ${roles.join(', ')}`);
    this.name = 'SystemContractsMismatchError';
    this.roles = roles;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Valida la forma del archivo embebido (nunca se confía en un archivo mal formado) y lo congela. */
export function parseSystemContracts(value: unknown): SystemContracts {
  if (!isRecord(value) || value.format !== 'mtw-system-contracts' || value.formatVersion !== 1) {
    throw new Error('contratos del sistema: formato desconocido');
  }
  if (value.chainId !== 8453) throw new Error('contratos del sistema: la cadena no es Base (8453)');
  if (typeof value.environment !== 'string' || typeof value.deploymentBlock !== 'number') {
    throw new Error('contratos del sistema: falta el entorno o el bloque');
  }
  // Clave pública Ed25519 de atestación como SPKI DER en base64 (WebCrypto la importa tal cual).
  if (
    typeof value.signerAttestationPublicKey !== 'string' ||
    !/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(value.signerAttestationPublicKey)
  ) {
    throw new Error('contratos del sistema: clave de atestación del signer inválida');
  }
  const contracts = value.contracts;
  if (!isRecord(contracts)) throw new Error('contratos del sistema: falta la lista de contratos');
  const parsed = {} as Record<SystemRole, Readonly<PinnedContract>>;
  for (const role of SYSTEM_ROLES) {
    const entry = contracts[role];
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.address !== 'string' ||
      !isAddress(entry.address)
    ) {
      throw new Error(`contratos del sistema: dirección inválida para ${role}`);
    }
    if (typeof entry.codehash !== 'string' || !/^0x[0-9a-f]{64}$/.test(entry.codehash)) {
      throw new Error(`contratos del sistema: codehash inválido para ${role}`);
    }
    parsed[role] = Object.freeze({
      name: entry.name,
      address: getAddress(entry.address),
      codehash: entry.codehash as `0x${string}`,
    });
  }
  return Object.freeze({
    format: 'mtw-system-contracts',
    formatVersion: 1,
    environment: value.environment,
    chainId: 8453,
    deploymentBlock: value.deploymentBlock,
    contracts: Object.freeze(parsed),
    signerAttestationPublicKey: value.signerAttestationPublicKey,
  });
}

/** Direcciones del sistema informadas por el backend, con el nombre de campo de cada rol. */
export type ReportedSystem = Partial<Record<SystemRole, string | null>>;

/**
 * Compara lo informado con lo fijado: cada rol requerido tiene que estar y coincidir, y cualquier otro rol informado
 * también tiene que coincidir. Lanza SystemContractsMismatchError con los roles distintos.
 */
export function assertReportedSystem(
  pinned: SystemContracts,
  reported: ReportedSystem,
  required: readonly SystemRole[] = SYSTEM_ROLES,
): void {
  const differs = SYSTEM_ROLES.filter((role) => {
    const value = reported[role];
    if (value === undefined) return required.includes(role);
    if (value === null || !isAddress(value, { strict: false })) return true;
    return getAddress(value) !== pinned.contracts[role].address;
  });
  if (differs.length > 0) throw new SystemContractsMismatchError(differs);
}
