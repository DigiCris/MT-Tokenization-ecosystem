// ESLint de la herramienta de salida soberana: typescript-eslint strict con tipos y las prohibiciones de [F-SEC] que
// aplican a una página que tiene U y R en memoria: nada de sinks de HTML (innerHTML, insertAdjacentHTML, document.write),
// eval ni new Function, ni Web Storage (las claves y los sobres nunca se guardan).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ROOT = import.meta.dirname;

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'node_modules/', 'test-results/', 'playwright-report/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json', './tsconfig.node.json'], tsconfigRootDir: ROOT },
    },
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
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Asignar innerHTML/outerHTML está prohibido: el DOM se arma con createElement y textContent.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(insertAdjacentHTML|setHTMLUnsafe|createContextualFragment)$/]',
          message: 'Los sinks de HTML están prohibidos.',
        },
        {
          selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
          message: 'document.write está prohibido.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'La herramienta no guarda nada: ni claves ni sobres.' },
        { name: 'sessionStorage', message: 'La herramienta no guarda nada: ni claves ni sobres.' },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/**', 'test/**', '*.config.ts', '*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
