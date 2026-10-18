# ADR-013 — Criptografía del cliente

- **Estado:** Aceptada; regla de fallback aplicada el 2026-10-18 (P17.T08): Argon2id de Wallet con `hash-wasm` 4.12.0
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-013), §3.5 (Argon2id browser, wordlist 2^16), §5.1 (regla 1), §7.15 ([W-06]), §8.1 ([F-KEY-01] a [F-KEY-07]), §8.5 ([F-SEC-01], [F-SEC-02], [F-SEC-09]); V9 §4, §5; prompt §8, §9

## Contexto

V9 §4 fija la generación de U (`crypto.getRandomValues()` → 256 bits → clave privada secp256k1) y su protección: KDF Argon2id con salt de 128 bits, salida de 256 bits y baseline de 64 MiB, 3 iteraciones y parallelism 4 (128–256 MiB en desktop cuando sea viable); cifrado AES-256-GCM con nonce de 96 bits nuevo por cifrado; AAD de `U.enc` con formatVersion, platformId, chainId, walletId, role, keyAddress y keyVersion; U descifrada sólo durante la operación y descartada best-effort. V9 §5 aplica el mismo esquema a R (`HKDF-SHA256("R-encryption-v1")`). El backup humano (V9, página 4) usa Passwords U/R de 5 palabras de una wordlist pública, normalizada, versionada e inmutable de 65.536 entradas (≈ 80 bits) y un backup directo de clave privada de 16 palabras de 16 bits más 1 palabra de versión/checksum.

El prompt §8 exige que U sea una EOA secp256k1 generada client-side con CSPRNG, con Password U independiente, Argon2id + AES-256-GCM y descifrado sólo para firmar, sin enviarla nunca al backend ni guardarla en claro; el §9 pide lo mismo para R.

Hechos verificados (§3.5): `@noble/hashes` 2.4.0 (2026-08-27) tiene `argon2id` estable desde 1.6.0, en JavaScript puro; `hash-wasm` 4.12.0 no tiene releases desde 2024-11; `niceware` 4.0.0 (MIT) ofrece 65.536 palabras únicas `[a-z]+`, ordenadas, con SHA-256 `c2bf4e5b768581bc101620e9ec735e1b91b9b3e33d10535c5fbcada87b1e7e1e` (una por línea, LF final).

## Decisión

Criptografía cliente: CSPRNG de WebCrypto; secp256k1 con `@noble/curves`; Argon2id con `@noble/hashes` en un Web Worker, **64 MiB / t=3 / p=4** (presupuesto: desbloqueo ≤ 3 s p95 en el perfil móvil de referencia; si no se cumple, en Wallet se adopta `hash-wasm` 4.12.0 fijado tras revisión, y Recovery no habilita WASM y acepta el desbloqueo más lento); HKDF y AES-256-GCM con WebCrypto; wordlist `MTW-WORDLIST-V1` = niceware 4.0.0 (2^16).

Detalle ([F-KEY]):

