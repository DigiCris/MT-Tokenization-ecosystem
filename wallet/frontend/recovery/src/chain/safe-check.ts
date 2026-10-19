// Verificación propia de la Safe antes de que R firme algo (P19, mismo principio que la Wallet en V9 §16): por el RPC de
// Recovery y contra lo fijado en el build. Contratos del sistema con su codehash, proxy de Safe v1.5.0 apuntando al
// SafeL2 fijado, threshold 2, Guard y module guard del sistema, Safe registrada en el Guard, owners = los tres roles
// vigentes y, si se pide, que R sea la recoveryKey del Guard. Si algo no coincide, no se opera con esa Safe.
import { getAddress, isAddressEqual, keccak256, type Address, type Hex } from 'viem';
import type { PinnedChain } from '../config/chain.ts';
import type { SystemContracts, SystemRole } from '../config/system-contracts.ts';
import { iSafeAbi } from './abis/ISafe.ts';
import { securityGuardAbi } from './abis/SecurityGuard.ts';
import type { ChainReader } from './client.ts';
import { readRoles, safeOwners, type SafeRoles } from './rotations.ts';

export const SAFE_SLOTS = {
  singleton: '0x0000000000000000000000000000000000000000000000000000000000000000',
  guard: '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8',
  moduleGuard: '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947',
} as const satisfies Record<string, Hex>;

export type SafeReader = Pick<ChainReader, 'getCode' | 'getStorageAt' | 'readContract'>;

export interface CheckedSafe {
  safe: Address;
  roles: SafeRoles;
  owners: Address[];
  /** Ítems que no coinciden (vacío = la Safe es la que espera la app). */
  failures: string[];
}

const FAILURE_TEXT: Record<string, string> = {
  SAFE_PROXY_CODEHASH: 'la dirección no es un proxy de Safe v1.5.0',
  SINGLETON: 'la Safe no usa el SafeL2 v1.5.0 fijado',
  SINGLETON_CODEHASH: 'el SafeL2 no tiene el código fijado',
  THRESHOLD: 'la Safe no pide 2 firmas',
  GUARD: 'la Safe no tiene el Guard del sistema',
  MODULE_GUARD: 'la Safe no tiene el module guard del sistema',
  NOT_REGISTERED: 'el Guard no tiene registrada esta Safe',
  OWNERS: 'los owners de la Safe no son los roles del Guard',
  RECOVERY_KEY: 'tu clave R no es la clave de recuperación de esta Safe',
};

export function safeFailureText(item: string): string {
  if (item.startsWith('CODEHASH_'))
    return `el contrato del sistema ${item.slice(9).toLowerCase()} no tiene el código fijado`;
  return FAILURE_TEXT[item] ?? item;
}

function slotAddress(value: Hex | undefined): Address {
  return getAddress(`0x${(value ?? '0x').replace(/^0x/, '').padStart(64, '0').slice(24)}`);
}

async function codehash(reader: SafeReader, address: Address): Promise<Hex> {
  const code = await reader.getCode({ address });
  return keccak256(code ?? '0x');
}

export async function checkSafe(
  reader: SafeReader,
  pinned: { system: SystemContracts; chain: PinnedChain },
  safe: Address,
  expected: { recoveryKey?: Address } = {},
): Promise<CheckedSafe> {
  const failures: string[] = [];
  const check = (ok: boolean, item: string) => {
    if (!ok) failures.push(item);
  };
  const { contracts } = pinned.system;
  const roles = Object.keys(contracts) as SystemRole[];
  const [systemHashes, safeHash, singleton, guard, moduleGuard] = await Promise.all([
    Promise.all(roles.map((role) => codehash(reader, contracts[role].address))),
    codehash(reader, safe),
    reader.getStorageAt({ address: safe, slot: SAFE_SLOTS.singleton }),
    reader.getStorageAt({ address: safe, slot: SAFE_SLOTS.guard }),
    reader.getStorageAt({ address: safe, slot: SAFE_SLOTS.moduleGuard }),
  ]);
  roles.forEach((role, i) => {
    check(systemHashes[i] === contracts[role].codehash, `CODEHASH_${role.toUpperCase()}`);
  });
  check(safeHash === pinned.chain.safe.proxyRuntimeCodehash, 'SAFE_PROXY_CODEHASH');
  const singletonAddress = slotAddress(singleton);
  check(isAddressEqual(singletonAddress, pinned.chain.safe.singletonL2), 'SINGLETON');
  check((await codehash(reader, singletonAddress)) === pinned.chain.safe.singletonL2Codehash, 'SINGLETON_CODEHASH');
  check(isAddressEqual(slotAddress(guard), contracts.guard.address), 'GUARD');
  check(isAddressEqual(slotAddress(moduleGuard), contracts.moduleGuard.address), 'MODULE_GUARD');
  const deployed = safeHash === pinned.chain.safe.proxyRuntimeCodehash;
  const [threshold, registered, owners, current] = deployed
    ? await Promise.all([
        reader.readContract({ address: safe, abi: iSafeAbi, functionName: 'getThreshold' }),
        reader.readContract({
          address: contracts.guard.address,
          abi: securityGuardAbi,
          functionName: 'isRegistered',
          args: [safe],
        }),
        safeOwners(reader, safe),
        readRoles(reader, contracts.guard.address, safe),
      ])
    : [0n, false, [] as Address[], null];
  check(threshold === 2n, 'THRESHOLD');
  check(registered, 'NOT_REGISTERED');
  const empty = '0x0000000000000000000000000000000000000000' as Address;
  const safeRoles = current ?? { userKey: empty, recoveryKey: empty, executor: empty };
  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  check(
    owners.length === 3 &&
      ownerSet.size === 3 &&
      [safeRoles.userKey, safeRoles.recoveryKey, safeRoles.executor].every((k) => ownerSet.has(k.toLowerCase())),
    'OWNERS',
  );
  if (expected.recoveryKey !== undefined)
    check(isAddressEqual(safeRoles.recoveryKey, expected.recoveryKey), 'RECOVERY_KEY');
  return { safe: getAddress(safe), roles: safeRoles, owners, failures };
}

export class SafeCheckError extends Error {
  override name = 'SafeCheckError';
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(
      `La verificación propia de la Safe falló: ${failures.map(safeFailureText).join('; ')}. No se opera con ella.`,
    );
    this.failures = failures;
  }
}

/** Como checkSafe, pero falla si algún ítem no coincide. */
export async function requireSafe(
  reader: SafeReader,
  pinned: { system: SystemContracts; chain: PinnedChain },
  safe: Address,
  expected: { recoveryKey?: Address } = {},
): Promise<CheckedSafe> {
  const checked = await checkSafe(reader, pinned, safe, expected);
  if (checked.failures.length > 0) throw new SafeCheckError(checked.failures);
  return checked;
}
