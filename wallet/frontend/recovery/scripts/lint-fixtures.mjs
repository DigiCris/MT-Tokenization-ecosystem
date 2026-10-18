#!/usr/bin/env node
// Cada archivo de lint-fixtures/ contiene un patrón prohibido por eslint.config.js (P16.T03) y declara en su primera
// línea la regla que lo tiene que detectar (`// expect: <regla>`). Falla si algún caso pasa el lint o lo detecta otra
// regla: así una prohibición no se puede desactivar sin que se note. Los casos se lintean sin información de tipos
// (no pertenecen a ningún tsconfig); las prohibiciones son sintácticas.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(APP_ROOT, 'lint-fixtures');

const untyped = tseslint.configs.disableTypeChecked;
const eslint = new ESLint({
  cwd: APP_ROOT,
  ignore: false,
  overrideConfig: [
    {
      ...untyped,
      files: ['lint-fixtures/**'],
      languageOptions: { ...untyped.languageOptions, globals: globals.browser },
    },
  ],
});

const fixtures = readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f));
if (fixtures.length === 0) {
  console.error('lint-fixtures/ vacío');
  process.exit(1);
}
let failed = 0;
for (const file of fixtures.sort()) {
  const path = join(DIR, file);
  const expected = /^\/\/ expect: (\S+)/.exec(readFileSync(path, 'utf8'))?.[1];
  if (!expected) {
    console.error(`FALLA ${file}: falta la línea "// expect: <regla>"`);
    failed += 1;
    continue;
  }
  const [result] = await eslint.lintFiles([path]);
  const rules = new Set((result?.messages ?? []).map((m) => m.ruleId ?? `parse: ${m.message}`));
  if (!rules.has(expected)) {
    console.error(`FALLA ${file}: se esperaba ${expected}, se obtuvo ${[...rules].join(', ') || 'ningún error'}`);
    failed += 1;
  }
}
if (failed > 0) process.exit(1);
console.log(`lint-fixtures OK: ${String(fixtures.length)} casos prohibidos detectados`);
