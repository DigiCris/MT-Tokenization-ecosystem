// Guards aceptados de una Safe ([C-GRD-17], ADR-029): el Guard del sistema y los sucesores fijados en el snapshot de
// policy, cada uno con su RotationTimelock, y el module guard del sistema con sus sucesores. Una Safe con otro Guard u
// otro module guard ya no es una wallet asistida (deriva de configuración, P13.T11).
import { isAddressEqual, type Address } from 'viem';
import type { BackendPolicySnapshot } from './snapshot.ts';

export interface GuardInfo {
  guard: Address;
  rotationTimelock: Address;
}

/** El Guard del sistema primero y después los sucesores del snapshot. */
export function guardsOf(snapshot: BackendPolicySnapshot): GuardInfo[] {
  const c = snapshot.contracts;
  return [{ guard: c.securityGuard, rotationTimelock: c.rotationTimelock }, ...snapshot.successors.guards];
}

/** Guard aceptado instalado en una Safe (null si no es el del sistema ni un sucesor fijado). */
export function guardInfo(snapshot: BackendPolicySnapshot, guard: Address): GuardInfo | null {
  return guardsOf(snapshot).find((g) => isAddressEqual(g.guard, guard)) ?? null;
}

/** Guard dueño de un RotationTimelock aceptado. */
export function guardOfTimelock(snapshot: BackendPolicySnapshot, timelock: Address): GuardInfo | null {
  return guardsOf(snapshot).find((g) => isAddressEqual(g.rotationTimelock, timelock)) ?? null;
}

export function timelocksOf(snapshot: BackendPolicySnapshot): Address[] {
  return guardsOf(snapshot).map((g) => g.rotationTimelock);
}

export function moduleGuardsOf(snapshot: BackendPolicySnapshot): Address[] {
  return [snapshot.contracts.denyAllModuleGuard, ...snapshot.successors.moduleGuards];
}

export function isAcceptedModuleGuard(snapshot: BackendPolicySnapshot, moduleGuard: Address): boolean {
  return moduleGuardsOf(snapshot).some((m) => isAddressEqual(m, moduleGuard));
}

/** Direcciones de los sucesores (nunca destino de fondos ni clave de una Safe, como los contratos del sistema). */
export function successorAddresses(snapshot: BackendPolicySnapshot): Address[] {
  return [
    ...snapshot.successors.guards.flatMap((g) => [g.guard, g.rotationTimelock]),
    ...snapshot.successors.moduleGuards,
  ];
}
