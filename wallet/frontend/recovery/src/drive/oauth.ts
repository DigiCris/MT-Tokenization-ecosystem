// OAuth de Google para el Drive de Recovery sin JS de Google ([F-DRV-01], [F-DRV-03]: cliente OAuth propio de Recovery,
// otro proyecto de Google Cloud que el de Wallet, así que su carpeta privada es otra): flujo implícito
// (`response_type=token`) por redirección de página completa. La ida guarda `state` y la ruta de regreso; la vuelta
// (`/oauth/google/callback`) se procesa antes de renderizar: se lee el fragmento, se limpia con history.replaceState y
// el token queda sólo en memoria.
import { bytesToBase64Url } from '../crypto/encoding.ts';
import { readFlag, writeFlag } from '../storage/flags.ts';
import { saveOAuthState, takeOAuthState } from './oauth-state.ts';
import { DRIVE_SCOPE, setDriveToken } from './token.ts';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CALLBACK_PATH = '/oauth/google/callback';
const CONSENTED_FLAG = 'drive.consented';

export interface OAuthClientConfig {
  clientId: string;
  redirectUri: string;
}

export class DriveConnectError extends Error {
  override name = 'DriveConnectError';
  readonly reason: 'DENIED' | 'STATE_MISMATCH' | 'SCOPE' | 'MALFORMED' | 'NOT_CONFIGURED';

  constructor(reason: DriveConnectError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

/** URL de autorización; `prompt=consent` sólo la primera vez en este dispositivo. */
export function authorizationUrl(config: OAuthClientConfig, state: string, firstUse: boolean): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'token',
    scope: DRIVE_SCOPE,
    state,
    include_granted_scopes: 'false',
    ...(firstUse ? { prompt: 'consent' } : {}),
  }).toString();
  return url.toString();
}

/** Ida: guarda el estado y navega a Google. `returnTo` es una ruta de esta app (p. ej. `/restore`). */
export function startDriveConnect(
  config: OAuthClientConfig | null,
  returnTo: string,
  navigate: (url: string) => void = (url) => {
    window.location.assign(url);
  },
): void {
  if (config === null) {
    throw new DriveConnectError('NOT_CONFIGURED', 'Google Drive no está configurado en este entorno');
  }
  const state = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  saveOAuthState({ state, returnTo, createdAt: Date.now() });
  navigate(authorizationUrl(config, state, readFlag(CONSENTED_FLAG) !== 'yes'));
}

export interface CallbackResult {
  returnTo: string;
  connected: boolean;
  error: DriveConnectError | null;
}

/**
 * Vuelta: interpreta el fragmento del callback contra el estado guardado. Devuelve la ruta a la que volver; si el token
 * es válido queda en memoria. Un `state` que no coincide, un error de Google o un scope distinto lo descartan.
 */
export function completeDriveConnect(fragment: string, now: number = Date.now()): CallbackResult {
  const saved = takeOAuthState(now);
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  const returnTo = saved?.returnTo ?? '/';
  const fail = (reason: DriveConnectError['reason'], message: string): CallbackResult => ({
    returnTo,
    connected: false,
    error: new DriveConnectError(reason, message),
  });
  if (saved === null || params.get('state') !== saved.state) {
    return fail('STATE_MISMATCH', 'La respuesta de Google no corresponde a un pedido de esta pestaña');
  }
  const error = params.get('error');
  if (error !== null) {
    return fail('DENIED', error === 'access_denied' ? 'No autorizaste el acceso a Drive' : `Google respondió ${error}`);
  }
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in'));
  const scopes = (params.get('scope') ?? '').split(' ');
  if (
    accessToken === null ||
    !/^[A-Za-z0-9._~+/-]{20,4096}$/.test(accessToken) ||
    params.get('token_type')?.toLowerCase() !== 'bearer' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return fail('MALFORMED', 'La respuesta de Google no trae un token válido');
  }
  if (!scopes.includes(DRIVE_SCOPE) || scopes.length !== 1) {
    return fail('SCOPE', 'Google otorgó un permiso distinto del pedido (sólo la carpeta privada de la app)');
  }
  setDriveToken({ accessToken, expiresAt: now + expiresIn * 1000 });
  writeFlag(CONSENTED_FLAG, 'yes');
  return { returnTo, connected: true, error: null };
}

/** Error de la última vuelta de OAuth, para mostrarlo en la pantalla de destino. */
let lastError: DriveConnectError | null = null;

export function takeDriveConnectError(): DriveConnectError | null {
  const error = lastError;
  lastError = null;
  return error;
}

/**
 * En el arranque, antes de renderizar: si la URL es el callback, procesa el fragmento, limpia la URL con
 * history.replaceState (el token no queda en el historial ni en la barra) y deja la ruta de regreso como actual.
 */
export function handleOAuthCallback(location: Location = window.location, history: History = window.history): boolean {
  if (location.pathname !== CALLBACK_PATH) return false;
  const result = completeDriveConnect(location.hash);
  history.replaceState(null, '', result.returnTo);
  lastError = result.error;
  return true;
}