- **Generación** ([F-KEY-01]): `crypto.getRandomValues(new Uint8Array(32))`, validación del escalar `1 ≤ k < n` con `@noble/curves` y reintento si es inválido; dirección con viem `publicKeyToAddress`; nunca `Math.random`.
- **Passwords U/R** ([F-KEY-02]): 5 palabras uniformes de `MTW-WORDLIST-V1` (≈ 80 bits) generadas por la app; confirmación reingresando 2 palabras al azar; nunca se envían al backend ni se persisten.
- **Derivación** ([F-KEY-03]): `Root_X = Argon2id(password, salt = 16 bytes aleatorios, m, t=3, p=4, outLen=32)` con `m = 64 MiB` para todo sobre; para U existe una opción avanzada de 128 MiB en desktop, desactivada por defecto y con advertencia de que ese sobre puede no abrir en móviles; R siempre usa 64 MiB. Luego `K_U = HKDF-SHA256(Root_U, salt="mtw-hkdf-v1", info="U-encryption-v1", 32)`, `AuthSecret_U = HKDF-SHA256(Root_U, salt="mtw-hkdf-v1", info="U-auth-v1", 32)` y `K_R = HKDF-SHA256(Root_R, salt="mtw-hkdf-v1", info="R-encryption-v1", 32)`. Argon2id corre en un Web Worker dedicado del mismo origin con `argon2idAsync`.
- **Sobre `X.enc`** ([F-KEY-04], [W-06]): JSON `formatVersion: 1` con `kdf` (`argon2id`, version 19, memoryKiB, iterations, parallelism, salt) y `cipher` (`AES-256-GCM`, nonce de 12 bytes nuevo por cifrado); AAD = UTF-8 de `mtw-key-envelope|1|{platformId}|{chainId}|{walletId}|{role}|{keyAddress en minúsculas}|{keyVersion}`; tras descifrar se verifica que la dirección derivada sea igual a `keyAddress`.
- **Vida en memoria** ([F-KEY-05]): `K_U` se importa como `CryptoKey` AES-GCM no exportable y los bytes crudos se sobrescriben; U se descifra sólo para cada firma, se firma con `@noble/curves` sobre el hash EIP-712 calculado con viem y el `Uint8Array` se sobrescribe con ceros (best-effort).
- **Backup humano de la clave** ([F-KEY-06]): 16 palabras (16 bits cada una) + 1 palabra de versión/checksum, `w17 = (version(4 bits) << 12) | checksum12`, con `checksum12` = primeros 12 bits de `SHA-256("MTW-KEY-BACKUP-V1|" ‖ rol ‖ "|" ‖ clave)`.
- **Prohibiciones** ([F-KEY-07]): U y R en texto plano nunca van a `localStorage`, `sessionStorage`, IndexedDB, cookies, logs, analytics ni observabilidad; sólo los sobres cifrados pueden cachearse en IndexedDB.
- **Wordlist:** vendorizada como `config/wordlist/mtw-wordlist-v1.txt` con su `.sha256` y la licencia MIT de niceware; es inmutable.
- **Implementación separada:** cada frontend implementa su capa criptográfica mínima por separado (§5.1, regla 1); sólo comparten vectores de test, copiados con hash.

## Resultado de la medición (P17.T08, 2026-10-18)

Método: `pnpm --dir frontend/wallet test:browser -- perf/argon2` (`scripts/perf-browser.mjs`) en el job
`wallet-frontend-wallet` de GitHub Actions (runner `ubuntu-24.04`, imagen 20261012.601). La pantalla `/device-check` del
build deriva 12 veces con los parámetros de los sobres (64 MiB, t=3, p=4) en el worker real de la app, cargado por la
política de Trusted Types, dentro de la imagen fijada de Playwright 1.64.0 con `--cpus 0.25`: Chromium con emulación de
Pixel 7 y WebKit con emulación de iPhone 14. La CPU 4× la pone la cuota de Docker, verificada antes de medir con un
bucle de un hilo (columna "Calibración": sin límite → con el límite). El throttling de CPU de DevTools no alcanza a los
workers dedicados y WebKit no tiene uno propio; Docker rootless sin cgroups ignora la cuota, por eso la medición válida
es la de CI (en local el script lo informa y no mide).

| Implementación (commit) | Navegador (perfil) | Calibración | Mediana | p95 | Presupuesto (3 s p95) |
|---|---|---|---|---|---|
| `@noble/hashes` 2.4.0, JS puro (`d66f125`) | Chromium (Pixel 7) | 4812 → 19455 ms (4,04×) | 4,52 s | 4,90 s | excedido |
| `@noble/hashes` 2.4.0, JS puro (`d66f125`) | WebKit (iPhone 14) | 4812 → 19455 ms (4,04×) | 8,11 s | 8,72 s | excedido |
| `hash-wasm` 4.12.0, WASM (`a0f6ad9`) | Chromium (Pixel 7) | 3461 → 13759 ms (3,98×) | 0,92 s | 1,11 s | cumple |
| `hash-wasm` 4.12.0, WASM (`a0f6ad9`) | WebKit (iPhone 14) | 3461 → 13759 ms (3,98×) | 2,62 s | 2,81 s | cumple |

Los runners compartidos de GitHub no son todos iguales (el bucle de calibración tardó 4812 ms en una corrida y 3461 ms
en la otra): escalado a la corrida más lenta, `@noble/hashes` sigue fuera del presupuesto en los dos navegadores y
`hash-wasm` queda holgado en Chromium y cerca del límite en WebKit (≈ 3,9 s). No hay otra palanca dentro de este ADR
(64 MiB, t=3, p=4 es el baseline de V9): el test registra el p95 en cada corrida de CI (línea `argon2id-perf` de la
salida del job) sin fallar por el presupuesto.

