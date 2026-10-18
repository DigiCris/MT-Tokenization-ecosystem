// Vite de la app Recovery (P16): build reproducible (nombres por hash de contenido, sin sourcemaps ni assets inline, sin
// polyfill de modulepreload), SRI, contratos del sistema y configuración pública por entorno, release manifest y headers
// de seguridad también en `vite preview`. JSX con el transform nativo de Vite (Oxc, runtime automático): sin
// @vitejs/plugin-react, cuyo preámbulo inline de React Refresh no cabe en la CSP `script-src 'self'`.
import { defineConfig, type UserConfig } from 'vite';
import { appConfigPlugin } from './build/app-config.ts';
import { loadBuildConfig } from './build/config.ts';
import { securityHeadersPlugin } from './build/headers.ts';
import { manifestPlugin } from './build/manifest.ts';
import { sriPlugin } from './build/sri-plugin.ts';
import { systemContractsPlugin } from './build/system-contracts.ts';

export default defineConfig((): UserConfig => {
  const config = loadBuildConfig();
  return {
    appType: 'spa',
    publicDir: 'public',
    oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
    plugins: [
      appConfigPlugin(config),
      systemContractsPlugin(config),
      securityHeadersPlugin(config),
      sriPlugin(),
      manifestPlugin(config),
    ],
    worker: { format: 'es' },
    build: {
      target: 'es2024',
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      // Fuentes e imágenes siempre como archivos con hash: nada de data: URIs (font-src 'self').
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      reportCompressedSize: false,
      rolldownOptions: {
        onLog(level, log, handler) {
          // React Router marca sus módulos con "use client" (React Server Components): en una SPA no aplica.
          if (log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('"use client"')) return;
          handler(level, log);
        },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
    server: { port: 5174, strictPort: true, hmr: { overlay: false } },
    preview: { port: Number(process.env.MTW_PREVIEW_PORT ?? 4174), strictPort: true },
  };
});
