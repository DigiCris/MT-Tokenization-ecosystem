// Verificación propia de la Safe en cada desbloqueo (P18.T02): se corre una vez por PlatformSession (cada desbloqueo
// crea una nueva) y su resultado se recuerda mientras dure; la app opera sólo si no hay ítems fallidos.
import type { Address } from 'viem';
import { pinnedChain } from '../config/chain.ts';
import { systemContracts } from '../config/index.ts';
import { verifySafe, type SafeReader, type VerificationResult } from './verify.ts';

const results = new Map<string, Promise<VerificationResult>>();

export function verifyOnUnlock(
  sessionId: string,
  reader: SafeReader,
  input: { safe: Address; userKey: Address },
): Promise<VerificationResult> {
  let pending = results.get(sessionId);
  if (pending === undefined) {
    pending = verifySafe(reader, { chain: pinnedChain, system: systemContracts }, { kind: 'unlock', ...input }).catch(
      (error: unknown) => {
        results.delete(sessionId);
        throw error;
      },
    );
    results.set(sessionId, pending);
  }
  return pending;
}

/** Texto para el usuario de cada ítem fallido de la verificación (V9 §16). */
export function failureText(item: string): string {
  const codehash = /^CODEHASH_(.+)$/.exec(item);
  if (codehash) return `el contrato del sistema "${(codehash[1] ?? '').toLowerCase()}" no es el fijado en esta versión`;
  const texts: Record<string, string> = {
    CHAIN_ID: 'el RPC no es de Base (8453)',
    NOT_A_FACTORY_WALLET: 'la Safe no la creó la factory del sistema',
    SAFE_PROXY_CODEHASH: 'la dirección no tiene el proxy de Safe esperado',
    SINGLETON: 'la Safe no usa la implementación SafeL2 1.5.0 fijada',
    SINGLETON_CODEHASH: 'la implementación de la Safe no tiene el código esperado',
    THRESHOLD: 'el umbral de firmas no es 2 de 3',
    GUARD: 'la Safe no tiene instalado el Guard del sistema',
    MODULE_GUARD: 'la Safe no tiene el guard de módulos del sistema',
    FALLBACK_HANDLER: 'la Safe tiene un fallback handler',
    MODULES: 'la Safe tiene módulos habilitados',
    ROTATION_TIMELOCK: 'el Guard apunta a otro timelock',
    POLICY_REGISTRY: 'el Guard apunta a otro registro de políticas',
    WHITELIST: 'el Guard apunta a otra whitelist',
    GUARD_MODULE_GUARD: 'el Guard apunta a otro guard de módulos',
    NOT_REGISTERED: 'la Safe no está registrada en el Guard',
    OWNERS: 'los firmantes de la Safe no son las tres claves registradas',
    ADDRESS_MISMATCH: 'la dirección no es la que calculó esta app',
    FACTORY_PREDICTION: 'la factory calcula otra dirección para estas claves',
    ROLES: 'las claves registradas en el Guard no son las esperadas',
    NONCE: 'la Safe recién creada ya tiene operaciones',
    USER_KEY: 'tu clave U no es la U vigente de la Safe',
  };
  return texts[item] ?? item;
}
