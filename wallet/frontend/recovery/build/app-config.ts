// Configuración pública embebida en la app Recovery como el módulo virtual `virtual:mtw-config` (sólo valores públicos de
// build/config.ts: nunca secretos) y emisión de las licencias de las fuentes self-hosted en dist/licenses/fonts.txt
// (OFL 1.1, copiadas desde design-tokens por scripts/sync-design-tokens.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { APP_ROOT, type BuildConfig } from './config.ts';

const VIRTUAL_ID = 'virtual:mtw-config';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const FONT_LICENSES = resolve(APP_ROOT, 'src/styles/design-tokens/LICENSES');

export function publicConfig(config: BuildConfig) {
  return {
    app: config.app,
    environment: config.environment,
    platformId: config.platformId,
    apiBaseUrl: config.apiBaseUrl,
    rpcUrl: config.rpcUrl,
    walletOrigin: config.walletOrigin,
    googleClientId: config.googleClientId,
    googleRedirectUri: config.googleRedirectUri,
    walletConnectProjectId: config.walletConnectProjectId,
    releaseId: config.releaseId,
    gitCommit: config.gitCommit,
    sourceDateEpoch: config.sourceDateEpoch,
  };
}

export function appConfigPlugin(config: BuildConfig): Plugin {
  return {
    name: 'mtw:app-config',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      return id === RESOLVED_ID ? `export default Object.freeze(${JSON.stringify(publicConfig(config))});` : null;
    },
    generateBundle() {
      if (!existsSync(FONT_LICENSES))
        throw new Error('faltan las licencias de las fuentes: node scripts/sync-design-tokens.mjs');
      this.emitFile({ type: 'asset', fileName: 'licenses/fonts.txt', source: readFileSync(FONT_LICENSES) });
    },
  };
}