Decisión aplicada (regla de fallback de este ADR): el worker de Wallet usa `hash-wasm` 4.12.0 (MIT, sin dependencias ni
scripts de instalación; integridad en docs/VERSIONS.md). Revisión: sólo usa `WebAssembly.compile`/`instantiate` sobre
el WASM embebido en el JS (sin `eval`, sinks de HTML ni red) y, con `sideEffects: false`, el chunk del worker incluye
sólo Argon2 y BLAKE2b; corre bajo el `'wasm-unsafe-eval'` que la CSP de Wallet ya tenía por OPAQUE. La password copiada
a la memoria del WASM no se puede sobrescribir desde JS, pero el worker se termina después de cada derivación. Es el
mismo Argon2id v1.3: los sobres creados con `@noble/hashes` abren igual. Verificación
(`test/unit/argon2-protocol.test.ts`, `src/crypto/vectors.test.ts`): vectores de la implementación de referencia
(phc-winner-argon2), igualdad con la implementación nativa de Node/OpenSSL —validada con el vector de RFC 9106 §5.3,
que hash-wasm no puede reproducir porque no admite datos asociados— y con `@noble/hashes` con los parámetros de los
sobres, y los vectores de sobres de contracts/ (Root de Argon2id). Recovery mantiene `@noble/hashes` y su CSP sin WASM:
con el perfil de referencia el desbloqueo de R tarda lo medido arriba (≈ 4,9 s p95 en Chromium y 8,7 s en WebKit), lo
que este ADR acepta.

## Alternativas consideradas

- **`hash-wasm` 4.12.0 como implementación principal de Argon2id:** descartada porque no tiene releases desde 2024-11 (§3.5); queda sólo como alternativa en Wallet, fijada tras revisión, si `@noble/hashes` no cumple el presupuesto de 3 s p95.
- **128 MiB para R:** descartado; R usa siempre 64 MiB porque la recuperación puede ocurrir en cualquier dispositivo ([F-KEY-03]).
- **WASM en Recovery para acelerar Argon2id:** no se habilita; Recovery mantiene su CSP sin WASM y acepta un desbloqueo más lento.

## Consecuencias

- Se usan librerías mantenidas que ya están en el árbol de dependencias de viem (§4).
- Argon2id en JavaScript puro puede ser lento en móviles: el presupuesto se mide en P17.T08 (Playwright con emulación móvil y throttling de CPU 4×, en Chromium y WebKit) y el p95 se registra en este ADR, aplicando la regla de fallback si supera 3 s.
- Un sobre de U creado con la opción de 128 MiB puede no abrir en un móvil; por eso la opción viene desactivada y advertida.
- La wordlist es parte del formato de las Passwords y del backup de 17 palabras: es versionada e inmutable, por lo que cualquier cambio exige publicar una versión nueva y nunca editar `MTW-WORDLIST-V1`.
- La zeroización es best-effort: reduce, pero no elimina, la exposición de U en memoria mientras dura cada firma ([F-KEY-05]).
- Los upgrades de `@noble/*`, `viem` o `@scure/*` se publican en Wallet y Recovery con al menos 72 h de diferencia ([F-SEC-09]); el worker de Argon2id se carga bajo Trusted Types forzado con una allowlist de URLs generada en build ([F-SEC-02]).

## Verificación

- P01.T08 — wordlist niceware 4.0.0 vendorizada: 65.536 entradas únicas `[a-z]+`, ordenadas y con el hash exacto (`node scripts/verify-wordlist.mjs`).
- P01.TST y P01.SEC — verificación de wordlist, licencia y hash.
- P17.T04 — módulo `crypto/` con vectores RFC 9106 (Argon2id), RFC 5869 (HKDF), AES-GCM con AAD y backup de 17 palabras.
- P17.T08 — medición del p95 de Argon2id en el perfil móvil de referencia, registrada en este ADR.
- P17.TST — alteración de AAD o ciphertext falla, password errónea falla sin oráculo y el checksum de 17 palabras detecta errores de tipeo.
- P17.SEC — búsqueda automática de U y Password U en requests y storages (canario).
- P19.T02 — `crypto/` de Recovery implementado por separado con los mismos vectores (copia propia con hash).
- P16.T04 — el worker de Argon2id carga con Trusted Types forzado.
- P22.T03 — U, R y Passwords U/R ausentes de todos los storages y requests.
- Trazabilidad: RQ-29, RQ-30, RQ-79.
