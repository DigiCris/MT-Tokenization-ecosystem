// Access token de Drive de Recovery ([F-DRV-01]): sólo en memoria de la pestaña, hasta su `expires_in` (con margen); sin
// refresh tokens. Al bloquear o cerrar sesión se revoca en Google (`POST /revoke`) y se descarta.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Margen para no usar un token a punto de vencer en medio de una subida. */
const EXPIRY_MARGIN_MS = 60_000;

export interface DriveToken {
  accessToken: string;
  expiresAt: number;
}

let current: DriveToken | null = null;

export function setDriveToken(token: DriveToken): void {
  current = token;
}

/** El token vigente o null (vencido o nunca conectado). */
export function driveToken(now: number = Date.now()): string | null {
  if (current === null) return null;
  if (now >= current.expiresAt - EXPIRY_MARGIN_MS) {
    current = null;
    return null;
  }
  return current.accessToken;
}

export function hasDriveToken(now: number = Date.now()): boolean {
  return driveToken(now) !== null;
}

/** Descarta el token y lo revoca en Google (best-effort: si falla la red, igual queda descartado en memoria). */
export async function revokeDriveToken(fetcher: typeof fetch = fetch): Promise<void> {
  const token = current?.accessToken;
  current = null;
  if (token === undefined) return;
  try {
    await fetcher(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    });
  } catch {
    // El token vence solo (≤ 1 h); en memoria ya no existe.
  }
}
