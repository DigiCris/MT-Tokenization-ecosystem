// Resultado del arranque de seguridad para las pantallas que lo muestran (comprobación del dispositivo).
import { createContext, use } from 'react';
import type { BootResult } from '../security/boot.ts';

export const SecurityStatus = createContext<BootResult | null>(null);

export function useSecurityStatus(): BootResult {
  const status = use(SecurityStatus);
  if (status === null) throw new Error('falta el resultado del arranque de seguridad');
  return status;
}
