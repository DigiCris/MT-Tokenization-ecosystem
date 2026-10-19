// Servicios de la app Recovery (uno por pestaña): cliente del API de Recovery con su reloj alineado al servidor, lector
// de Base por el RPC propio, Argon2id en el worker y la configuración fijada (contratos del sistema y cadena).
import { ApiClient } from '../api/client.ts';
import { RecoveryApi } from '../api/recovery-api.ts';
import { chainReader } from '../chain/client.ts';
import { pinnedChain } from '../config/chain.ts';
import { appConfig, systemContracts } from '../config/index.ts';
import type { Argon2 } from '../crypto/kdf.ts';
import { runArgon2id } from '../workers/argon2-client.ts';

export const api = new RecoveryApi(new ApiClient(appConfig.apiBaseUrl));

export const reader = chainReader(appConfig.rpcUrl);

export const pinned = { system: systemContracts, chain: pinnedChain };

/** Argon2id en el worker dedicado (un worker por derivación, se termina al responder). */
export const argon2: Argon2 = async (input) => (await runArgon2id(input)).key;
