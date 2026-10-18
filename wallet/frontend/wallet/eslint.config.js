// ESLint de la app Wallet (P16.T03): typescript-eslint strict con tipos, reglas de hooks de React y las prohibiciones
// de [F-SEC]: dangerouslySetInnerHTML, innerHTML/outerHTML/insertAdjacentHTML y demás sinks de HTML, eval y
// new Function, localStorage/sessionStorage fuera de los módulos allowlisteados (sólo flags no sensibles y el `state`
// de OAuth), imports fuera del directorio de la app (salvo el CSS de los design tokens) y wagmi o conectores
// ([F-SEC-07]). Cada prohibición tiene un caso en lint-fixtures/ que tiene que fallar (scripts/lint-fixtures.mjs).
import { dirname, resolve, sep } from 'node:path';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const APP_ROOT = import.meta.dirname;
const TOKENS_CSS = resolve(APP_ROOT, '../design-tokens/tokens.css');

/** Módulos que pueden usar Web Storage: flags no sensibles y el `state` del viaje de OAuth (P17, ADR-012). */
export const STORAGE_ALLOWLIST = ['src/storage/flags.ts', 'src/drive/oauth-state.ts'];

const mtw = {
  rules: {
    'no-outside-imports': {
      meta: {
        type: 'problem',
        docs: { description: 'Sin imports fuera del directorio de la app (salvo el CSS de los design tokens)' },
        messages: { outside: 'Import fuera de frontend/wallet: {{source}}' },
        schema: [],
      },
      create(context) {
        const check = (node, source) => {
          if (typeof source !== 'string' || !source.startsWith('.')) return;
          const target = resolve(dirname(context.filename), source.split('?')[0]);
          if (target === APP_ROOT || target.startsWith(APP_ROOT + sep) || target === TOKENS_CSS) return;
          context.report({ node, messageId: 'outside', data: { source } });
        };
        return {
          ImportDeclaration: (node) => check(node, node.source.value),
          ImportExpression: (node) => node.source.type === 'Literal' && check(node, node.source.value),
          ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
          ExportAllDeclaration: (node) => check(node, node.source.value),
        };
      },
    },
  },
};

const EXTERNAL_WALLET_PACKAGES = [
  'wagmi',
  'wagmi/*',
  '@wagmi/*',
  '@walletconnect/*',
  '@reown/*',
  '@coinbase/*',
  '@metamask/*',
  '@tanstack/react-query',
];
/** [F-SEC-07]: la app Wallet no incluye wagmi ni conectores de wallets externas. */
const externalWalletImports = {
  patterns: [{ group: EXTERNAL_WALLET_PACKAGES, message: 'Wallet no incluye wagmi ni conectores ([F-SEC-07]).' }],
};

const HTML_SINKS = 'innerHTML|outerHTML';
const forbiddenSyntax = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML está prohibido (Trusted Types, [F-SEC-02]).',
  },
  {
    selector: `AssignmentExpression > MemberExpression.left[property.name=/^(${HTML_SINKS})$/]`,
    message: 'Asignar innerHTML/outerHTML está prohibido: construí el DOM con React.',
  },
  {
    selector: `AssignmentExpression > MemberExpression.left[computed=true][property.value=/^(${HTML_SINKS})$/]`,
    message: 'Asignar innerHTML/outerHTML está prohibido: construí el DOM con React.',
  },
  {
    selector:
      'CallExpression[callee.property.name=/^(insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|parseFromString)$/]',
    message:
      'Los sinks de HTML (insertAdjacentHTML, setHTMLUnsafe, createContextualFragment, parseFromString) están prohibidos.',
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: 'document.write está prohibido.',
  },
];

const storageGlobals = ['localStorage', 'sessionStorage'].map((name) => ({
  name,
  message: `${name} sólo en ${STORAGE_ALLOWLIST.join(' o ')} (flags no sensibles y state de OAuth, [F-KEY-07]).`,
}));
const storageProperties = ['window', 'globalThis', 'self'].flatMap((object) =>
  ['localStorage', 'sessionStorage'].map((property) => ({
    object,
    property,
    message: `${property} sólo en ${STORAGE_ALLOWLIST.join(' o ')} (flags no sensibles y state de OAuth, [F-KEY-07]).`,
  })),
);

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'node_modules/', 'test-results/', 'playwright-report/', 'lint-fixtures/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.worker.json', './tsconfig.node.json'],
        tsconfigRootDir: APP_ROOT,
      },
    },
    plugins: { mtw },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-restricted-syntax': ['error', ...forbiddenSyntax],
      'no-restricted-globals': ['error', ...storageGlobals],
      'no-restricted-properties': ['error', ...storageProperties],
      'no-restricted-imports': ['error', externalWalletImports],
      'mtw/no-outside-imports': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/workers/*.worker.ts'],
    languageOptions: { globals: globals.worker },
  },
  {
    files: STORAGE_ALLOWLIST,
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    // Los tests no se publican: leen el storage para probar que no queda nada sensible ([F-KEY-07], P22.T03).
    files: ['src/**/*.test.{ts,tsx}', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['build/**/*.ts', 'test/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
);
