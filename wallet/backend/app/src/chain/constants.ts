// Enums y direcciones del sistema, espejo de contracts/src/libraries/{Roles,OpTypes}.sol e interfaces/ISafe.sol.
import type { Address } from 'viem';

/** `Role` de los contratos (uint8). */
export const Role = { None: 0, User: 1, Recovery: 2, Executor: 3 } as const;
export type RoleValue = (typeof Role)[keyof typeof Role];

/** `RotationKind` del RotationTimelock (uint8). */
export const RotationKind = { User: 0, Recovery: 1, Executor: 2, Guard: 3, ModuleGuard: 4 } as const;
export type RotationKindValue = (typeof RotationKind)[keyof typeof RotationKind];

/** `Operation` de Safe. */
export const SafeOperation = { Call: 0, DelegateCall: 1 } as const;

/** Contratos del sistema y tokens soportados de un despliegue (deployments/<red>.json). */
export interface SystemAddresses {
  securityGuard: Address;
  rotationTimelock: Address;
  walletFactory: Address;
  safeBootstrap: Address;
  policyRegistry: Address;
  destinationWhitelist: Address;
  denyAllModuleGuard: Address;
  swapExecutor: Address;
  usdc: Address;
  usdt: Address;
  /** RotationTimelocks de los Guards sucesores fijados en el snapshot ([C-GRD-17]): también reciben propose/cancel. */
  rotationTimelocks?: readonly Address[];
}
