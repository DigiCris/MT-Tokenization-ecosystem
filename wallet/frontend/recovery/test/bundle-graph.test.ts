// P16.T08 [F-SEC-07]: sobre el grafo real del build de Recovery, ni el chunk de entrada ni ningún chunk alcanzable desde
// él sin pasar por el chunk de wallet externa (los flujos de R interna) contiene módulos de wagmi, conectores,
// WalletConnect/Reown, Coinbase o MetaMask; esos módulos sólo viven detrás del import() de src/external-wallet/.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { build, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROOT } from '../build/config.ts';

/** Paquetes de wallet externa (también dentro del store de pnpm: node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>). */
const EXTERNAL_WALLET =
  /[\\/]node_modules[\\/](?:wagmi|@wagmi|@walletconnect|@reown|@coinbase|@metamask|@tanstack[\\/]react-query|mipd)[\\/]/;

interface ChunkInfo {
  fileName: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  modules: string[];
}

const chunks = new Map<string, ChunkInfo>();
const work = mkdtempSync(join(tmpdir(), 'mtw-recovery-graph-'));

function captureGraph(): Plugin {
  return {
    name: 'test:capture-graph',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        chunks.set(output.fileName, {
          fileName: output.fileName,
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          facadeModuleId: output.facadeModuleId,
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          modules: Object.keys(output.modules),
        });
      }
    },
  };
}

beforeAll(async () => {
  const tokens = spawnSync('node', ['scripts/sync-design-tokens.mjs'], { cwd: APP_ROOT, encoding: 'utf8' });
  if (tokens.status !== 0) throw new Error(`design tokens: ${tokens.stderr}`);
  await build({
    root: APP_ROOT,
    configFile: resolve(APP_ROOT, 'vite.config.ts'),
    logLevel: 'error',
    build: { outDir: join(work, 'dist'), emptyOutDir: true },
    plugins: [captureGraph()],
  });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const externalEntryPath = `${sep}src${sep}external-wallet${sep}index.ts`;

function externalEntry(): ChunkInfo {
  const chunk = [...chunks.values()].find((c) => c.facadeModuleId?.endsWith(externalEntryPath) === true);
  if (chunk === undefined) throw new Error('no hay chunk de src/external-wallet/index.ts');
  return chunk;
}

/** Chunks alcanzables desde la entrada (imports estáticos y dinámicos) sin entrar al chunk de wallet externa. */
function internalChunks(): ChunkInfo[] {
  const stop = externalEntry().fileName;
  const entry = [...chunks.values()].filter((c) => c.isEntry);
  const seen = new Set<string>();
  const queue = entry.map((c) => c.fileName);
  while (queue.length > 0) {
    const name = queue.shift() ?? '';
    if (seen.has(name) || name === stop) continue;
    seen.add(name);
    const chunk = chunks.get(name);
    if (chunk) queue.push(...chunk.imports, ...chunk.dynamicImports);
  }
  return [...seen].map((name) => chunks.get(name)).filter((c): c is ChunkInfo => c !== undefined);
}

describe('grafo del bundle de Recovery', () => {
  it('una sola entrada y el chunk de wallet externa es una entrada dinámica', () => {
    expect([...chunks.values()].filter((c) => c.isEntry)).toHaveLength(1);
    expect(externalEntry().isDynamicEntry).toBe(true);
    expect(externalEntry().isEntry).toBe(false);
  });

  it('la entrada y los flujos de R interna no contienen wagmi, conectores ni SDKs de wallets', () => {
    const internal = internalChunks();
    expect(internal.length).toBeGreaterThan(0);
    const leaked = internal.flatMap((c) =>
      c.modules.filter((m) => EXTERNAL_WALLET.test(m)).map((m) => `${c.fileName}: ${m}`),
    );
    expect(leaked).toEqual([]);
  });

  it('wagmi y los conectores viven detrás del import() de src/external-wallet/', () => {
    const internal = new Set(internalChunks().map((c) => c.fileName));
    const withExternal = [...chunks.values()].filter((c) => c.modules.some((m) => EXTERNAL_WALLET.test(m)));
    expect(withExternal.some((c) => c.modules.some((m) => /[\\/]@wagmi[\\/]core[\\/]/.test(m)))).toBe(true);
    expect(withExternal.some((c) => c.modules.some((m) => /[\\/]@wagmi[\\/]connectors[\\/]/.test(m)))).toBe(true);
    for (const chunk of withExternal) expect(internal.has(chunk.fileName), chunk.fileName).toBe(false);
  });

  it('MetaMask Connect (excluido, docs/CONNECTORS.md) no entra al bundle', () => {
    const metamask = [...chunks.values()].flatMap((c) =>
      c.modules.filter((m) => /[\\/]@metamask[\\/]connect-/.test(m)).map((m) => `${c.fileName}: ${m}`),
    );
    expect(metamask).toEqual([]);
  });
});
