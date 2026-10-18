// P16.T09 [F-SEC-08]: el archivo de contratos fijados se valida al cargar y la app rechaza cualquier dirección del
// sistema que el backend informe distinta de la fijada en el build.
import { describe, expect, it } from 'vitest';
import {
  assertReportedSystem,
  parseSystemContracts,
  SYSTEM_ROLES,
  SystemContractsMismatchError,
} from './system-contracts.ts';

const ATTESTATION = 'MCowBQYDK2VwAyEA' + 'A'.repeat(43) + '=';
const NAMES = {
  guard: 'SecurityGuard',
  timelock: 'RotationTimelock',
  policyRegistry: 'PolicyRegistry',
  whitelist: 'DestinationWhitelist',
  swapExecutor: 'SwapExecutorV3',
  bootstrap: 'SafeBootstrap',
  factory: 'WalletFactory',
  moduleGuard: 'DenyAllModuleGuard',
} as const;

/** Archivo como lo emite build/system-contracts.ts (direcciones distintas por rol, en minúsculas para probar checksum). */
function file(overrides: Record<string, unknown> = {}) {
  return {
    format: 'mtw-system-contracts',
    formatVersion: 1,
    environment: 'local',
    chainId: 8453,
    deploymentBlock: 52_700_000,
    contracts: Object.fromEntries(
      SYSTEM_ROLES.map((role, i) => [
        role,
        { name: NAMES[role], address: `0x${String(i + 1).repeat(40)}`, codehash: `0x${'ab'.repeat(32)}` },
      ]),
    ),
    signerAttestationPublicKey: ATTESTATION,
    ...overrides,
  };
}

const pinned = parseSystemContracts(file());
const reported = () =>
  Object.fromEntries(SYSTEM_ROLES.map((role) => [role, pinned.contracts[role].address.toLowerCase()])) as Record<
    (typeof SYSTEM_ROLES)[number],
    string
  >;

describe('archivo de contratos fijados', () => {
  it('se valida, se normaliza a checksum y queda congelado', () => {
    expect(pinned.contracts.guard.address).toBe('0x1111111111111111111111111111111111111111');
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(Object.isFrozen(pinned.contracts.guard)).toBe(true);
  });

  it.each([
    ['formato desconocido', { format: 'otro' }],
    ['otra cadena', { chainId: 1 }],
    ['clave de atestación inválida', { signerAttestationPublicKey: 'A'.repeat(44) }],
    ['sin contratos', { contracts: null }],
    ['falta un rol', { contracts: { guard: file().contracts.guard } }],
  ])('rechaza %s', (_label, overrides) => {
    expect(() => parseSystemContracts(file(overrides))).toThrow();
  });

  it('rechaza un codehash mal formado', () => {
    const broken = file();
    broken.contracts.guard = { ...broken.contracts.guard!, codehash: '0x1234' };
    expect(() => parseSystemContracts(broken)).toThrow(/codehash/);
  });
});

describe('direcciones informadas por el backend', () => {
  it('iguales (sin importar mayúsculas) → acepta', () => {
    expect(() => {
      assertReportedSystem(pinned, reported());
    }).not.toThrow();
  });

  it('una dirección distinta → la app se niega a operar', () => {
    const tampered = { ...reported(), guard: '0x9999999999999999999999999999999999999999' };
    expect(() => {
      assertReportedSystem(pinned, tampered);
    }).toThrow(SystemContractsMismatchError);
    try {
      assertReportedSystem(pinned, tampered);
    } catch (error) {
      expect((error as SystemContractsMismatchError).roles).toEqual(['guard']);
    }
  });

  it('faltante, null o inválida cuenta como distinta; un subconjunto requerido alcanza si coincide', () => {
    const { timelock: _omit, ...partial } = reported();
    expect(() => {
      assertReportedSystem(pinned, partial);
    }).toThrow(/timelock/);
    expect(() => {
      assertReportedSystem(pinned, { ...reported(), factory: null });
    }).toThrow(/factory/);
    expect(() => {
      assertReportedSystem(pinned, { ...reported(), whitelist: '0xnope' });
    }).toThrow(/whitelist/);
    expect(() => {
      assertReportedSystem(pinned, { guard: reported().guard }, ['guard']);
    }).not.toThrow();
    expect(() => {
      assertReportedSystem(pinned, { guard: reported().guard, timelock: '0x' + '9'.repeat(40) }, ['guard']);
    }).toThrow(/timelock/);
  });
});
