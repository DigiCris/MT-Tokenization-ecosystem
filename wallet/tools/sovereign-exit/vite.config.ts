// Build de la herramienta de salida soberana (P19.T09): un único archivo `dist/sovereign-exit.html`, reproducible (sin
// fechas ni nombres aleatorios: mismo commit → mismos bytes), con el JS y el CSS inline y una CSP en <meta> que sólo
// habilita esos dos bloques por su SHA-256. Sin assets externos ni fuentes: funciona desde el disco del usuario
// (file://) y sólo se conecta al RPC que el usuario escriba.
import { createHash } from 'node:crypto';
import { defineConfig, type Plugin, type UserConfig } from 'vite';

export const OUTPUT = 'sovereign-exit.html';

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

export function csp(script: string, style: string): string {
  return [
    "default-src 'none'",
    `script-src ${sha256(script)}`,
    `style-src ${sha256(style)}`,
    // El RPC lo elige el usuario (https, o http para un nodo propio): es lo único con lo que habla la herramienta.
    'connect-src https: http:',
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

/** Junta el chunk y el CSS del build en el HTML y emite sólo `sovereign-exit.html`. */
function singleFile(): Plugin {
  return {
    name: 'mtw:single-file',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html'];
      if (page?.type !== 'asset') throw new Error('falta index.html en el bundle');
      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
      const styles = Object.values(bundle).filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'));
      if (chunks.length !== 1 || styles.length !== 1) throw new Error('se esperaba un único chunk y un único CSS');
      const [chunk] = chunks;
      const [css] = styles;
      if (chunk?.type !== 'chunk' || css?.type !== 'asset') throw new Error('bundle inesperado');
      // `</script` dentro del código cortaría el bloque: `<\/script` es el mismo string para JS.
      const script = chunk.code.replace(/<\/script/gi, '<\\/script');
      const style = String(css.source);
      let html = String(page.source)
        .replace(/<script type="module" crossorigin src="[^"]+"><\/script>\n?/, '')
        .replace(/<link rel="stylesheet" crossorigin href="[^"]+">\n?/, '');
      // Funciones de reemplazo: un string de reemplazo interpretaría los `$&`, `$'`… del código minificado.
      html = html
        .replace(
          '<meta charset="utf-8" />',
          () =>
            `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp(script, style)}" />`,
        )
        .replace('</head>', () => `<style>${style}</style>\n  </head>`)
        .replace('</body>', () => `<script type="module">${script}</script>\n  </body>`);
      for (const name of Object.keys(bundle)) Reflect.deleteProperty(bundle, name);
      this.emitFile({ type: 'asset', fileName: OUTPUT, source: html });
    },
  };
}

export default defineConfig((): UserConfig => ({
  base: './',
  plugins: [singleFile()],
  build: {
    target: 'es2024',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    reportCompressedSize: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
}));
