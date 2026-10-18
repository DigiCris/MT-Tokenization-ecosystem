// Servicios de la app (una instancia por pestaña): cliente de la API de este listener, Drive con el token en memoria,
// Argon2id en el worker de la allowlist y la wordlist verificada del propio origin.
import { ApiClient } from '../api/client.ts';
import { WalletApi } from '../api/wallet-api.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { appConfig, systemContracts } from '../config/index.ts';
import { DriveClient } from '../drive/client.ts';
import type { OAuthClientConfig } from '../drive/oauth.ts';
import { driveToken } from '../drive/token.ts';
import { runArgon2id } from '../workers/argon2-client.ts';

export const api = new WalletApi(new ApiClient({ baseUrl: appConfig.apiBaseUrl }));

export const drive = new DriveClient(() => driveToken());

export const driveOAuth: OAuthClientConfig | null =
  appConfig.googleClientId === null
    ? null
    : { clientId: appConfig.googleClientId, redirectUri: appConfig.googleRedirectUri };

/** Argon2id en el worker dedicado (Trusted Types): la password viaja transferida y el worker se termina al responder. */
export const argon2: Argon2 = async (input) => (await runArgon2id(input)).key;

export const walletFactory = systemContracts.contracts.factory.address;
