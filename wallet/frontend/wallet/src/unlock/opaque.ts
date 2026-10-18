// Cliente OPAQUE ([B-PSES-02], ADR-008): @serenity-kit/opaque (WASM embebido; la CSP de Wallet permite
// 'wasm-unsafe-eval' sólo por esto, [F-SEC-01]) cargado bajo demanda en su propio chunk. La password de OPAQUE es
// AuthSecret_U en hex minúscula (nunca la Password U); el key stretching de OPAQUE es Argon2id 16 MiB/t=1/p=1, el mismo
// que exige el backend al registrar y al desbloquear.
import type * as Opaque from '@serenity-kit/opaque';
import { toHex } from '../crypto/bytes.ts';

export const OPAQUE_KEY_STRETCHING = { 'argon2id-custom': { memory: 16384, iterations: 1, parallelism: 1 } } as const;

type OpaqueModule = typeof Opaque;
let loading: Promise<OpaqueModule> | null = null;

async function opaque(): Promise<OpaqueModule> {
  loading ??= import('@serenity-kit/opaque').then(async (module) => {
    await module.ready;
    return module;
  });
  return loading;
}

/** Entrada de OPAQUE: hex de AuthSecret_U sin prefijo. */
export function opaquePassword(authSecret: Uint8Array): string {
  if (authSecret.length !== 32) throw new TypeError('AuthSecret_U tiene 32 bytes');
  return toHex(authSecret).slice(2);
}

export interface RegistrationStart {
  registrationRequest: string;
  finish: (registrationResponse: string) => string;
}

/** Registro OPAQUE (paso 1 del cliente); `finish` arma el registrationRecord con la respuesta del servidor. */
export async function startRegistration(authSecret: Uint8Array): Promise<RegistrationStart> {
  const module = await opaque();
  const password = opaquePassword(authSecret);
  const { clientRegistrationState, registrationRequest } = module.client.startRegistration({ password });
  return {
    registrationRequest,
    finish: (registrationResponse) =>
      module.client.finishRegistration({
        clientRegistrationState,
        registrationResponse,
        password,
        keyStretching: OPAQUE_KEY_STRETCHING,
      }).registrationRecord,
  };
}

export interface LoginStart {
  startLoginRequest: string;
  /** null si la respuesta del servidor no corresponde a esta password (OPAQUE no revela por qué). */
  finish: (loginResponse: string) => { finishLoginRequest: string; sessionKey: string } | null;
}

export async function startLogin(authSecret: Uint8Array): Promise<LoginStart> {
  const module = await opaque();
  const password = opaquePassword(authSecret);
  const { clientLoginState, startLoginRequest } = module.client.startLogin({ password });
  return {
    startLoginRequest,
    finish: (loginResponse) => {
      const result = module.client.finishLogin({
        clientLoginState,
        loginResponse,
        password,
        keyStretching: OPAQUE_KEY_STRETCHING,
      });
      return result ? { finishLoginRequest: result.finishLoginRequest, sessionKey: result.sessionKey } : null;
    },
  };
}

/** Registro completo contra la API: paso 1 del cliente, respuesta del servidor y registrationRecord. */
export async function registerOpaque(
  authSecret: Uint8Array,
  serverResponse: (registrationRequest: string) => Promise<{ registrationResponse: string }>,
): Promise<string> {
  const start = await startRegistration(authSecret);
  const { registrationResponse } = await serverResponse(start.registrationRequest);
  return start.finish(registrationResponse);
}
