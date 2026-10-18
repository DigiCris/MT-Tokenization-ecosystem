# Design tokens

Look & feel común de Wallet y Recovery **sólo como CSS** (P16.T01, V9 §17): variables, fuentes self-hosted y sus
licencias. No hay código ni paquete npm compartido entre las dos apps: cada una copia estos archivos en su build y
verifica el SHA-256 de cada uno contra su propio `design-tokens.lock.json`.

| Archivo | Contenido |
|---|---|
| `tokens.css` | Variables `--mtw-*`: tinta, superficies y líneas; marca y estados (éxito, aviso, peligro, foco); acento propio de Recovery (`--mtw-color-recovery`) para distinguir la app; tipografía, escala de espaciado de 4 px, radios, sombras y anchos de layout; `@font-face` de las dos fuentes. |
| `fonts/inter-latin-wght-normal.woff2` | Inter Variable (pesos 100–900, subset latin). |
| `fonts/jetbrains-mono-latin-wght-normal.woff2` | JetBrains Mono Variable (pesos 100–800, subset latin), para direcciones, hashes y códigos. |
| `LICENSES` | Procedencia exacta de cada fuente y el texto de la SIL Open Font License 1.1 de cada una. |

## Procedencia de las fuentes

Los `.woff2` son los de `@fontsource-variable/inter@5.3.0` y `@fontsource-variable/jetbrains-mono@5.3.0` del registry
de npm (integridad sha512 del tarball verificada al descargarlos; detalle en `LICENSES`):

| Fuente | SHA-256 del `.woff2` |
|---|---|
| Inter Variable | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| JetBrains Mono Variable | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |

Las apps las sirven desde su propio origin (`font-src 'self'`, sin CDNs ni Google Fonts) y publican las licencias en
`/licenses/fonts.txt` de cada build.

## Cómo las adopta cada app

```bash
node frontend/wallet/scripts/sync-design-tokens.mjs           # verifica la fuente y copia a src/styles/design-tokens/
node frontend/wallet/scripts/sync-design-tokens.mjs --check   # sólo verifica (fuente y copia) contra el lock de la app
node frontend/wallet/scripts/sync-design-tokens.mjs --pin     # adopta un cambio intencional: reescribe el lock
```

(Ídem con `frontend/recovery`.) El build, `dev` y `test:browser` de cada app corren la copia verificada; la copia
(`src/styles/design-tokens/`) no se versiona. Un cambio en esta carpeta hace fallar el `--check` de las dos apps hasta
que cada una lo adopte con `--pin` en un commit revisado por su dominio (CODEOWNERS).
