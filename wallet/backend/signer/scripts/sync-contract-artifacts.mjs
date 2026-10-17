#!/usr/bin/env node
// Copia propia del signer de los artefactos de contratos (§10 regla 2, §7.15; independiente de la del backend):
//
// - contracts/test/vectors/**.json → test/vectors/ (byte a byte) + test/vectors/SHA256SUMS
// - contracts/out-abi/*.json → src/chain/abis/<nombre>.ts (`export const <nombre>Abi = [...] as const`, tipado para viem)
//
// `--check` no escribe: falla si alguna copia difiere de la fuente (lo corren CI y test/chain/artifacts-sync.test.ts).
// Uso (desde wallet/backend/signer): node scripts/sync-contract-artifacts.mjs [--check]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = resolve(ROOT, '../../contracts');
const VECTORS_SRC = join(CONTRACTS, 'test/vectors');
const ABIS_SRC = join(CONTRACTS, 'out-abi');
const VECTORS_DST = join(ROOT, 'test/vectors');
const ABIS_DST = join(ROOT, 'src/chain/abis');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const camel = (name) => name.charAt(0).toLowerCase() + name.slice(1);

function listJson(dir, base = dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return listJson(path, base);
      return name.endsWith('.json') ? [relative(base, path)] : [];
    })
    .sort();
}

export function expectedArtifacts() {
  const files = new Map();
  const sums = [];
  for (const rel of listJson(VECTORS_SRC)) {
    const content = readFileSync(join(VECTORS_SRC, rel));
    files.set(join('test/vectors', rel), content);
    sums.push(`${sha256(content)}  ${rel}`);
  }
  files.set('test/vectors/SHA256SUMS', Buffer.from(`${sums.join('\n')}\n`));
  const exports = [];
  for (const rel of listJson(ABIS_SRC)) {
    const name = rel.replace(/\.json$/, '');
    const source = readFileSync(join(ABIS_SRC, rel));
    const constName = `${camel(name)}Abi`;
    files.set(
      join('src/chain/abis', `${name}.ts`),
      Buffer.from(
        `// Generado por scripts/sync-contract-artifacts.mjs desde contracts/out-abi/${rel} (sha256 ${sha256(source)}).\n` +
          `// No editar: regenerar con \`pnpm sync:contracts\`.\n` +
          `export const ${constName} = ${JSON.stringify(JSON.parse(source.toString('utf8')), null, 2)} as const;\n`,
      ),
    );
    exports.push(`export { ${constName} } from './${name}.ts';`);
  }
  files.set(
    'src/chain/abis/index.ts',
    Buffer.from(`// Generado por scripts/sync-contract-artifacts.mjs. No editar.\n${exports.join('\n')}\n`),
  );
  return files;
}

function existingFiles() {
  const out = [];
  for (const [dir, prefix] of [
    [VECTORS_DST, 'test/vectors'],
    [ABIS_DST, 'src/chain/abis'],
  ]) {
    if (!existsSync(dir)) continue;
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const path = join(d, name);
        if (statSync(path).isDirectory()) walk(path);
        else out.push(join(prefix, relative(dir, path)));
      }
    };
    walk(dir);
  }
  return out.sort();
}

export function diffArtifacts() {
  const expected = expectedArtifacts();
  const problems = [];
  for (const [rel, content] of expected) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) problems.push(`falta ${rel}`);
    else if (!readFileSync(path).equals(content)) problems.push(`difiere ${rel}`);
  }
  for (const rel of existingFiles()) if (!expected.has(rel)) problems.push(`sobra ${rel}`);
  return problems;
}

function main() {
  if (process.argv.includes('--check')) {
    const problems = diffArtifacts();
    if (problems.length > 0) {
      for (const p of problems) console.error(`ARTEFACTOS DE CONTRATOS: ${p}`);
      console.error('Regenerar con: pnpm --dir backend/signer sync:contracts');
      process.exit(1);
    }
    console.log('ARTEFACTOS DE CONTRATOS OK: vectores y ABIs iguales a la fuente');
    return;
  }
  rmSync(VECTORS_DST, { recursive: true, force: true });
  rmSync(ABIS_DST, { recursive: true, force: true });
  for (const [rel, content] of expectedArtifacts()) {
    const path = join(ROOT, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log('artefactos de contratos sincronizados (test/vectors, src/chain/abis)');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
