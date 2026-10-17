# PLANNER — Wallet Web Self-Custodial (Safe 2-de-3 sobre Base)

| Campo | Valor |
|---|---|
| Documento | `wallet/docs/PLANNER_WALLET_WEB.md` |
| Versión del planner | 1.0 |
| Fecha de elaboración | 2026-10-16 |
| Branch de trabajo | `feat/walletWeb/cmarchese` |
| Especificación autoritativa | `documentacion/Wallet_Web_Self_Custodial_V9_Definitiva.pdf` (V9 Definitiva, 22-09-2026) |
| Requisitos de origen | `wallet/prompts/promptV1.md` |
| Contexto de negocio | `documentacion/DescripcionProyectoTokenizacion.pdf` (plataforma de tokenización multi-tenant; la wallet custodia USDC/USDT de inversores) |
| Raíz de todo lo que se construye | `wallet/` (contracts, backend, frontends, docs, scripts, infra) |
| Target de producción futuro | VPS Linux estándar (Hostinger), self-hosted con Docker; **ninguna fase despliega en la VPS** (el despliegue es manual, posterior, con `docs/DEPLOYMENT_VPS.md`) |
| Estado | Planner listo para ejecución. **No hay implementación de producto todavía.** |

> Criterio rector: el resultado final debe ser una wallet web **self-custodial real, production-grade y segura**. Este planner no acepta atajos de PoC: no hay mocks del funcionamiento blockchain, no hay simulaciones que reemplacen componentes reales y no se deja ninguna funcionalidad "falsa" a medio hacer. Desarrollo y tests corren contra un **fork reproducible de Base mainnet con Foundry/Anvil**, ejecutando contratos y flujos reales (Safe, USDC, USDT y Uniswap reales del fork).

---

## Índice

- [0. Cómo ejecutar este planner](#0-cómo-ejecutar-este-planner)
- [1. Estado del repositorio inspeccionado](#1-estado-del-repositorio-inspeccionado)
- [2. Fuentes, precedencia y conflictos detectados](#2-fuentes-precedencia-y-conflictos-detectados)
- [3. Hechos externos verificados](#3-hechos-externos-verificados)
- [4. Decisiones de arquitectura (ADR)](#4-decisiones-de-arquitectura-adr)
- [5. Arquitectura del sistema](#5-arquitectura-del-sistema)
- [6. Especificación on-chain](#6-especificación-on-chain)
- [7. Especificación backend y signer](#7-especificación-backend-y-signer)
- [8. Especificación de frontends](#8-especificación-de-frontends)
- [9. Threat model y assertions de seguridad](#9-threat-model-y-assertions-de-seguridad)
- [10. Estrategia de testing](#10-estrategia-de-testing)
- [11. Fases de ejecución](#11-fases-de-ejecución)
- [12. REQUIREMENTS TRACEABILITY](#12-requirements-traceability)
- [13. Registro de ejecución](#13-registro-de-ejecución)

---

## 0. Cómo ejecutar este planner

### 0.1 Reglas de ejecución

- **R-01** Trabajar siempre en el branch `feat/walletWeb/cmarchese`. Antes de cada sesión: `git rev-parse --abbrev-ref HEAD` debe devolver ese nombre.
- **R-02** Todo artefacto nuevo vive dentro de `wallet/`. `documentacion/` es **sólo lectura**. No se modifica ni se borra nada fuera de `wallet/` (landing, `src/`, `app/`, `package.json` raíz, etc.). Única excepción: `.github/workflows/wallet-*.yml` y `.github/CODEOWNERS` (GitHub sólo los lee desde la raíz), **aprobados por el owner el 2026-10-16** (P02).
- **R-03** Ejecutar las fases en orden. No se empieza una fase si el CHECKPOINT de la anterior no está completo, salvo que la fase indique explícitamente que puede correr en paralelo.
- **R-04** Cada tarea tiene un ID (`P07.T03`). Al terminarla y verificarla se cambia `[ ]` por `[x]` **en el mismo commit** que contiene el trabajo de esa tarea (o en el commit inmediatamente posterior si la tarea no produce archivos).
- **R-05** Una tarea sólo se marca `[x]` si su "Verificación" pasó. Si una verificación falla, la tarea queda `[ ]` y se documenta el fallo en el [Registro de ejecución](#13-registro-de-ejecución).
- **R-06** Nunca commitear secretos. `wallet/.env`, keystores, certificados privados y cualquier archivo bajo `wallet/.secrets/` están gitignored. Antes de cada commit: `gitleaks protect --staged --redact` (o `gitleaks git --staged` según la versión fijada en P01).
- **R-07** Commits profesionales, en formato Conventional Commits, **sin mencionar Claude, Anthropic, AI ni agregar `Co-Authored-By`/coautores**.
- **R-08** Push a `origin feat/walletWeb/cmarchese` como mínimo al cerrar cada CHECKPOINT.
- **R-09** Ninguna fase despliega en Base mainnet ni mueve fondos reales: staging y producción se despliegan y se prueban completos **sobre el fork de Anvil** (P25 y P30). El despliegue real —contratos en Base mainnet, servicios en la VPS, reverse proxy, DNS y TLS— es el **despliegue final**: manual, fuera del planner, con aprobación escrita del owner, siguiendo `docs/runbooks/go-live.md` y `docs/DEPLOYMENT_VPS.md`. Ninguna fase accede a la VPS.
- **R-10** No fijar versiones "de memoria": toda versión/dirección/codehash se verifica contra fuente oficial o lectura on-chain y se registra con fecha y URL (ver §3 y P01/P03).
- **R-11** Si algo obligatorio falta: primero **autodiscovery** (buscar en el repo y en la configuración existente, verificar on-chain, consultar documentación oficial) y **auto-remediación** (instalar la herramienta fijada en `wallet/.tools/`, generar el secreto); sólo si no se puede obtener así: **STOP**, informando qué falta, qué variable, cómo obtenerla y en qué sección de `wallet/docs/SETUP_EXTERNAL_SERVICES.md` ("USER ACTION REQUIRED") están los pasos. No continuar dejando funcionalidades falsas o desactivadas "temporalmente".
- **R-12** Toda decisión de diseño nueva que no esté en este planner se documenta como ADR en `wallet/docs/adr/` antes de implementarse. Las decisiones de implementación dentro de esta arquitectura no requieren aprobación; un cambio de arquitectura no se hace durante la ejecución (si resultara inevitable, es un STOP real con el motivo documentado).
- **R-13** Toda fase que crea o modifica un proyecto actualiza su script `wallet/ci/scripts/ci-<área>.sh` (y su workflow si P02 fue aprobado); el CHECKPOINT de cada fase exige `pnpm ci:local` en verde.
- **R-14** **Producto final, sin pendientes ni frenos.** Después de `PREFLIGHT PASSED` el planner corre de punta a punta (prompt §25) sin pedir nada al owner. Toda funcionalidad se implementa completa y se prueba contra los servicios reales: fork de Base mainnet con los contratos reales, Alchemy/QuickNode, relay de WalletConnect, API de Google Drive, API de Mailgun y entrega real de email a una casilla. Nada queda opcional, simulado ni diferido. Los `Pxx.MAN` los ejecuta el agente con herramientas (navegador automatizado, `cast`, `curl`) y, donde se pide un segundo par de ojos, un **agente revisor independiente** (contexto nuevo, sin el razonamiento del ejecutor) cuyo informe queda en §13. Fuera del planner queda sólo el despliegue final y la configuración de los servicios de staging/producción para los dominios reales (§13.1, `docs/runbooks/go-live.md`).

### 0.2 Formato de las tareas

```text
- [ ] **P07.T03** — Qué construir (archivos concretos), cómo se conecta, qué valida.
      Verificación: comando(s) exactos o check manual concreto.
```

Las subtareas usan sufijo de letra (`P07.T01.a`). Las referencias a especificación usan IDs de §6–§8 (por ejemplo `[C-GRD-05]`, `[B-NONCE-02]`, `[F-KEY-04]`).

En cada fase, además de las tareas `Pxx.Tyy`, son checkboxes las acciones de verificación: `Pxx.TST` (tests a implementar, con su comando), `Pxx.MAN` (checks manuales que ejecuta el propio agente con herramientas o un agente revisor independiente —R-14—, con resultado y evidencia en §13; ninguno requiere al owner) y `Pxx.SEC` (security checks). Toda tarea tiene una línea `Verificación:`; RES-4 re-ejecuta esas líneas.

### 0.3 Protocolo de reanudación (si la ejecución se detiene)

Ejecutar en este orden; no hace falta empezar desde el principio:

1. **RES-1** `git fetch origin && git checkout feat/walletWeb/cmarchese && git status --short` — si hay cambios sin commitear, **no descartarlos**: identificar a qué tarea pertenecen (diff + Registro de ejecución) y completarlos o commitearlos como WIP explícito (`chore(wip): ...`) sólo si están verdes.
1. **RES-2** `git pull --ff-only` (si falla por divergencia: STOP y pedir instrucción al owner).
1. **RES-3** Abrir este planner y ubicar la **primera tarea `[ ]`** de la fase en curso (la fase en curso es la primera cuyo CHECKPOINT no está completo).
1. **RES-4** Re-verificar las **últimas 3 tareas marcadas `[x]`** de esa fase (o de la anterior si la fase recién empieza) ejecutando sus comandos de "Verificación". Si alguna falla, desmarcarla y retomarla.
1. **RES-5** Si la fase en curso es ≥ P01: `cd wallet && pnpm preflight`. Si no imprime `PREFLIGHT PASSED`: resolver antes de seguir.
1. **RES-6** Leer la última entrada del [Registro de ejecución](#13-registro-de-ejecución) (fase, tarea, commit, notas de bloqueo).
1. **RES-7** Continuar desde la tarea identificada en RES-3.

### 0.4 Definición global de "Hecho" (aplica a toda tarea de código)

- Código + tests del alcance de la tarea, lint y typecheck en verde.
- Sin `TODO`/`FIXME` que oculten funcionalidad faltante (los TODO sólo se permiten con ID de tarea futura del planner).
- Sin secretos ni datos sensibles en logs (tests de canario de logs en verde desde P08).
- Documentación tocada si cambia comportamiento observable.
- Trazabilidad: si la tarea implementa un requisito de §12, el requisito queda cubierto por test.

### 0.5 Política de commits y push

- Un commit por tarea o grupo coherente de tareas; mensajes en inglés, Conventional Commits, scope por área: `contracts`, `backend`, `signer`, `wallet`, `recovery`, `infra`, `ci`, `docs`, `security`, `e2e`.
- Ejemplos de referencia (del prompt): `feat(wallet): add deterministic safe deployment`, `feat(auth): add account and session management`, `feat(recovery): add independent recovery frontend`, `feat(policy): add destination whitelist enforcement`, `feat(swap): add restricted usdc usdt swaps`, `test(security): add wallet invariants and adversarial tests`, `docs(wallet): add production deployment guide`.
- Push: `git push origin feat/walletWeb/cmarchese` al cerrar cada CHECKPOINT (y antes de pausas largas).
- Prohibido: `git push --force` sobre este branch sin aprobación del owner; reescribir historia ya pusheada; commits con secretos.

---

## 1. Estado del repositorio inspeccionado

Inspección realizada el 2026-10-16 sobre `main` (commit `4ed7bf4`) antes de crear el branch.

| Ítem | Hallazgo | Consecuencia para el planner |
|---|---|---|
| Raíz del repo | Mock comercial de la plataforma de tokenización: `index.html`, `landing.css`, `landing.js`, `app/index.html`, `src/*.jsx` (React + Vite en JS), `package.json` + `package-lock.json` (npm), `vite.config.js`. | Se deja intacto. No se reutiliza código (es un mock de UI sin seguridad). Se reutiliza la **elección tecnológica** (Vite + React) pero en TypeScript y con proyectos independientes dentro de `wallet/`. |
| `documentacion/` | `Wallet_Web_Self_Custodial_V9_Definitiva.pdf` (spec autoritativa, 10 páginas), `DescripcionProyectoTokenizacion.pdf` (contexto: PSAV, plataformas por cliente, USDC, KYC Bitbase, Caja de Valores), `readme.md`. | Sólo lectura. La V9 se leyó completa y gobierna el diseño (§2). |
| `wallet/` | Sólo `wallet/prompts/promptV1.md`. | Greenfield. Todo el producto se crea bajo `wallet/`. |
| Git | `main` limpio y sincronizado con `origin/main` (`https://github.com/DigiCris/MT-Tokenization-ecosystem.git`). Branch `feat/walletWeb/cmarchese` no existía: se creó desde `main`. | Todo el trabajo en ese branch. |
| CI existente | No hay `.github/`. | P02 crea CI; los archivos de la raíz (`.github/workflows/`, `.github/CODEOWNERS`) están aprobados por el owner. |
| Toolchain local detectada | Node v22.22.1, npm 10.9.4, pnpm 9.15.9, Foundry (forge/cast/anvil) 1.5.1-stable, Docker 29.6.2, Slither 0.10.4, gitleaks 8.30.1, Python 3.10, psql 14 (cliente). Sin `redis-cli` ni `jq`. | El preflight (P00) detecta las versiones y, si no coinciden con las fijadas (Node 26 LTS, pnpm 12.14.0, Foundry v1.8.5, Slither 0.11.6, gitleaks 8.30.1), las instala automáticamente como toolchain local del proyecto (`wallet/.tools/`, descargas oficiales verificadas por checksum, sin sudo, ADR-032); no son acciones manuales. `jq`/`redis-cli` no son requisitos (el preflight usa Node/Docker). |
| Posible Postgres local en 5432 | Hay cliente psql 14 instalado. | Los servicios de docker compose usan puertos no estándar (55432, 56379) para no colisionar. |

Restricciones operativas confirmadas:

1. Todo lo nuevo dentro de `wallet/` (backend, ambos frontends, contratos, docs, scripts, infra).
2. `documentacion/` es de sólo lectura.
3. El mock existente en la raíz no se toca.
4. Los únicos archivos fuera de `wallet/` que el proyecto necesita son `.github/workflows/wallet-*.yml` y `.github/CODEOWNERS`, aprobados por el owner (P02).
5. Producción futura: VPS Linux propia (Hostinger), self-hosted; no se usa ningún cloud como requisito y no se accede a la VPS durante este planner.

---

## 2. Fuentes, precedencia y conflictos detectados

### 2.1 Precedencia

1. **Especificación V9 Definitiva** (autoritativa en seguridad y arquitectura criptográfica).
2. **Prompt `wallet/prompts/promptV1.md`** (alcance funcional, stack preferido, entregables, gates).
3. **Este planner** (decisiones concretas que materializan 1 y 2).
4. ADRs posteriores aprobados por el owner (`wallet/docs/adr/`).

### 2.2 Conflictos/ambigüedades detectados y resolución adoptada

| ID | Conflicto | Resolución en este planner |
|---|---|---|
| CF-01 | V9 §17 pide **repositorio separado** para Wallet y Recovery; el owner pide que todo viva en `wallet/` de este repositorio. | Se desarrolla en `wallet/frontend/wallet` y `wallet/frontend/recovery` como **proyectos totalmente independientes** (package.json, lockfile, build, CI workflow, secretos, claves de release, proyecto de Google OAuth propios; sin workspace compartido ni imports cruzados; verificado por tests de frontera). `CODEOWNERS` por trust domain y branch protection con revisión del equipo del dominio, "include administrators" y commits firmados (aprobados por el owner). **No es blocker**: antes de producción, P26.T17.b registra la evaluación de si conviene extraer repositorios. |
| CF-02 | V9 §3 define `Password U → Argon2id → … → AuthSecret_U → OPAQUE → PlatformSession`; el prompt pide una cuenta centralizada con login/forgot/reset password **independiente** de U/R. | Dos capas explícitas: (1) **Cuenta** (email + password de login, hash Argon2id server-side, sesiones con cookie HttpOnly) y (2) **PlatformSession** sensible de 15 min, obtenida por **OPAQUE con AuthSecret_U** (Wallet) o por **step-up reforzado** (email OTP + TOTP si está activo) para flujos de recovery donde U no está disponible. El reset de la password de login nunca toca U.enc ni el registro OPAQUE. Ver ADR-008. |
| CF-03 | El prompt sugiere `GOOGLE_CLIENT_SECRET_WALLET`. | No se usa client secret: la integración Drive es 100 % frontend con cliente OAuth público (un secret no puede protegerse en un navegador y además convertiría al backend en parte del flujo de U). Se documenta en `SETUP_EXTERNAL_SERVICES.md`. Ver ADR-012. |
| CF-04 | El prompt pide atomicidad "approve exacto → swap → allowance 0" cuando sea técnicamente posible; V9 prohíbe DELEGATECALL en el camino asistido (por lo tanto prohíbe MultiSend). | Con CALL único por SafeTx la atomicidad en **una** SafeTx no es posible sin DELEGATECALL. Se adopta el diseño de menor riesgo: `approve(SwapExecutor, amountIn exacto)` + `SwapExecutor.swap(...)` en dos SafeTx consecutivas firmadas en una sola ceremonia, con un `SwapExecutor` que sólo puede debitar a `msg.sender` (la propia Safe) y post-condición on-chain `allowance == 0` tras el swap. Ver ADR-015 y §6 [C-SWP]. |
| CF-05 | Prompt §14 pide analizar batching; V9 exige `msg.sender = S` y S distinta por Safe, y CALL-only. | Batching estructuralmente incompatible (cross-Safe imposible por S distinta; intra-Safe requiere DELEGATECALL). V1 ejecuta de a una operación por Safe, en paralelo entre Safes. Ver ADR-019. |
| CF-06 | GitHub Actions sólo lee workflows desde la raíz del repo; el owner pide todo dentro de `wallet/`. | La lógica de CI vive en `wallet/ci/` (scripts y composite actions); en la raíz sólo van `.github/workflows/wallet-*.yml` y `.github/CODEOWNERS`, **aprobados por el owner el 2026-10-16** (se crean en P02, sin volver a preguntar). |
| CF-07 | V9 §17 pide "Hosting/DNS separado"; el prompt pide cookies HttpOnly/SameSite; el target de producción del backend es una VPS Linux propia. | Cada frontend tiene su propio host (`wallet.<WALLET_DOMAIN>`, `recovery.<RECOVERY_DOMAIN>`) y su propio host de API (`api.<WALLET_DOMAIN>`, `api.<RECOVERY_DOMAIN>`) apuntando al mismo backend; cookies `__Host-` por host y sesiones separadas por cliente (ADR-010). Hosting: decisión del owner (2026-10-17) — Wallet y Recovery se sirven desde **servidores distintos entre sí y distintos del host del backend**, cada uno con su contenedor estático (`wallet-web`, `recovery-web`) y su reverse proxy, configurados a mano al desplegar. DNS: ver CF-11. |
| CF-08 | El documento de negocio menciona "direcciones frecuentes … no necesariamente una restricción on-chain"; prompt y V9 exigen whitelist con enforcement final on-chain. | Prevalece prompt + V9: `DestinationWhitelist` on-chain obligatorio para toda salida asistida. |
| CF-09 | Prompt §38 pide que el planner **termine** con PRODUCTION READINESS, pero §41 pide auditar "una vez implementado todo el planner" y §42–§43 remediar y documentar después. | Se divide en dos: **P26** prepara producción (infra, operación, gates) y **P30 — PRODUCTION READINESS: GATE FINAL Y GO-LIVE** cierra el planner tras auditoría (P27), remediación (P28) y documentación (P29), re-verificando todos los gates antes de cualquier despliegue de producción. |
| CF-10 | V9 §2/§17 exige trust domains administrativamente independientes; el backend, el signer y sus datos corren en **un único host** (VPS). | El software mantiene la separación (contenedores, redes Docker, UIDs y volúmenes por dominio, secretos por servicio, signer sin puertos publicados, claves de release y de policy **fuera** del host). Los frontends se sirven desde servidores propios (decisión del owner del 2026-10-17, ADR-010/ADR-022), así que el root del host del backend **no** controla el JS de los origins de U y R. Riesgo residual documentado (RR-01): el root del host del backend obtiene las S de todos sus shards, los secretos de Compose (incluidas las claves de atestación del monitor local y del signer) y la API; con eso puede co-firmar sólo lo que U o R firmen, y el monitor off-host sigue alertando. Controles compensatorios: monitor de integridad off-host (GitHub Actions) con alertas, manifests firmados fuera del host, kill-switch y playbook específico (P26.T16). **No bloquea V1.** |
| CF-11 | V9 §17 pide hosting y DNS separados entre Wallet y Recovery; el owner decidió (2026-10-17) "dos subdominios apuntando a diferentes servidores". | El hosting queda separado en tres servidores (backend, Wallet y Recovery); la separación es efectiva sólo si los servidores de Wallet y de Recovery están en cuentas de hosting distintas (con una cuenta compartida, un único compromiso alcanza U y R: RR-16); proveedores distintos son lo recomendado, y si comparten proveedor con cuentas distintas, el riesgo de un compromiso a nivel del proveedor queda en RR-16 y se acepta con la firma de riesgos residuales del go-live. La separación de DNS se cumple si los hosts de Wallet y de Recovery están en dominios registrables distintos con cuentas de DNS distintas; si son subdominios de un mismo dominio (una sola cuenta de DNS), es un desvío de V9 §17: quien controle esa cuenta podría redirigir ambas apps (RR-11). El software no cambia en ningún caso (`WALLET_DOMAIN` y `RECOVERY_DOMAIN` son independientes). Gate del go-live (H-02, H-06, P30.T06): cuentas de hosting y de DNS distintas para Wallet y Recovery **o** aceptación escrita del owner de RR-16/RR-11, con CAA, 2FA en las cuentas y el monitor off-host como compensación. **No bloquea V1.** |

### 2.3 Comportamientos deliberados (no son vulnerabilidades)

Copiados de V9 §19 y prompt §41; se usan como filtro obligatorio en la auditoría (P27):

- U + R tienen soberanía completa (pueden cambiar o retirar Guard, módulos, fallback, owners, threshold).
- U o R actuales pueden cancelar individualmente una rotación pendiente (incluso para vetar su propia rotación; el remedio es la migración excepcional a una Safe nueva).
- S necesita a U o R para alcanzar threshold; S nunca origina intención.
- Una SafeTx firmada sigue siendo válida hasta su ejecución o hasta que su nonce se consuma (cancelación por NoOp con el mismo nonce).
- El compromiso conjunto de dos owners suficientes para threshold otorga el poder correspondiente por diseño.
- Una credencial comprometida que bloquea su sustitución se resuelve migrando fondos a una Safe nueva (procedimiento excepcional manual con doble aprobación).

## 3. Hechos externos verificados

Verificados el **2026-10-16** contra documentación oficial, código fuente en tags exactos, registries oficiales y lecturas on-chain de Base mainnet (chainId 8453). Toda dirección y codehash se re-verifica en P03 contra el RPC archive del proyecto y queda en `config/chains/base-mainnet.json`. Nada de esta sección se fijó "de memoria".

### 3.1 Bloque de fork

| Parámetro | Valor | Evidencia |
|---|---|---|
| `CHAIN_ID` | `8453` (`0x2105`) | `cast chain-id` |
| `FORK_BLOCK_NUMBER` | **`52700000`** | bloque ya `finalized` al momento de fijarlo (finalized = 52700134, latest = 52700953) |
| Hash del bloque | `0x64a292b057c55f118eb550d89bd860a5740598962f50536c719b375f1ca9c473` | `cast block 52700000 --field hash` |
| Timestamp | `1792189347` (2026-10-16 22:22:27 UTC) | `cast block 52700000 --field timestamp` |
| Lag observado `safe` / `finalized` | 24–92 s / ~19–20 min | muestreo de `latest`, `safe`, `finalized` |
| Tiempo de bloque actual | 2,000 s promedio | genesis vs. head |

Todas las verificaciones de §3.2–§3.4 se repitieron **en el bloque 52700000** (`cast code --block 52700000 | cast keccak`).

### 3.2 Safe Smart Account

- Release estable más reciente: **v1.5.0** (2025-07-03; tag `v1.5.0`, commit `dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be`). El repositorio oficial ahora es `github.com/safe-fndn/safe-smart-account` (redirige desde `safe-global`). No hay release posterior; `main` tiene cambios **no publicados** (no compilar desde `main`).
- Versión recomendada por Safe para Base: `recommendedMasterCopyVersion: "1.5.0"`, `l2: true` (`https://safe-config.safe.global/api/v1/chains/8453/`). Se usa el singleton **SafeL2** (emite `SafeMultiSigTransaction`, útil para indexar transacciones soberanas).
- Hechos del código fuente v1.5.0 que condicionan el diseño:
  - `ITransactionGuard`: `checkTransaction(address to, uint256 value, bytes data, Enum.Operation operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures, address msgSender)` y `checkAfterExecution(bytes32 hash, bool success)`; interfaceId `0xe6d7a83a`; `setGuard` exige ERC-165 (`GS300`).
  - `IModuleGuard`: `checkModuleTransaction(address to, uint256 value, bytes data, Enum.Operation operation, address module) returns (bytes32)` y `checkAfterModuleExecution(bytes32, bool)`; interfaceId `0x58401ed8`; `setModuleGuard` exige ERC-165 (`GS301`).
  - Orden en `execTransaction`: (SafeL2 event) → hash con `nonce++` → **`checkSignatures(msg.sender, …)`** → **`guard.checkTransaction(…, msg.sender)`** → ejecución → si falla con `safeTxGas == 0 && gasPrice == 0` **revierte toda la tx propagando el error (nonce NO consumido)** → eventos → `checkAfterExecution(txHash, success)`. Dentro del guard `nonce()` ya vale N+1: para reconstruir el hash se usa `nonce() - 1`.
  - `checkSignatures(address executor, bytes32 dataHash, bytes signatures)` y `checkNSignatures(address executor, bytes32, bytes, uint256)` son `public view`. Tipos de firma: `v=0` contrato (EIP-1271 vía STATICCALL), `v=1` hash aprobado (válido si `executor == owner` o `approvedHashes`), `v>30` eth_sign (`v-4`), resto ECDSA; owners estrictamente crecientes (`GS026`); **low-s no se exige**.
  - Slots: guard `0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8`, module guard `0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947`, fallback handler `0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5`. **No hay getters públicos**: se leen con `getStorageAt(slot, 1)`.
  - `setup(...)`: `setupOwners` (rechaza 0, sentinel y la propia Safe como owner) → fallback handler → `setupModules(to, data)` que hace **DELEGATECALL**; desde ese código **sí** se puede llamar `setGuard`/`setModuleGuard` (verificado en fork). El motivo de revert interno se reemplaza por `GS000`.
  - Cancelación ("rejection"): SafeTx `{to: safe, value: 0, data: 0x}` → `receive()` emite `SafeReceived`. **El Guard debe permitirla** o no se podría cancelar un nonce.
  - Owners pueden ser contratos o EOAs delegadas por EIP-7702; con `v=0` el código del owner decide la validez. Por eso el camino asistido exige firmas ECDSA (`v ∈ {27,28}`).
  - Ojo para tests en fork: algunas cuentas públicas de Anvil están **delegadas vía EIP-7702 en Base mainnet** (p. ej. `0x3C44…93BC`). U/R/S/deployer de tests se generan siempre con claves nuevas.

| Contrato v1.5.0 (Base, deployment `canonical`) | Address | Codehash (verificado en 52700000) |
|---|---|---|
| Safe (singleton L1) | `0xFf51A5898e281Db6DfC7855790607438dF2ca44b` | `0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2` |
| **SafeL2 (singleton usado)** | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` | `0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc` |
| **SafeProxyFactory** | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` | `0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529` |
| MultiSendCallOnly (sólo referencia; no se usa en camino asistido) | `0xA83c336B20401Af773B6219BA5027174338D1836` | `0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663` |
| CompatibilityFallbackHandler (no se instala: fallback = 0) | `0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4` | `0x3c6a85bcf7b563daa624b884b4e9a1b9fa5371edde7be945d998071a48f28bbc` |
| `keccak256(SafeProxyFactory.proxyCreationCode())` | — | `0x941b3e88811b2f33b8e26783c7407d2e978404581a21c9f07abf2cad9cb87e12` |
| Runtime codehash de todo `SafeProxy` de esta factory | — | `0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f` |

Derivación de dirección (SafeProxyFactory v1.5.0): `salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))`, `initCode = proxyCreationCode ‖ uint256(uint160(singleton))`, `CREATE2`. Funciones disponibles: `createProxyWithNonce`, `createProxyWithNonceL2` (emite además `ProxyCreationL2` con el initializer), variantes chain-specific; `createProxyWithCallback` fue removida.

Explorer: cada dirección de esta sección se consulta en `https://basescan.org/address/<address>` (se registra en `config/chains/base-mainnet.json`). Fuentes: `https://github.com/safe-fndn/safe-smart-account/tree/v1.5.0`, `https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.5.0`, `https://docs.safe.global/advanced/smart-account-overview`, `https://safe-config.safe.global/api/v1/chains/8453/`.

### 3.3 Tokens

| Token | Address | Codehash (52700000) | Naturaleza y supuestos de confianza |
|---|---|---|---|
| **USDC** (nativo de Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | proxy `0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab` | `FiatTokenProxy` con slots ZeppelinOS (no EIP-1967); implementación `FiatTokenV2_2` en `0x2Ce6311ddAE708829bc0784C967b7d77D19FD779` (codehash `0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873`); **upgradeable por Circle**, con **pausa y blacklist**; 6 decimales. Fuente: `https://developers.circle.com/stablecoins/usdc-contract-addresses`. **No usar USDbC** (`0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`, bridged, no emitido por Circle). |
| **USDT** (bridged canónico) | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` | `0x478746a8e4b17181c4efbeb2069d86f22ec395788099ed65c9442ca44df265bc` | **No existe USDT emitido por Tether ni USDT0 en Base** (verificado en `tether.to/en/supported-protocols/` y `docs.usdt0.to`). El "USDT" de Base es un `L2StandardERC20` legacy del bridge canónico de Base (Superchain token list), respaldado por USDT de Ethereum en escrow del L1StandardBridge; **no upgradeable, sin admin, sin pausa ni blacklist**; sólo el bridge `0x4200…0010` puede mint/burn. Confianza: bridge y claves de upgrade de Base; Tether no emite ni redime en Base. 6 decimales. |

**Decisión V1 (verificada automáticamente, sin confirmación del owner):** es la **única representación canónica vigente** de USDT en Base — es la entrada `base` de USDT en la Superchain token list (`ethereum-optimism.github.io/data/USDT/data.json` → `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2`), USDT0 no tiene despliegue en Base (`docs.usdt0.to/api/deployments`) y Tether no lista Base — por lo que V1 la usa y documenta sus supuestos de confianza en `docs/EXTERNAL_CONTRACTS.md` (P03). Si en el futuro aparece una representación oficial distinta (Tether o USDT0 en Base), incorporarla es un cambio de policy (registro de token con timelock) + config de frontends + pool, evaluado en ese momento. Explorer: `https://basescan.org/token/0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2`.

### 3.4 Uniswap en Base

Documentación oficial: `docs.uniswap.org` redirige a `developers.uniswap.org`.

| Contrato | Address | Codehash (52700000) | Uso en V1 |
|---|---|---|---|
| UniswapV3Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x95707a4ac71f20181a63ef7d180e3c625be5d20fc8f6f980befa966bad568132` | verificación de pool |
| **UniswapV3Pool USDC/USDT fee 100 (0,01 %)** | `0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1` | `0x7c1e281e8700a5038559b9380296ee9c4591b706789a1aa5a7a270ca837ef80d` | **pool canónico del `SwapExecutor`** (token0 = USDC, token1 = USDT) |
| QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | `0xceb5b8bc35e09fc64b1c48c6b920e0d2e37d5710e4f3ef214e1a81f75acee51e` | cotización por `eth_call` (no es view) |
| SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` | `0x38bd640f47df62b2fd5a6755a63f4976ad847dc9b946ae0d145d21d16bb124e4` | **no se usa** |
| UniversalRouter 2.1.2 (vigente; 2.0/2.1.1 pierden soporte de API el 2026-10-21) | `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` | `0x816c75fe7f6ccf8fe8b14825091e8dff301fe7ffd4b962f89b2981a747facc08` | **no se usa** |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0xa67739abc3ede9dbdc0491636c67d6a14ac07fab9030c3f509b1eb7b11dff8ed` | **no se usa; approvals a Permit2 denegados** |
| v4 PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | `0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6` | candidato a `SwapExecutorV4` futuro |
| v4 Quoter | `0x0d5e0F971ED27FBfF6c2837bf31316121532048D` | `0x9a5c0cdd56325bef0e48cdab071a4b6a7f877e1271c2e08510998d724a038bb3` | monitoreo comparativo |
| v4 StateView | `0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71` | `0xbbd5859677ef5491143133e8ed2b8faa0272f6fc2cbae94c53e79cc8c0538545` | monitoreo comparativo |

Liquidez USDC/USDT observada (bloque 52700000 / 52700217): pool v3 0,01 % `liquidity = 297227205812614`, saldos 67.659,18 USDC + 133.289,34 USDT; mejor pool v4 (fee 5, tickSpacing 1, sin hooks, poolId `0x7681c00520c26da8d8970c21a65461c726f274068eb08743debc1178e697044e`) ≈ US$ 261,6k; total Uniswap USDC/USDT en Base ≈ US$ 850k (**liquidez baja**). Cotización QuoterV2 en 52700000: 1.000 USDC → 1.001,363627 USDT (USDT cotiza ~0,14 % bajo USDC). Diferencia de precio v3 0,01 % vs v4 fee 5: ~0,006 % para 1.000 USDC.

### 3.5 Servicios y librerías que condicionan el diseño

| Tema | Hecho verificado | Consecuencia |
|---|---|---|
| **Clef** | Removido de go-ethereum en v1.17.4 (2026-06-22, PR #35097: "no longer maintained"); el repo standalone `github.com/ethereum/clef` tiene 3 commits del 2026-06-02 y **ninguna release ni tag** (re-verificado 2026-10-16); `account_new` siempre requiere UI. | **No se usa** (ADR-014). |
| **Web3Signer** | `Consensys-Incorporated/web3signer`, Apache-2.0, release estable 26.9.0 (2026-09-30), activo. Para secp256k1: `POST /api/v1/eth1/sign/{identifier}` con `applyHash: false` firma un digest de 32 bytes tal cual; JSON-RPC `eth_signTransaction` (legacy y EIP-1559), `eth_signTypedData`, `eth_sign`; `GET /api/v1/eth1/publicKeys`; `/reload` para recargar claves sin reiniciar; keystores V3 con passwords en archivos separados; **no genera claves** y no tiene motor de políticas; aplicación Java con imagen Docker oficial. | Evaluado y **no elegido** para V1 (ADR-014); el formato V3 deja abierta una migración futura. |
| OPAQUE | **RFC 9807** (jul-2025). `@serenity-kit/opaque` 1.1.0 implementa RFC 9807 (opaque-ke 4.0.0, WASM, Node+browser, `keyStretching` configurable, pentest 7ASecurity). `@cloudflare/opaque-ts` 0.7.5 está en draft-07 y sin mantenimiento. | Se usa `@serenity-kit/opaque`. CSP del Wallet necesita `'wasm-unsafe-eval'`. |
| Argon2id browser | `@noble/hashes` 2.4.0 (2026-08-27) con `argon2id` estable desde 1.6.0, JS puro; `hash-wasm` 4.12.0 sin releases desde 2024-11. | Se usa `@noble/hashes` en Web Worker con presupuesto de rendimiento (ADR-013). |
| Argon2id server | `@node-rs/argon2` 2.2.2 (2026-10-06). | Hash de password de cuenta. |
| Google OAuth browser-only | Flujo implícito (`response_type=token`) **sigue documentado pero marcado inseguro/"legacy"**; GIS token model exige su JS (popup); el doc de web-server marca `client_secret` como opcional (code + PKCE sin backend: **no confirmado**). Scope `drive.appdata` es **no sensible**. appDataFolder se **borra si el usuario desinstala la app** o lo elimina manualmente. | Spike obligatorio code+PKCE sin secret; si no funciona, implícito por redirección sin JS de Google (ADR-012). Proyectos de Google Cloud separados por app. Backups adicionales recomendados y chequeo de salud del backup. |
| Mailgun | API `https://api.mailgun.net` (región US; EU: `https://api.eu.mailgun.net`), autenticación HTTP Basic `api:<API key>`, envío `POST /v3/<dominio>/messages`, eventos `GET /v3/<dominio>/events`; dominio sandbox: sólo destinatarios autorizados (máx. 5, cada uno acepta una invitación); dominio propio verificado con registros SPF y DKIM; el adaptador usa `fetch` nativo (sin SDK). Verificado el 2026-10-17 contra la documentación oficial y la API (dominio sandbox del owner en estado `active`). | Proveedor de email (ADR-016). |
| WalletConnect / Reown | projectId en `https://dashboard.reown.com` (cloud.reown.com redirige); allowlist de dominios por proyecto (localhost siempre permitido; cambios tardan 15 min). wagmi 3.7.7, @wagmi/core 3.6.5, @wagmi/connectors 8.2.0 (SDKs de wallets como peers opcionales); Coinbase EOA-only: `coinbaseWallet({ preference: { options: 'eoaOnly' } })`. | Conectores sólo en Recovery (lazy). |
| Verificación de contratos | Etherscan API V2 (una key para todas las cadenas, `chainid=8453`); keys de BaseScan ya no sirven; Base es "Paid Tier Only" para la API general pero **verificación y ABI funcionan en free tier**. `forge verify-contract` lee `ETHERSCAN_API_KEY`. | P25. |
| Base finalidad | Docs oficiales: L2 block ~2 s; inclusión en batch L1 ~2 min (nunca reorgeado); finalidad L1 ~20 min. **Upgrade Denim (bloques de 200 ms) apunta a mainnet en noviembre de 2026**: no medir confirmaciones por cantidad de bloques; usar tags `safe`/`finalized` o tiempo. | ADR-018. |
| Anvil | `anvil_reorg`, `anvil_rollback`, tags `safe`/`finalized` disponibles (probado con Anvil 1.5.1 local). | Tests de reorg reales sobre el fork. |
| Wordlist 2^16 | `niceware` 4.0.0 (MIT): 65.536 palabras únicas `[a-z]+`, ordenadas; SHA-256 (una por línea, LF final) `c2bf4e5b768581bc101620e9ec735e1b91b9b3e33d10535c5fbcada87b1e7e1e`. | `MTW-WORDLIST-V1` (ADR-013). |
| Docker Compose secrets | Funcionan sin Swarm: `secrets:` con `file:`, montados en `/run/secrets/<nombre>` sólo en los servicios que los declaran; las imágenes oficiales (p. ej. `postgres`) aceptan la convención `*_FILE` (`docs.docker.com/compose/how-tos/use-secrets/`). | Mecanismo de secretos de producción (ADR-030). |
| Node 26 y Corepack | La documentación de Corepack existe para Node 24 y no para Node 26 (Corepack dejó de distribuirse con Node a partir de la línea 25). | pnpm se instala con el npm del Node fijado (ADR-032). |
| pgBackRest / age | pgBackRest 2.59.3 (2026-10-04): backup full/diferencial/WAL con repositorio cifrado; age 1.3.2 (2026-08-29): cifrado de archivos con clave pública. | Backups (ADR-031). |
| Servido estático y monitoreo | Caddy 2.11.7 (2026-10-03, imagen oficial); Prometheus 3.15.0, Alertmanager 0.34.1, Grafana 13.2.4 (OSS). | Contenedores `wallet-web`/`recovery-web` y perfil de observabilidad (P26). |

### 3.6 Versiones verificadas (2026-10-16) — a fijar exactas en P01

| Componente | Versión | Fuente |
|---|---|---|
| Node.js | **26.x** (26.12.0 al 2026-10-16; pasa a LTS el 2026-10-28; EOL 2029-04-30). Node 24 (24.22.0) entra en Maintenance el 2026-10-20 | nodejs.org/dist/index.json, nodejs/Release schedule |
| pnpm | 12.14.0 (instalado con el npm del Node fijado; Node 26 no incluye Corepack) | registry npm |
| TypeScript | **6.0.3** (7.0.2 es `latest` pero typescript-eslint 8.71.2 exige `<6.1.0`) | registry npm |
| React / React DOM | 19.3.1 | registry npm |
| Vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 | registry npm |
| React Router | 8.4.0 | registry npm |
| viem | 2.57.7 | registry npm |
| wagmi / @wagmi/core / @wagmi/connectors | 3.7.7 / 3.6.5 / 8.2.0 | registry npm |
| @walletconnect/ethereum-provider · @coinbase/wallet-sdk · @metamask/connect-evm | 2.26.0 · 4.4.0 · 2.1.1 | registry npm |
| @tanstack/react-query (peer obligatorio de `wagmi`; sólo en el chunk lazy de Recovery) | 5.104.3 | registry npm |
| @noble/curves · @noble/hashes · @scure/base | 2.4.0 · 2.4.0 · 2.4.0 | registry npm |
| @serenity-kit/opaque | 1.1.0 | registry npm |
| jose (JWS EdDSA, [B-PSES-04]) | 6.2.12 | registry npm |
| @reown/walletkit · @walletconnect/core (wallet headless del test del relay real de WalletConnect, P19.MAN) | 1.6.0 · 2.26.0 | registry npm |
| Fastify · @fastify/swagger · @fastify/swagger-ui | 5.12.7 · 9.9.2 · 6.1.2 | registry npm |
| @fastify/cookie · helmet · cors · rate-limit | 11.1.3 · 13.2.0 · 11.3.1 · 11.2.1 | registry npm |
| zod · fastify-type-provider-zod | 4.6.7 · 7.0.0 | registry npm |
| kysely · pg | 0.29.6 · 8.23.1 | registry npm |
| bullmq · ioredis | 6.3.15 · 6.0.0 | registry npm |
| pino · prom-client | 10.4.0 · 15.1.3 | registry npm |
| @node-rs/argon2 · otpauth · nodemailer | 2.2.2 · 9.5.2 · 10.1.2 | registry npm |
| Vitest · @playwright/test | 5.0.5 · 1.64.1 | registry npm |
| testcontainers (+ módulos postgresql/redis) | 12.2.1 | registry npm |
| ESLint · typescript-eslint · Prettier | 10.13.0 · 8.71.2 · 3.9.10 | registry npm |
| Foundry (forge/cast/anvil) | **v1.8.5** (imagen `ghcr.io/foundry-rs/foundry:v1.8.5`) | github.com/foundry-rs/foundry/releases |
| solc | 0.8.37 (`latestRelease` en binaries.soliditylang.org); EVM target a confirmar en P03 contra el fork | binaries.soliditylang.org |
| forge-std | v1.17.0 | GitHub releases |
| OpenZeppelin Contracts | **v5.6.1** (dist-tag `latest`; 5.7.0 está como `dev`) | registry npm + GitHub |
| Safe Smart Account | v1.5.0 (`dc437e8`) | §3.2 |
| Slither | 0.11.6 | GitHub/PyPI |
| gitleaks · OSV-Scanner · Semgrep · zizmor · syft · Trivy | 8.30.1 · 2.7.0 · 1.181.0 · 1.31.1 · 1.54.1 · 0.76.0 | GitHub releases |
| PostgreSQL · Valkey · Mailpit (imágenes) | 18.6 · 9.2 · v1.31.6 | Docker Hub |
| pgBackRest · age · Caddy | 2.59.3 · 1.3.2 · 2.11.7 | GitHub releases |
| Prometheus · Alertmanager · Grafana (opcional) | 3.15.0 · 0.34.1 · 13.2.4 | GitHub releases |

## 4. Decisiones de arquitectura (ADR)

Cada ADR se materializa como archivo en `wallet/docs/adr/` en P01. Ninguna decisión importante queda "TBD"; donde hay una verificación empírica pendiente, el ADR fija la **regla de decisión** y la alternativa elegida si la verificación falla.

| ADR | Decisión | Justificación / alternativas descartadas |
|---|---|---|
| ADR-001 | Todo bajo `wallet/` con **proyectos independientes**: `contracts` (Foundry), `backend/app`, `backend/signer`, `frontend/wallet`, `frontend/recovery`, `e2e`. Sin pnpm workspace común; cada uno con su lockfile. `wallet/package.json` sólo orquesta. | Cumple la instrucción del owner y la separación de supply chain de V9 §17 (CF-01). Workspace único descartado: un lockfile compartido mezcla dependencias de U y R. |
| ADR-002 | **Safe v1.5.0** con singleton **SafeL2** (`0xEdd1…7C7e`) y `SafeProxyFactory` v1.5.0 (`0x14F2…5e7b`) vía `createProxyWithNonceL2`. Sin `SafeToL2Setup` (sólo Base). | Versión recomendada por Safe para Base; SafeL2 emite eventos para indexar transacciones soberanas. v1.4.1 descartada (sin module guard). |
| ADR-003 | `SecurityGuard` **inmutable y compartido** con registro de roles por Safe (`U`, `R`, `S`) al que sólo pueden acceder Safes creadas por la `WalletFactory` (codehash del proxy, singleton SafeL2 y marca transitoria de la factory); el camino soberano nunca revierte; clasifica el camino con los signers de las primeras `threshold` firmas (las que Safe ya validó, porque `checkSignatures` corre antes del guard) usando un parser espejo del de Safe; camino asistido ⇔ S ∈ signers; exige `msgSender == S`, exactamente 2 firmas ECDSA (`v ∈ {27,28}`), X ∈ {U, R}. | Cumple V9 §9 y A7. Firmas `v=0/v=1/v>30` excluidas del camino asistido para eliminar confusión de firmas (EIP-1271, EIP-7702). |
| ADR-004 | Camino soberano (S no participa) **sin políticas de negocio**: el Guard no aplica whitelist ni PolicyRegistry; sólo mantiene sincronizados los roles ante `swapOwner` soberano y permite `updateRoles` llamado por la propia Safe. U+R puede retirar el Guard. | V9 §9/§18, A6. |
| ADR-005 | `PolicyRegistry` con modo `BOOTSTRAP → RESTRICTED` (unidireccional). Permisos por `(opType, rol)` ([C-POL-02]), registro de tokens soportados y de swap executors; en RESTRICTED: alta con timelock de 24 h, guardianes pueden cancelar, revocaciones inmediatas. **Staging y producción nacen RESTRICTED** (constructor) con el set V1 completo. El fork local también se despliega **RESTRICTED por defecto** (igual que producción); BOOTSTRAP existe sólo como perfil de desarrollo de contratos (`deploy-local --policy-mode bootstrap`) y las suites adversariales corren en ambos modos. Admin = Governance Safe (multisig; hardware wallets recomendadas para sus owners, H-04). | V9 §11; gate de producción del prompt §3. |
| ADR-006 | `DestinationWhitelist` on-chain por Safe: alta sólo con `msg.sender == safe` (SafeTx U+S tras challenge), **activación diferida 24 h**, baja inmediata; `isWhitelisted(safe, dest)`. | El backend solo no puede alterar la whitelist (requiere firma U). La demora de 24 h agrega una ventana de reacción ante phishing/compromiso del canal de email (prompt §10: "mecanismo más seguro"). |
| ADR-007 | `RotationTimelock` (48 h) desplegado por el constructor del `SecurityGuard` (sin dependencias circulares). Propuesta por SafeTx asistida; cancelación individual por U o R vía firma EIP-712 (cualquier relayer) o por la Safe; ejecución = SafeTx `swapOwner` validada por el Guard contra una propuesta madura, firmada **nuevamente** por U o R vigente + S. | Ejecución sin módulos (modules = none). La re-firma evita reservar nonces durante 48 h y congelar la Safe. |
| ADR-008 | Autenticación en dos capas: **cuenta** (email + password de login, Argon2id + pepper, cookies `__Host-`) y **PlatformSession** de 15 min (OPAQUE RFC 9807 con AuthSecret_U, o step-up email OTP + TOTP) ligada a una session key P-256 no exportable que firma los requests críticos. | Reconciliación V9 §3 + prompt §7 (CF-02). |
| ADR-009 | Backend TypeScript: Node 26 LTS, Fastify 5 + Zod 4 + fastify-type-provider-zod (OpenAPI 3.1 desde código) + Swagger UI; Kysely + pg; BullMQ sobre Valkey; pino; prom-client; jose. | Stack preferido del prompt; Fastify por rendimiento, schemas y plugins oficiales; Kysely por control explícito de SQL/locks. NestJS descartado (más superficie, decoradores). |
| ADR-010 | Dominios: `wallet.<WALLET_DOMAIN>` + `api.<WALLET_DOMAIN>`; `recovery.<RECOVERY_DOMAIN>` + `api.<RECOVERY_DOMAIN>` (origins distintos; aislamiento de hosting decidido por el owner el 2026-10-17: los subdominios de Wallet y de Recovery apuntan a servidores distintos; un dominio registrable distinto para Recovery suma aislamiento de DNS). Ambos API hosts apuntan al mismo backend con listeners/scopes separados; cookies host-only por API host. | V9 §17 "Hosting/DNS separado"; API en origin distinto del frontend para que un backend comprometido no pueda servir JS en el origin de U/R. |
| ADR-011 | Frontends React 19 + TypeScript 6.0.3 + Vite 8 + React Router 8, sin librerías de UI de terceros; Wallet **sin** wagmi/conectores; Recovery con wagmi + conectores sólo en un chunk lazy. | Minimiza superficie en el origin de U; Recovery mínimo (V9 §17). |
| ADR-012 | Drive `appDataFolder` 100 % frontend, **sin JS de Google** en origins criptográficos, como backup **adicional** (U y R exigen además un backup independiente de la plataforma, [F-KEY-06]); la conexión OAuth se hace antes de generar/desbloquear claves porque la redirección recarga la app. Regla de decisión (spike P17.T02): si el endpoint de token de Google acepta **authorization code + PKCE sin client secret** desde el navegador (CORS) para clientes "Web application", se usa ese flujo; si no, flujo implícito por redirección de página completa (token sólo en memoria, fragmento limpiado inmediatamente, `Referrer-Policy: no-referrer`). Proyecto de Google Cloud y cliente OAuth separados por app y entorno. `GOOGLE_CLIENT_SECRET_*` no se usa. | Google marca el implícito como legacy; code+PKCE es la práctica recomendada si funciona sin backend. GIS (JS de Google) descartado en origins criptográficos. |
| ADR-013 | Criptografía cliente: CSPRNG WebCrypto; secp256k1 con `@noble/curves`; Argon2id con `@noble/hashes` en Web Worker, 64 MiB/t=3/p=4 (presupuesto: desbloqueo ≤ 3 s p95 en el perfil móvil de referencia; si no se cumple, en Wallet se adopta `hash-wasm` 4.12.0 fijado tras revisión — Recovery no habilita WASM y acepta el desbloqueo más lento); HKDF y AES-256-GCM con WebCrypto; wordlist `MTW-WORDLIST-V1` = niceware 4.0.0 (2^16). | V9 §4/§5; librerías mantenidas y ya presentes en el árbol de viem. |
| ADR-014 | Signer S **self-hosted**: signer-service independiente por shard (mTLS sobre red Docker interna, política propia con snapshot firmado, DB propia, atestación de cada S creada) con **`SelfHostedSoftwareSignerProvider`**: una clave secp256k1 por Safe, generada con CSPRNG dentro del signer y guardada como **keystore Ethereum V3 cifrado** (scrypt + AES-128-CTR, formato estándar interoperable con geth, Foundry y Web3Signer) en el volumen del shard; la contraseña de cada keystore se deriva con HKDF-SHA256 de una **credencial de desbloqueo** por shard que vive aparte (secret de Docker Compose), nunca junto a los keystores; firma del hash EIP-712 de la SafeTx y del hash de la tx EIP-1559 con `@noble/curves` (low-s, RFC 6979). Ciclo de vida completo en [B-SIG-08]. `DevelopmentSignerProvider` = el mismo provider con guardas de desarrollo; `HardwareSignerProvider` (HSM físico propio vía PKCS#11/YubiHSM) queda como hardening futuro opcional. | Verificado 2026-10-16: **Clef** fue retirado de go-ethereum (v1.17.4) y su repo standalone `ethereum/clef` no tiene releases ni commits desde el 2026-06-02; además `account_new` exige UI. **Web3Signer** (Consensys, Apache-2.0, 26.9.0, mantenido) firma digests de 32 bytes (`applyHash: false`), soporta `eth_signTransaction` EIP-1559, `/reload` y miles de claves, pero **no crea claves** y no tiene política: nuestro servicio igual tendría que generar y cifrar cada keystore con la misma credencial, sumando una JVM por shard sin aislamiento real. Por la regla del owner (ciclo de vida dinámico no cubierto) se elige el provider propio, que conserva el formato V3 para migrar a Web3Signer o a un HSM más adelante sin rotar claves. Un KMS cloud quedó descartado: producción sin cloud. |
| ADR-015 | Swap: `SwapExecutorV3` propio contra el **pool canónico Uniswap v3 USDC/USDT 0,01 %** (`0xD56d…5DA1`) por llamada directa al pool con callback validado; sin router, sin Permit2, sin calldata arbitraria. Dos SafeTx (nonce N `approve(executor, amountIn)` exacto; nonce N+1 `swap`). El Guard impone post-condiciones on-chain: la Safe pierde ≤ `amountIn` del token de entrada, recibe ≥ `minAmountOut` del otro, `minAmountOut ≥ amountIn·(1−0,5 %)` (`MAX_SWAP_SLIPPAGE_BPS = 50`), y la allowance Safe→executor queda en 0. Executors registrados en `PolicyRegistry` (permite un `SwapExecutorV4` futuro con timelock). | Menor superficie: el pool v3 es inmutable y verificable por codehash; v4 (PoolManager singleton) tiene más complejidad por una mejora de precio de ~0,006 %. Las post-condiciones del Guard acotan lo que puede pasar **dentro** de la SafeTx del swap (pérdida ≤ amountIn, recepción ≥ piso); la allowance residual entre N y N+1 es segura sólo porque todo executor registrado debe debitar exclusivamente a `msg.sender` ([C-SWP-05], requisito de registro testeado). Riesgo residual documentado: MEV/sandwich acotado por el piso de 0,5 %. |
| ADR-016 | Email transaccional: **Mailgun** (cuenta del owner; dominio de envío propio por entorno verificado con SPF y DKIM; API HTTP con `fetch` nativo). Local/CI: **Mailpit** (SMTP real local) para los flujos deterministas, más tests obligatorios contra la API real de Mailgun con el dominio sandbox y de entrega real a una casilla autorizada (`EMAIL_TEST_*`, lectura de códigos con la Gmail API: OAuth 2.0, scope `gmail.readonly`). | Proveedor real ya contratado por el owner (2026-10-17); separación por entorno y entrega verificable de punta a punta. |
| ADR-017 | RPC: **Alchemy** (primario, archive, también para el fork) + **QuickNode** (secundario) en backend; el signer usa **sus propias** claves de ambos; cada frontend usa su propia clave Alchemy con allowlist de dominio. Lecturas sensibles con quórum en bloque fijo. | Prompt §17; independencia entre trust domains. |
| ADR-018 | Finalidad en Base: `SUBMITTED` → `MINED` (receipt) → `CONFIRMED` (bloque ≤ head `safe` y hash re-verificado por quórum; típico 1–2 min) → `FINALIZED` (bloque ≤ head `finalized`; ~20 min). **Sin umbrales por cantidad de bloques en mainnet** (Denim: bloques de 200 ms). Local/fork: profundidad configurable. | Docs de Base (§3.5). |
| ADR-019 | **Sin batching en V1**: una `execTransaction` por tx; paralelo entre Safes, secuencial por Safe. | Cross-Safe imposible (S distinta por Safe y `msg.sender == S`); intra-Safe requiere DELEGATECALL (prohibido). Base es barato; el riesgo no compensa (CF-05). |
| ADR-020 | Nonce: asignación transaccional en Postgres (`FOR UPDATE`), índice único parcial por (safe, nonce) activo, lease con fencing por Safe, ejecución estricta en orden, cancelación por NoOp con el mismo nonce; regla del signer "una SafeTx activa por (safe, nonce)". | Prompt §15. |
| ADR-021 | Postgres es la fuente de verdad; outbox transaccional hacia BullMQ; la cola es sólo transporte. | Pérdida de Valkey no pierde operaciones. |
| ADR-022 | Producción **self-hosted**, **sin dependencia de ningún cloud**, en tres servidores (decisión del owner del 2026-10-17): (1) **host del backend** — VPS Linux estándar (target: Hostinger) con `infra/production/docker-compose.production.yml` (api, worker, watcher, indexer, gas-tank, integrity-monitor, signer shards, `postgres` del backend, `signer-postgres`, `valkey` y perfil opcional de observabilidad), redes Docker separadas por dominio (`edge`, `backend`, `signer` con `internal: true`) y sólo la API publicada con bind configurable hacia el reverse proxy existente; (2) **servidor de Wallet** y (3) **servidor de Recovery**, distintos entre sí, cada uno con su compose (`docker-compose.wallet-web.yml`, `docker-compose.recovery-web.yml`) que corre sólo su contenedor estático (Caddy con sus headers) detrás de su propio reverse proxy. El producto no incluye ni hardcodea Nginx; imágenes construidas en CI, publicadas en GHCR por digest y firmadas; el despliegue es manual, fuera de este planner, siguiendo `docs/DEPLOYMENT_VPS.md` (P26). El ensayo local de producción (P26/P30) levanta los tres compose en una sola máquina. | Decisión del owner (2026-10-16): producción en VPS propia, sin AWS/GCP/Azure; y (2026-10-17): Wallet y Recovery en servidores distintos. Se mantiene la separación lógica de trust domains (contenedores, redes, usuarios, secretos, claves de release fuera de los hosts); el riesgo residual del host del backend está en CF-10 y el de DNS en CF-11. (Histórico: un diseño previo en AWS quedó descartado.) |
| ADR-023 | Integridad de releases: builds reproducibles, SRI, CSP estricta, Trusted Types (una política con allowlist de workers), sin service workers, manifest firmado Ed25519 por app (claves de release distintas, guardadas sólo en el GitHub Environment de cada app, nunca en la VPS), SBOM CycloneDX (syft), contratos del sistema embebidos por entorno; **integrity monitor** (contenedor propio, clave propia) emite atestaciones firmadas que el signer exige para cooperar (MISMATCH pausa de inmediato; UNREACHABLE pausa tras 15 min de gracia con alerta) y un **chequeo off-host** programado en GitHub Actions verifica los mismos manifests y alerta aunque el host esté comprometido. Riesgo residual: servir JS distinto sólo a ciertos usuarios no es detectable por los monitores. | V9 §17. |
| ADR-024 | Entornos: `local` (fork Anvil), `staging` y `production`. Durante la ejecución del planner, staging y producción se despliegan y prueban completos **sobre el fork** con su configuración propia (Governance Safe, guardianes, deployer y claves de policy de ensayo generados en `~/.config/mtw/`, fuera del repo, que nunca se reutilizan en Base mainnet). Su despliegue real (contratos en Base mainnet; servicios como proyectos Docker Compose separados en la VPS) es el despliegue final, manual y con aprobación del owner. Nada se reutiliza entre staging y producción (DB, OAuth, keystores y credenciales del signer, secretos de sesión, email, RPC, claves de gobernanza). | Prompt §37; contratos y tokens reales (fork de Base mainnet) sin depender de testnets sin USDT/liquidez. |
| ADR-025 | Límites por defecto en el snapshot de policy: 10.000 por operación, 20.000 por Safe cada 24 h, 2FA desde 1.000 (TOTP o email OTP), swap ≤ 10.000 por operación, slippage default 30 bps / máx. 50 bps (= piso on-chain), deadline 10 min. Swaps se deshabilitan por policy si la cotización se desvía > 0,5 % de 1:1 o la liquidez del pool cae bajo el umbral de monitoreo. | Parámetros de negocio iniciales (modificables por snapshot firmado); coherentes con la liquidez observada (§3.4). |
| ADR-026 | Migración excepcional (credencial que veta su rotación): doble aprobación interna de operadores + autorización on-chain en `PolicyRegistry` por la Governance Safe (24 h, guardianes) + regla del Guard: destino = Safe registrada en el Guard cuyo rol correspondiente coincide con la credencial sana firmante. | V9 §14/A5 con enforcement on-chain. |
| ADR-027 | PostgreSQL 18 y **Valkey 9** self-hosted (contenedores con volúmenes persistentes, usuarios separados, healthchecks, backups de ADR-031); PostgreSQL es la fuente de verdad y Valkey el transporte de BullMQ. | Valkey es compatible con el protocolo Redis (la preferencia "Redis" del prompt se cumple) y tiene licencia BSD; Redis 8 es AGPL. |
| ADR-028 | Runtime Node **26 LTS** (LTS desde 2026-10-28, EOL 2029-04-30). | Node 24 entra en Maintenance el 2026-10-20; un proyecto nuevo arranca en la línea con mayor ventana de soporte. |
| ADR-029 | **Vía de upgrade del Guard** para Safes existentes ([C-GRD-17]): sucesor registrado en `PolicyRegistry` (24 h + guardianes) + propuesta por Safe en `RotationTimelock` (48 h, cancelable por U o R) + SafeTx asistida `setGuard(sucesor)`. Contratos nuevos de la factory sólo afectan wallets nuevas. | Sin esto, un bug del Guard inmutable sólo se podría resolver con ceremonias U+R por usuario. |
| ADR-030 | Secretos de producción como **secrets de Docker Compose** (`file:`), montados en `/run/secrets/<nombre>` sólo en los servicios que los usan; cada servicio lee `<VAR>_FILE`; los archivos viven en el host, fuera del repo, en `/etc/mtw/<entorno>/secrets/` (root, 0400) y los genera `scripts/deploy/init-secrets.sh` al desplegar; las credenciales de desbloqueo del signer van en un directorio distinto (`/etc/mtw/<entorno>/signer-unlock/`) y sólo se montan en su shard; nunca en el repo ni en imágenes. | Mecanismo estándar del runtime elegido (Docker Compose, también sin Swarm), sin servicios externos; los valores no quedan en variables de entorno ni en `docker inspect`. systemd credentials descartado porque los servicios corren en contenedores. |
| ADR-031 | Backups agnósticos al proveedor: PostgreSQL (backend y signer) con **pgBackRest** (full + diferencial + WAL archiving para PITR, repositorio cifrado; repo1 local y repo2 off-host que se define al desplegar); keystores del signer, export de auditoría y configuración empaquetados y cifrados con **age** hacia la clave pública de backup; la credencial de desbloqueo del signer **nunca** viaja en esos backups (custodia offline separada, dos copias selladas con custodios distintos); copia off-host cifrada obligatoria en producción; restore ensayado en local (P26). | Herramientas maduras y self-hosted (pgBackRest 2.59.3, age 1.3.2). |
| ADR-032 | Toolchain reproducible **local al proyecto** (`wallet/.tools/`, gitignored): `scripts/tools/bootstrap` instala sin sudo Node 26 (tarball oficial verificado con SHASUMS256), pnpm 12.14.0 (con el npm de ese Node y verificación de integridad del registry, porque Node 26 ya no trae Corepack), Foundry v1.8.5 (release oficial + `.sha256`), gitleaks 8.30.1 (release + checksums) y Slither 0.11.6 (venv de Python local, o imagen Docker fijada si no hay Python ≥ 3.10); los escáneres de seguridad corren por imágenes Docker fijadas por digest. P00 detecta, auto-remedia y verifica; sólo frena si la remediación es imposible (Docker ausente o sin permisos, sin red, plataforma no soportada). | Las versiones locales no se convierten en blockers manuales y todas las máquinas y CI usan la misma toolchain. |

## 5. Arquitectura del sistema

### 5.1 Trust domains y componentes

```text
                      ┌──────────────────────────── Usuario ────────────────────────────┐
                      │  Password de cuenta   Password U (5 palabras)   Password R (5 p.) │
                      └───────┬───────────────────────┬──────────────────────┬───────────┘
                              │                       │                      │
 TRUST DOMAIN A (U)           │                       │      TRUST DOMAIN B (R)
 ┌────────────────────────────▼──────────┐   ┌───────▼──────────────────────▼──────────────┐
 │ Wallet Frontend  wallet.<WALLET_DOM>  │   │ Recovery Frontend  recovery.<RECOVERY_DOM>  │
 │ - genera/descifra U (en memoria)      │   │ - genera/descifra R o conecta wallet externa│
 │ - OPAQUE(AuthSecret_U) → PlatformSess │   │   (wagmi: injected/MetaMask/Coinbase/WC)    │
 │ - Drive appDataFolder (OAuth Wallet)  │   │ - Drive appDataFolder (OAuth Recovery)      │
 │ - verifica Safe on-chain (RPC propio) │   │ - enrollment de R (Enrollment Key)          │
 │ - NO tiene conectores de wallets      │   │ - recovery de U, cancelación, modo soberano │
 └──────────────┬────────────────────────┘   └──────────────────┬──────────────────────────┘
                │ HTTPS (cookies __Host-, CSRF,                  │ HTTPS (cookies __Host- propias,
                │  PlatformSession + firma de request)           │  step-up + firma de request)
 TRUST DOMAIN C (S)                                               │
 ┌──────────────▼─────────────── api.<WALLET_DOM> ─┬─ api.<RECOVERY_DOM> ───────────────────────┐
 │ Backend (Fastify)  ── Postgres (fuente de verdad) ── Valkey/BullMQ (transporte)           │
 │  auth, sesiones, PlatformSession, wallets, whitelist, send, swap, operations,            │
 │  rotations, recovery, policy (snapshot firmado), audit, email (Mailgun), RPC quórum      │
 │ Worker S (pipeline de ejecución) · Chain watcher/reconciler · Indexer de transfers       │
 │ Gas tank / relayer                                                                       │
 │ (Integrity monitor de releases: contenedor propio + chequeo off-host en GitHub Actions)  │
 │                         │ mTLS sobre red Docker interna (sin puertos publicados)         │
 │ ┌───────────────────────▼──────────────────────────┐                                    │
 │ │ Signer shards: signer-service self-hosted        │ política independiente, DB propia  │
 │ │  S por Safe en keystore V3 cifrado (volumen del  │ RPC propio (quórum)                │
 │ │  shard); credencial de desbloqueo aparte;        │                                    │
 │ │  firma SafeTx y tx execTransaction (msg.sender=S)│                                    │
 │ └──────────────────────────────────────────────────┘                                    │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
                                │ execTransaction (S paga gas)
 ┌──────────────────────────────▼───────────────────────────────────────────────────────────┐
 │ Base mainnet (fork Anvil en local/CI)                                                     │
 │ Safe (SafeL2 singleton + SafeProxyFactory) ← WalletFactory ← SafeBootstrap               │
 │ SecurityGuard (+RotationTimelock) · DenyAllModuleGuard · PolicyRegistry                   │
 │ DestinationWhitelist · SwapExecutor → pool canónico Uniswap USDC/USDT · USDC · USDT       │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
```

Reglas de separación (verificadas por tests y por CI):

1. Ningún código con acceso a U o R en runtime se comparte entre `frontend/wallet` y `frontend/recovery`, ni con backend. Cada frontend implementa (duplicado a propósito, revisado por separado) su capa criptográfica mínima.
2. Lo único compartible entre frontends es **look & feel estático**: `wallet/frontend/design-tokens/tokens.css` (sólo CSS, sin JS). Se copia en build con verificación de hash; no es una dependencia npm.
3. Backend/Signer no tienen credenciales para publicar ni firmar frontends (pipelines de CI y claves de release separadas, fuera de los hosts de producción; ver CF-10 y CF-11 para los riesgos residuales del host del backend y del DNS).
4. El signer **no importa código del backend**: su decodificación y política son una implementación independiente; ambos se contrastan contra los mismos vectores de prueba generados por los contratos (`wallet/contracts/test/vectors/*.json`, copiados a cada consumidor).
5. Frontends leen la cadena con **su propio RPC** (nunca sólo a través del backend) para verificar la Safe, saldos, whitelist y rotaciones pendientes.

### 5.2 Layout del repositorio (todo bajo `wallet/`)

```text
wallet/
├── .env.example                 # variables (sin secretos) — creado en esta preparación
├── .env                         # local, gitignored, placeholders — creado en esta preparación
├── .gitignore                   # ignora .env, .secrets/, artefactos — creado en esta preparación
├── .node-version                # P01
├── package.json                 # P00: sólo orquestación (scripts), sin dependencias de runtime
├── docker-compose.yml           # P00: postgres, valkey, anvil (fork), mailpit
├── docs/
│   ├── PLANNER_WALLET_WEB.md    # este documento
│   ├── SETUP_EXTERNAL_SERVICES.md
│   ├── VERSIONS.md              # P01: versiones exactas + fuentes
│   ├── EXTERNAL_CONTRACTS.md    # P03: direcciones/codehash verificados
│   ├── THREAT_MODEL.md          # P01 (base) → P27 (final)
│   ├── CI.md                    # P02
│   ├── ENVIRONMENTS.md          # P25
│   ├── DEPLOYMENT_VPS.md        # P26: guía para el despliegue manual futuro en la VPS
│   ├── HOW_IT_WORKS.md          # P29
│   ├── SECURITY_AUDIT.md        # P27/P28
│   ├── adr/ADR-0xx-*.md         # P01 (decisiones de §4)
│   ├── security/*.md            # P07+ (invariants, triage de Slither)
│   └── runbooks/*.md            # P03+ (fork, signer, local, deploy, rollback, incidentes, rotación de claves, restore)
├── prompts/promptV1.md          # existente
├── .tools/                      # P00: toolchain local fijado (gitignored; ADR-032)
├── scripts/
│   ├── preflight                # P00 (bash; entrypoint) + scripts/preflight.d/*.mjs
│   ├── tools/bootstrap          # P00: instala Node/pnpm/Foundry/gitleaks/Slither fijados en .tools/
│   ├── start-fork | stop-fork | reset-fork | deploy-local | seed-local   # P00/P07
│   ├── secrets-local            # P00: genera secretos locales aleatorios (nunca staging/prod)
│   ├── deploy/                  # P26: init-secrets, migrate, deploy, healthcheck, verify-images (uso manual futuro)
│   ├── backup/                  # P26: pgBackRest, keystores del signer (age), auditoría, configuración
│   └── lib/*.sh
├── config/
│   ├── chains/base-mainnet.json # P03: direcciones + codehash + bloque de fork
│   ├── policy/<env>/policy-snapshot.json(.sig)  # P11
│   ├── release-keys/{wallet,recovery}.pub       # P20 (sólo claves públicas)
│   └── wordlist/mtw-wordlist-v1.txt (+ .sha256) # P01 (niceware 2^16, inmutable)
├── contracts/                   # Foundry (P04–P07, P25)
│   ├── foundry.toml · remappings.txt · soldeer.lock (dependencias Soldeer fijadas por versión y checksum, o commit)
│   ├── src/ SecurityGuard.sol, RotationTimelock.sol, DenyAllModuleGuard.sol, SafeBootstrap.sol,
│   │        WalletFactory.sol, PolicyRegistry.sol, DestinationWhitelist.sol, SwapExecutorV3.sol,
│   │        interfaces/*, libraries/SafeSignatureParser.sol, libraries/CallDecoder.sol
│   ├── test/ unit/ integration/ fuzz/ invariant/ fork/ adversarial/ vectors/
│   ├── script/ DeployCore.s.sol, DeployLocal.s.sol, SeedLocal.s.sol, DeployBase.s.sol, VerifyDeployment.s.sol
│   └── deployments/ local.json (gitignored) · base-mainnet.json · base-mainnet-staging.json
├── backend/
│   ├── app/                     # API + worker + watcher + indexer + gas tank (P08–P15)
│   ├── signer/                  # signer-service por shard, SelfHostedSoftwareSignerProvider (P11)
│   └── integrity-monitor/       # monitor de releases: contenedor propio con clave de atestación propia + chequeo off-host en GitHub Actions (P20, ADR-023)
├── frontend/
│   ├── design-tokens/           # sólo CSS
│   ├── wallet/                  # app Wallet (P16–P18)
│   └── recovery/                # app Recovery (P16, P19)
├── e2e/                         # Playwright + acceptance full-system (P22–P23)
├── infra/
│   ├── docker/                  # Dockerfiles (P26)
│   ├── production/              # docker-compose.{production,wallet-web,recovery-web}.yml, .env.production.example por servidor, Caddyfiles, pgbackrest/valkey/alertmanager config (P26)
│   └── monitoring/              # reglas de alertas, dashboards (P24/P26)
├── ci/                          # lógica de CI (scripts, composite actions) (P02)
└── tools/
    └── sovereign-exit/          # guía + herramienta offline de salida soberana U+R (P19/P29)
```

Cada uno de `contracts/`, `backend/app/`, `backend/signer/`, `frontend/wallet/`, `frontend/recovery/` y `e2e/` es un proyecto independiente con su propio lockfile (`pnpm-lock.yaml` o `soldeer.lock`). `wallet/package.json` sólo orquesta: no declara dependencias de runtime.

### 5.3 Topología local

| Servicio | Origen | Puerto host | Notas |
|---|---|---|---|
| PostgreSQL 18 | docker compose `postgres` | 55432 | DB `mtw_wallet` (backend) y `mtw_signer_dev` (estado del signer dev) |
| Valkey 9 | docker compose `valkey` | 56379 | AOF activado, `maxmemory-policy noeviction` |
| Anvil (fork Base) | docker compose `anvil` (imagen oficial Foundry, versión fijada) | 8545 | `--fork-url $BASE_RPC_URL --fork-block-number $FORK_BLOCK_NUMBER --chain-id 8453` |
| Mailpit | docker compose `mailpit` | 1025 (SMTP), 8025 (UI/API) | sólo local/CI |
| Backend API (cliente Wallet) | `backend/app` | 8080 | `/api/v1/*`, `/docs` |
| Backend API (cliente Recovery) | mismo proceso, 2º listener | 8081 | endpoints de recovery/enrollment/rotaciones |
| Worker S + watcher + indexer + gas tank | `backend/app` (procesos separados) | — | métricas en 9464+ |
| Signer dev shard | `backend/signer` | 8090 (mTLS) | `SIGNER_PROVIDER=development`; rehúsa arrancar fuera de un fork Anvil |
| Wallet frontend | `frontend/wallet` | 5173 | |
| Recovery frontend | `frontend/recovery` | 5174 | |

Arranque objetivo (P21):

```bash
cd wallet
docker compose up -d
pnpm install          # instala cada proyecto con su lockfile (--frozen-lockfile)
pnpm preflight        # STOP si falta algo; imprime PREFLIGHT PASSED
pnpm dev              # deploy-local + seed-local + backend + worker + signer dev + ambos frontends
```

### 5.4 Flujos principales (resumen; detalle en §6–§8)

**Onboarding**

```text
Wallet: crear cuenta → verificar email → login
  → generar U (CSPRNG) + Password U (5 palabras) → U.enc (Argon2id→HKDF→AES-GCM, AAD)
  → backup obligatorio (Drive appDataFolder Wallet y/o archivo cifrado/QR/palabras)
  → registro OPAQUE(AuthSecret_U) → PlatformSession
  → "Activar Recovery" → QR/link → Recovery: login + step-up → Enrollment Key
  → crear R (o conectar wallet externa + proof-of-control) → R.enc → Drive Recovery
  → RecoveryEnrollment firmado → link/QR de regreso con R
  → Wallet: muestra R, usuario confirma → backend asigna S (shard) y el signer emite SignerKeyAttestation
  → Wallet verifica la atestación, calcula la dirección esperada (CREATE2) y la compara con la del backend
  → U firma WalletCreationAuthorization (U, R, S, salt, Safe esperada) [W-01]
  → WalletFactory.createWallet(U,R,S,salt) (atómico) → verificación on-chain doble
  → CREATING → DEPLOYING → VERIFYING → ACTIVE (recién ahí se muestra la Safe como operativa)
```

**Operación asistida (U+S)**

```text
Wallet construye SafeTx desde la intención → backend prepara la misma SafeTx (bytes idénticos)
→ usuario revisa → U firma EIP-712 → backend valida (sesión, firma, policy, whitelist, saldo, nonce)
→ DB (USER_SIGNED) → outbox → cola → worker S → signer re-verifica → S firma SafeTx y tx
→ execTransaction (msg.sender = S) → Guard on-chain → MINED → CONFIRMED → FINALIZED
```

**Whitelist**: solicitud → challenge ligado (userId, Safe, chainId, destino, acción, nonce, expiresAt) → email con dirección exacta/red/expiración → código en Wallet → U firma `DestinationWhitelist.addDestination(dest)` → S ejecuta → activación on-chain a las 24 h → destino seleccionable en Send.

**Swap**: cotización (QuoterV2/pool) → 2 SafeTx (nonce N: `approve(SwapExecutor, amountIn)`; nonce N+1: `SwapExecutor.swap`) firmadas juntas → ejecución en orden → post-condición allowance 0 → resultado siempre a la Safe.

**Rotación asistida (U, R o S)**: X ∈ {U,R} + S proponen en `RotationTimelock` → email + notificación in-app → 48 h (U o R actuales pueden cancelar con firma individual) → X ∈ {U,R} + S ejecutan `swapOwner` validado por el Guard → roles actualizados.

**Recovery de U perdida**: recuperar cuenta → step-up → PlatformSession (scope U_REPLACEMENT) → generar U' → Recovery: desbloquear R → R firma propuesta U→U' → S valida → 48 h → R firma ejecución → U' activa.

**Soberano U+R** (sin backend): Recovery arma SafeTx tipada → R firma → Wallet importa (QR/archivo), muestra, U firma → Recovery combina firmas → transmite con wallet externa (paga gas) o exporta calldata para cualquier relayer.

### 5.5 Topología de producción (target futuro: tres servidores; no se despliega desde este planner)

Decisión del owner (2026-10-17, ADR-022): el backend corre en la VPS y cada frontend en un servidor propio, distinto del de la otra app y del backend. Cada servidor tiene su propio reverse proxy existente (**fuera del producto**, se configura a mano al desplegar, con el TLS de sus dominios).

**Host del backend (VPS)** — `infra/production/docker-compose.production.yml`:

| Contenedor | Redes | Persistencia | Secrets montados (ADR-030) |
|---|---|---|---|
| `api` (listeners Wallet y Recovery) | edge, backend, signer | — | sesión, CSRF, emisor, OPAQUE, field key, OTP, pepper, audit, DB app, Valkey, mTLS cliente |
| `worker`, `watcher`, `indexer`, `gas-tank` | backend, signer | — | DB app, Valkey, mTLS cliente, RPC |
| `integrity-monitor` | backend (+ salida a internet) | — | clave de atestación del monitor |
| `signer-shard-<id>` (uno por shard) | signer (`internal: true`) | volumen `signer-<id>-keystore` | credencial de desbloqueo del shard (directorio aparte), clave de atestación del signer, DB del signer, mTLS servidor, RPC propio |
| `postgres` (backend) | backend (`internal: true`) | volumen `pg-data` + repo pgBackRest | superusuario (sólo bootstrap), roles `mtw_migrator`/`mtw_app`/`mtw_readonly` |
| `signer-postgres` | signer (`internal: true`) | volumen `signer-pg-data` + repo pgBackRest | roles del signer |
| `valkey` | backend (`internal: true`) | volumen `valkey-data` (AOF + RDB) | usuario ACL de la cola |
| perfil `observability`: `prometheus`, `alertmanager`, `grafana` (opcional) | backend | volúmenes propios | SMTP de alertas |

**Servidor de Wallet** — `infra/production/docker-compose.wallet-web.yml`: `wallet-web` (Caddy sirviendo el bundle estático con sus headers; imagen inmutable, sin persistencia ni secretos).

**Servidor de Recovery** — `infra/production/docker-compose.recovery-web.yml`: `recovery-web` (ídem, imagen propia).

Reglas: los puertos internos de cada aplicación son fijos (API 8080/8081, estáticos 8080); hacia cada host sólo se publican la API (host del backend) y el contenedor estático (servidor de cada frontend), con binds configurables en el `.env.production` de cada servidor (`*_BIND`, sin defaults de producción en el código); TLS termina en el reverse proxy de cada servidor y la API sólo confía en `X-Forwarded-*` desde `TRUSTED_PROXY_CIDRS`; ningún componente depende de un proveedor cloud. El ensayo local de producción levanta los tres compose en una sola máquina.

## 6. Especificación on-chain

Proyecto `wallet/contracts` (Foundry). Reglas generales **[C-GEN]**: solc fijado (§3.6), sin proxies ni upgradeability, sin owner salvo `PolicyRegistry` (admin = Governance Safe + guardianes), errores custom, eventos en todo cambio de estado, NatSpec completo, transient storage (EIP-1153) para contexto por transacción, ninguna llamada externa a contratos no fijados en config.

### 6.1 Contratos y dependencias

```text
DenyAllModuleGuard        (sin dependencias)
DestinationWhitelist      (sin dependencias)
SwapExecutorV3            → USDC, USDT, UniswapV3Pool 0,01 %, UniswapV3Factory (verificación)
PolicyRegistry            → admin (Governance Safe), guardianes, tokens soportados, swap executors
SecurityGuard             → PolicyRegistry, DestinationWhitelist, DenyAllModuleGuard, WalletFactory (dirección predicha); despliega RotationTimelock en su constructor
SafeBootstrap             → SecurityGuard, DenyAllModuleGuard (sólo vía DELEGATECALL desde Safe.setup)
WalletFactory             → SafeProxyFactory 1.5.0, SafeL2 1.5.0, SafeBootstrap, SecurityGuard, … (sólo verificación)
```

Orden de deploy: `DenyAllModuleGuard` → `DestinationWhitelist` → `SwapExecutorV3` → `PolicyRegistry` → `SecurityGuard` (+`RotationTimelock`) → `SafeBootstrap` → `WalletFactory`. El Guard recibe como inmutable la dirección **predicha** de `WalletFactory` (`CREATE` desde el deployer con nonce conocido, `vm.computeCreateAddress`); `DeployCore` verifica al inicio el nonce del deployer y al final que la dirección real coincide con la predicha (si no coincide, el deploy se descarta completo).

### 6.2 `SafeSignatureParser` (library) [C-PAR]

- **[C-PAR-01]** `thresholdSigners(bytes32 dataHash, bytes signatures, uint256 threshold) → (address[] signers, SigType[] types)`: recorre **sólo** las primeras `threshold` firmas estáticas de 65 bytes (`r ‖ s ‖ v`, mismo layout y lectura de `v` que `signatureSplit` de Safe 1.5.0): `v == 0` → owner = `address(uint160(uint256(r)))` (CONTRACT); `v == 1` → idem (APPROVED_HASH); `v > 30` → `ecrecover(toEthSignedMessageHash(dataHash), v - 4, r, s)` (ETH_SIGN); resto → `ecrecover(dataHash, v, r, s)` (ECDSA). Revierte si `signatures.length < threshold * 65` o si algún signer es `address(0)`. Nunca lee bytes anexados más allá de lo que Safe valida.
- **[C-PAR-02]** Test diferencial (fuzz): para blobs de firmas aleatorios/válidos/maliciosos, el resultado del parser coincide con la aceptación y los signers que surgen de `checkNSignatures` de la Safe real del fork.

### 6.3 `CallDecoder` (library) [C-DEC]

- **[C-DEC-01]** `selectorOf(data)`: `bytes4(0)` si `data.length == 0`; revierte si `0 < length < 4`.
- **[C-DEC-02]** Decoders con **longitud exacta** (rechazan bytes extra o encoding ambiguo): `transfer(address,uint256)` (68), `approve(address,uint256)` (68), `swap(address,uint256,uint256,uint256)` (132), `addDestination(address)`/`removeDestination(address)` (36), `propose(uint8,address,address)` (100), `cancel(bytes32)` (36), `swapOwner(address,address,address)` (100).
- **[C-DEC-03]** Lista de selectores de **autoridad económica** siempre denegados en camino asistido (además del default DENY de RESTRICTED): `approve` (salvo [C-GRD-07]), `increaseAllowance`, `decreaseAllowance`, `permit` (EIP-2612 y variante DAI), `setApprovalForAll`, `transferFrom`, `authorizeOperator`/`send` (ERC-777), `transferWithAuthorization`/`receiveWithAuthorization` (EIP-3009), `transferAndCall`/`approveAndCall`, `safeTransferFrom`/`safeBatchTransferFrom` (ERC-721/1155) y **cualquier llamada a Permit2**.

### 6.4 `SecurityGuard` [C-GRD]

Inmutable, sin owner, compartido por todas las Safes. Inmutables: `POLICY_REGISTRY`, `DESTINATION_WHITELIST`, `DENY_ALL_MODULE_GUARD`, `WALLET_FACTORY` (predicha), `SAFE_L2_SINGLETON`, `SAFE_PROXY_RUNTIME_CODEHASH`, `ROTATION_TIMELOCK` (creado en el constructor con `new RotationTimelock(address(this))`), `MAX_SWAP_SLIPPAGE_BPS = 50`. Storage: `roles[safe] = {userKey, recoveryKey, executor, initialized, version}`. Contexto por Safe en transient storage, **apilado por profundidad** (`depth[safe]`), para soportar ejecuciones soberanas anidadas.

- **[C-GRD-01] `initializeSafe(U, R, S)`** — llamado por la propia Safe durante `setup` (vía `SafeBootstrap`). **Anti-suplantación**: exige `msg.sender.codehash == SAFE_PROXY_RUNTIME_CODEHASH`, singleton (slot 0 vía `getStorageAt`) `== SAFE_L2_SINGLETON` y `IWalletFactory(WALLET_FACTORY).isCreating(msg.sender) == true` (marca transitoria que la factory pone sólo durante su propio `createWallet`), de modo que **sólo Safes creadas por la WalletFactory** pueden registrarse; exige no inicializada; U, R, S distintas, ≠ 0, ≠ sentinel `0x1`, ≠ Safe; owners de la Safe == {U, R, S} exactos; threshold == 2; slot de guard == este contrato; slot de module guard == `DENY_ALL_MODULE_GUARD`; slot de fallback == 0; sin módulos. Guarda roles y emite `SafeRegistered(safe, U, R, S)`.
- **[C-GRD-02]** Vistas: `rolesOf(safe)`, `isRegistered(safe)`, `evaluateAssisted(safe, role, to, value, data) → (bool ok, bytes32 reason)` (misma lógica que [C-GRD-05..13], sin efectos; la usan backend y signer como pre-check).
- **[C-GRD-03] `checkTransaction`** (Safe ya validó firmas antes de llamarlo — §3.2):
  1. Safe registrada (si no: `UnregisteredSafe`); se **apila siempre** un contexto nuevo (`depth[safe]++`) con el marcador de camino; en camino ASSISTED se exige además que no haya otra ejecución de esa Safe en curso (`depth == 1`).
  2. `txHash = getTransactionHash(…, nonce() - 1)`; `signers = SafeSignatureParser.thresholdSigners(txHash, signatures, getThreshold())`.
  3. **Si `executor ∉ signers` → camino SOVEREIGN**: se guarda el marcador `SOVEREIGN` (siempre) y, si la llamada es `swapOwner` directo a la propia Safe, `(old, new)` para sincronizar roles en [C-GRD-04]. Sin chequeos de negocio y **sin ningún `revert` posible** en este camino (las operaciones vía DELEGATECALL/MultiSend o que retiran el Guard también pasan). Fin.
  4. **Camino ASSISTED**: `msgSender == executor` (`WrongExecutor`); threshold == 2 y exactamente 2 signers; ambas firmas tipo ECDSA (`UnsupportedSignatureType`); X = signer ≠ S; rol(X) ∈ {U, R} (`UnknownCosigner`).
  5. Invariantes estructurales: `operation == CALL` (`DelegateCallForbidden`), `safeTxGas == baseGas == gasPrice == 0`, `gasToken == refundReceiver == address(0)`, `value == 0` (V1 no mueve ETH en camino asistido).
  6. Estado previo intacto: fallback = 0, module guard = DenyAll, sin módulos, 3 owners, threshold 2. Si U+R alteraron la estructura por camino soberano, el camino asistido queda deshabilitado (fail-closed) hasta que U+R la restauren o actualicen roles con [C-GRD-14].
  7. Clasificación de la operación ([C-GRD-05..13]); `POLICY_REGISTRY.isOpAllowed(opType, rol)` (en BOOTSTRAP: true para opTypes conocidos; operaciones desconocidas: permitidas en BOOTSTRAP salvo selectores de [C-DEC-03] y llamadas administrativas; **denegadas siempre en RESTRICTED**).
  8. Guardar contexto para post-checks.
- **[C-GRD-04] `checkAfterExecution(txHash, success)`**: desapila el contexto de la Safe (`depth[safe]--`). SOVEREIGN (o contexto ausente, que nunca debería ocurrir): **nunca revierte**; si hubo `swapOwner` directo exitoso de una clave con rol, actualiza ese rol (`RolesSynced`); cualquier otro cambio de roles (p. ej. dentro de un MultiSend) se resincroniza con [C-GRD-14] y lo detecta la reconciliación off-chain ([B-FIN-03]). ASSISTED, en este orden: (1) `success == true`; (2) post-checks y efectos del opType ([C-GRD-09] saldos/allowance, [C-GRD-12] `markExecuted` + actualización de rol); (3) estado posterior intacto (fallback 0, module guard DenyAll, sin módulos, guard == este contrato, threshold 2, owners == roles ya actualizados); (4) limpia contexto.
- **[C-GRD-05] NOOP** (cancelación de nonce): `to == safe`, `data` vacío → permitido para U y R.
- **[C-GRD-06] TRANSFER** `token.transfer(dest, amount)` (cualquier token): `amount > 0`; `dest ∉ {safe, contratos del sistema, tokens soportados, 0}`. Rama **migración** si y sólo si `POLICY_REGISTRY.isMigrationAuthorized(safe, dest)`: `dest` registrada en este Guard (por [C-GRD-01] ⇒ creada por la WalletFactory) **y** el rol del firmante coincide en el destino (`rolesOf(dest).userKey == U` si firma U; `rolesOf(dest).recoveryKey == R` si firma R); opType `MIGRATION_TRANSFER`. Si no hay autorización de migración: rol U → `DESTINATION_WHITELIST.isWhitelisted(safe, dest)` (opType `TRANSFER`); rol R → revert. En RESTRICTED además `isSupportedToken(token)`.
- **[C-GRD-07] APPROVE**: sólo si `token` es soportado y `spender` es un swap executor registrado; rol U: `amount ≤ balanceOf(safe)`; rol R: sólo `amount == 0` (revocación). Cualquier otro spender → `EconomicAuthorityDenied`. (On-chain no se puede ligar el approve N a su swap N+1: el emparejamiento exacto `amount == amountIn` del swap N+1 lo exigen backend y signer, y la seguridad de la allowance residual depende de que todo executor registrado debite **sólo** a `msg.sender` — requisito obligatorio de registro, ver [C-SWP-05].)
- **[C-GRD-08] Autoridades económicas**: selectores de [C-DEC-03] → `EconomicAuthorityDenied` en ambos modos.
- **[C-GRD-09] SWAP** `executor.swap(tokenIn, amountIn, minOut, deadline)`: executor registrado; rol U; `tokenIn` soportado y `tokenOut = executor.tokenOutFor(tokenIn)` soportado; mismos decimales; `amountIn > 0`; `minOut ≥ amountIn·(10_000 − MAX_SWAP_SLIPPAGE_BPS)/10_000`; `deadline ≥ block.timestamp`. Contexto: saldos previos de `tokenIn`/`tokenOut` de la Safe. **Post**: `saldoIn_antes − saldoIn_después ≤ amountIn`, `saldoOut_después − saldoOut_antes ≥ minOut`, `allowance(safe, executor)` de `tokenIn` == 0.
- **[C-GRD-10] WHITELIST**: `addDestination(dest)` sólo rol U, `dest ∉ {safe, contratos del sistema, tokens soportados, swap executors, 0}`; `removeDestination(dest)` roles U o R.
- **[C-GRD-11] ROTATION_PROPOSE / CANCEL** sobre `ROTATION_TIMELOCK`: `propose(kind, old, new)` — rol U puede proponer U, R, S, GUARD o MODULE_GUARD; rol R puede proponer U o S (nunca R, nunca GUARD); para S el backend y el signer exigen además que `new` sea una clave creada por el signer para esa wallet ([B-SIG-02]); `old == rolesOf(safe)[role]`; `new ∉ {U, R, S actuales, 0, sentinel, safe, contratos del sistema}`. `cancel(id)` roles U o R.
- **[C-GRD-12] ROTATION_EXECUTE** `safe.swapOwner(prev, old, new)`: debe existir propuesta `PENDING` madura en el timelock para `(safe, role, old, new)` y `rolesOf(safe)[role] == old`. Post: `ROTATION_TIMELOCK.markExecuted(id)` y actualización del rol (`RoleRotated(safe, role, old, new)`); si role == S el nuevo executor rige desde la siguiente tx.
- **[C-GRD-13]** Cualquier otra llamada a la propia Safe (owners, threshold, guard, module guard, módulos, fallback, `approveHash`, `execTransaction`, `simulateAndRevert`…) o a contratos del sistema (Guard, PolicyRegistry, DenyAllModuleGuard, SafeBootstrap, WalletFactory, funciones del timelock distintas de `propose/cancel`) → `AdminCallForbidden` en camino asistido.
- **[C-GRD-14] `updateRoles(U, R, S)`**: sólo `msg.sender == safe` registrada (en la práctica sólo alcanzable por camino soberano, porque [C-GRD-13] lo bloquea en el asistido); exige que sean owners actuales y distintos.
- **[C-GRD-15]** `supportsInterface`: `0xe6d7a83a` (ITransactionGuard) y `0x01ffc9a7` (IERC165).
- **[C-GRD-17] GUARD_UPGRADE** (vía de corrección para Safes existentes): en camino asistido se permite `safe.setGuard(newGuard)` / `safe.setModuleGuard(newModuleGuard)` **sólo** si (a) `newGuard`/`newModuleGuard` está registrado y activo como sucesor en `PolicyRegistry` ([C-POL-06], 24 h + guardianes) y (b) existe en `RotationTimelock` una propuesta madura (48 h) y no cancelada de tipo `GUARD`/`MODULE_GUARD` para esa Safe con ese valor ([C-RTL-02]); U o R pueden cancelarla individualmente. En el post-check de esa operación el slot debe valer el sucesor (excepción explícita al chequeo "guard == este contrato"). El sucesor debe implementar la importación de roles desde este Guard (`rolesOf`) en su primer uso.
- **[C-GRD-16]** Tamaño: si el runtime supera 24.576 bytes, mover la evaluación a un contrato `AssistedPolicyEngine` inmutable y sin estado (llamado por `staticcall`, dirección y codehash fijados en el Guard) — decisión a tomar con `forge build --sizes` en P05.

### 6.5 `RotationTimelock` [C-RTL]

- **[C-RTL-01]** `GUARD` (constructor), `DELAY = 48 hours` (constante), dominio EIP-712 `("MTW RotationTimelock", "1", chainId, address(this))`.
- **[C-RTL-02] `propose(kind, oldValue, newValue) → id`**: `kind ∈ {U, R, S, GUARD, MODULE_GUARD}`; `msg.sender` = Safe registrada en el Guard; a lo sumo una propuesta activa por (safe, kind); para U/R/S `GUARD.rolesOf(safe)[kind] == oldValue`; para GUARD/MODULE_GUARD `oldValue` == slot actual y `newValue` sucesor registrado en `PolicyRegistry`; `id = keccak256(abi.encode(chainId, this, safe, kind, oldValue, newValue, ++count[safe]))`; `executableAt = now + 48 h`; evento `RotationProposed`.
- **[C-RTL-03] `cancel(id)`** por la propia Safe; **`cancelWithSignature(id, signature)`** por cualquiera con firma EIP-712 `CancelRotation(bytes32 proposalId,address safe)` de la U **o** R **vigente** (ECDSA 65 bytes, low-s); válido mientras la propuesta esté `PENDING` (antes o después de madurar, hasta que se ejecute). Evento `RotationCancelled(id, signer)`.
- **[C-RTL-04] `markExecuted(id)`** sólo `GUARD`, exige `PENDING` y `now ≥ executableAt`.
- **[C-RTL-05]** Vistas `getProposal(id)`, `activeProposal(safe, role)`, `executableProposal(safe, old, new)`.

### 6.6 `PolicyRegistry` [C-POL]

- **[C-POL-01]** Inmutables: `ADMIN` (Governance Safe), `ACTIVATION_DELAY = 24 hours`. Modo `BOOTSTRAP | RESTRICTED`; `enterRestricted()` (admin, **unidireccional**). Constructor con modo inicial y entradas iniciales activas (staging/producción: RESTRICTED + set V1).
- **[C-POL-02]** Registros: `opPermission[opType][role]` (opTypes: NOOP, TRANSFER, APPROVE, APPROVE_REVOKE, SWAP, WHITELIST_ADD, WHITELIST_REMOVE, ROTATION_PROPOSE, ROTATION_CANCEL, ROTATION_EXECUTE, MIGRATION_TRANSFER, GUARD_UPGRADE; además UNKNOWN, que sólo BOOTSTRAP admite); `supportedToken[token] = {decimals}`; `swapExecutor[executor]`; `migrationAuthorization[oldSafe][newSafe]`; `guardians`.
- **[C-POL-03]** BOOTSTRAP: el admin modifica registros de inmediato. RESTRICTED: altas por `propose…` (admin) → `PENDING` 24 h → `activate…` (cualquiera); `cancel…` por admin o cualquier guardián durante el pending (la baja de un guardián sólo la pueden cancelar **otros** guardianes); `revoke…` inmediato por admin o guardián (endurecer nunca espera).
- **[C-POL-04]** Set V1 de permisos (staging/producción): U → NOOP, TRANSFER, APPROVE, APPROVE_REVOKE, SWAP, WHITELIST_ADD, WHITELIST_REMOVE, ROTATION_PROPOSE, ROTATION_CANCEL, ROTATION_EXECUTE, MIGRATION_TRANSFER, GUARD_UPGRADE; R → NOOP, APPROVE_REVOKE, WHITELIST_REMOVE, ROTATION_PROPOSE, ROTATION_CANCEL, ROTATION_EXECUTE, MIGRATION_TRANSFER. Tokens: USDC, USDT (6 decimales). Executors: `SwapExecutorV3`.
- **[C-POL-05]** Gobierna **sólo** el camino asistido; el Guard nunca lo consulta en camino soberano.
- **[C-POL-06]** Registro de **sucesores** (`successorGuard[oldGuard]`, `successorModuleGuard[old]`) con alta por timelock de 24 h y cancelación por guardianes; requisito de alta: auditoría del sucesor, codehash publicado y suite P07 completa en verde contra el sucesor. Habilita [C-GRD-17].

### 6.7 `DestinationWhitelist` [C-WHL]

- **[C-WHL-01]** `ACTIVATION_DELAY = 24 hours` (inmutable). Por Safe: `EnumerableSet` de destinos + `activatesAt`.
- **[C-WHL-02]** `addDestination(dest)` (sólo `msg.sender` = la Safe; `dest ≠ 0`, `dest ≠ msg.sender`, no existente) → `DestinationAdded(safe, dest, activatesAt)`. `removeDestination(dest)` → `DestinationRemoved`.
- **[C-WHL-03]** `isWhitelisted(safe, dest)` = existe y `now ≥ activatesAt`; `destinationsOf(safe)` y `destinationInfo(safe, dest)` para lectura directa desde los frontends.

### 6.8 `SwapExecutorV3` [C-SWP]

- **[C-SWP-01]** Inmutables: `TOKEN0 = USDC`, `TOKEN1 = USDT`, `POOL` (v3 0,01 %), `FACTORY`, `FEE = 100`, `MAX_SLIPPAGE_BPS = 50`. El constructor verifica `FACTORY.getPool(TOKEN0, TOKEN1, FEE) == POOL`, `token0/token1` del pool y decimales iguales.
- **[C-SWP-02] `swap(tokenIn, amountIn, minAmountOut, deadline) → amountOut`** (nonReentrant con transient storage): `tokenIn ∈ {USDC, USDT}`; `amountIn > 0`; `deadline ≥ now`; `minAmountOut ≥ amountIn·(1 − 0,5 %)`; **payer = recipient = `msg.sender`** (no es parámetro); `POOL.swap(recipient, zeroForOne, int256(amountIn), límite de precio extremo, "")`; exige **fill completo** (`pagado == amountIn`) y `amountOut ≥ minAmountOut`; verifica delta de saldo del recipient; evento `Swapped`.
- **[C-SWP-03] `uniswapV3SwapCallback`**: sólo `msg.sender == POOL` y con swap activo (transient); toma **exactamente** el delta positivo que pide el pool para `tokenIn`, exige que sea `== amountIn` (fill completo; si no, revert) y paga con `transferFrom(payer, POOL, delta)` (consume exactamente la allowance de la Safe → queda 0). Nunca paga un monto distinto del pedido.
- **[C-SWP-05] Requisitos obligatorios para registrar cualquier executor** (V3 o futuros): inmutable y sin admin; único `transferFrom` posible con `from == msg.sender` del `swap`; recipient fijo = `msg.sender`; mismo ABI `swap(tokenIn, amountIn, minOut, deadline)`; suite de tests P06/P07 aplicada al executor nuevo en verde; auditoría. Sin esto, una allowance residual entre las SafeTx N y N+1 podría ser debitada por el executor.
- **[C-SWP-04]** Sin admin, sin funciones de retiro, nunca custodia fondos (tests verifican saldo 0 del executor tras cada operación). `tokenOutFor(tokenIn)` y la interfaz `ISwapExecutor` permiten registrar a futuro un `SwapExecutorV4` (pool v4 fee 5) vía PolicyRegistry con timelock, si la liquidez lo justifica.

### 6.9 `DenyAllModuleGuard` [C-MGD]

`checkModuleTransaction` y `checkAfterModuleExecution` revierten siempre (`ModuleTransactionsDisabled`); `supportsInterface(0x58401ed8)`; sin estado ni owner.

### 6.10 `SafeBootstrap` [C-BST]

- **[C-BST-01]** Sin variables de estado; inmutables `SECURITY_GUARD`, `DENY_ALL_MODULE_GUARD`, `SELF`.
- **[C-BST-02] `bootstrap(U, R, S)`**: revierte si `address(this) == SELF` (sólo DELEGATECALL); `ISafe(address(this)).setGuard(SECURITY_GUARD)`; `ISafe(address(this)).setModuleGuard(DENY_ALL_MODULE_GUARD)`; `SECURITY_GUARD.initializeSafe(U, R, S)`.

### 6.11 `WalletFactory` [C-FAC]

- **[C-FAC-01]** Inmutable, sin owner. Inmutables: `SAFE_PROXY_FACTORY`, `SAFE_SINGLETON` (SafeL2), `SAFE_BOOTSTRAP`, `SECURITY_GUARD`, `DENY_ALL_MODULE_GUARD`, `ROTATION_TIMELOCK`, `POLICY_REGISTRY`, `DESTINATION_WHITELIST`, codehash esperados (singleton, proxy factory, runtime del proxy, `keccak(proxyCreationCode)`), `THRESHOLD = 2`, `CHAIN_ID`.
- **[C-FAC-02]** Constructor verifica codehash de singleton y proxy factory, hash de `proxyCreationCode`, `VERSION() == "1.5.0"`, y que los inmutables de `SafeBootstrap` y `SecurityGuard` apuntan a los contratos esperados.
- **[C-FAC-03]** `initializerFor(U, R, S)` = `setup([U, R, S], 2, SAFE_BOOTSTRAP, bootstrap(U, R, S), fallbackHandler = 0, paymentToken = 0, payment = 0, paymentReceiver = 0)`. **El backend sólo aporta U, R, S y salt** (V9 §16).
- **[C-FAC-04]** `predictWalletAddress(U, R, S, saltNonce)` con la fórmula CREATE2 de §3.2.
- **[C-FAC-05] `createWallet(U, R, S, saltNonce)`** (permissionless): valida claves; si la dirección predicha ya es `isWallet` → devuelve esa Safe (idempotente); si tiene código sin ser `isWallet` → revert (no puede ocurrir: sin la marca de la factory el `setup` revierte en [C-GRD-01]); si no → marca transitoria `creating[predicted] = true`, `createProxyWithNonceL2` (deploy + init atómicos), borra la marca, y verifica en la misma tx: runtime codehash del proxy, singleton (slot 0), owners == {U, R, S}, threshold == 2, nonce == 0, guard, module guard, fallback == 0, sin módulos, `rolesOf(safe) == (U, R, S)`, `block.chainid == CHAIN_ID`; marca `isWallet[safe]` y emite `WalletCreated(safe, U, R, S, saltNonce, initializerHash)`.
- **[C-FAC-06]** `verifyWallet(safe) → (bool ok, bytes32 reason)` (vista) — conveniencia; los frontends **además** verifican por lectura directa. `isCreating(address) → bool` (vista sobre la marca transitoria de [C-FAC-05], la consulta el Guard en [C-GRD-01]) e `isWallet(address) → bool`.

### 6.12 Scripts [C-SCR]

- **[C-SCR-01]** `DeployCore.s.sol` (orden de §6.1) parametrizado por red; escribe `deployments/<red>.json` con: addresses, codehash de runtime, argumentos de constructor, versión de solc, settings de optimizer/evm, commit git, timestamp, chainId, deployer.
- **[C-SCR-02]** `VerifyDeployment.s.sol`: re-lee todo on-chain y compara contra el JSON y `config/chains/base-mainnet.json`.
- **[C-SCR-03]** `DeployLocal.s.sol` + `SeedLocal.s.sol` (P07): deploy en el fork, Governance Safe local, usuario de prueba, U/R/S determinísticas desde `LOCAL_SEED` (claves nuevas, nunca cuentas públicas de Anvil), Safe creada por la factory, fondeo con USDC/USDT **reales** del fork (`deal` sobre el storage real del token o impersonación de un holder real, sólo en el script de seed).
- **[C-SCR-04]** `DeployBase.s.sol` (P25/P30): firma con keystore cifrado (`--keystore` + `--password-file`) o con hardware wallet (`--ledger`/`--trezor`); nunca con private key en env; requiere `--broadcast` explícito. Durante la ejecución sólo transmite al fork; contra Base mainnet sólo en el despliegue final, con claves nuevas y aprobación escrita del owner.

## 7. Especificación backend y signer

Proyecto `wallet/backend/app` (API, worker, watcher, indexer, gas tank; un solo package con varios entrypoints), proyecto independiente `wallet/backend/signer` (signer-service por shard) e **integrity monitor** (`wallet/backend/integrity-monitor`, proyecto propio que en producción corre en su propio contenedor con su propia clave de atestación, más un chequeo off-host en GitHub Actions — ADR-023).

### 7.1 Autenticación de cuenta [B-AUTH]

- **[B-AUTH-01] Registro**: `email` (normalizado NFKC + lowercase, único por `platform_id`), `password` de login (mín. 12 caracteres, máx. 128, chequeo contra las 100.000 passwords más comunes de **SecLists** (`Passwords/Common-Credentials/`, licencia MIT), vendorizadas fijando commit y SHA-256 — sin llamadas externas). Hash: Argon2id (`@node-rs/argon2`) m=64 MiB, t=3, p=1, sobre `HMAC-SHA256(PASSWORD_PEPPER_vN, password)`; se guarda `pepper_version`.
- **[B-AUTH-02] Verificación de email** obligatoria antes de cualquier operación de wallet: OTP de 8 dígitos (TTL 15 min, 5 intentos, single-use).
- **[B-AUTH-03] Login**: email + password (+ TOTP si está habilitado). Respuesta idéntica y tiempo constante aproximado para usuario inexistente (hash dummy). Al éxito: nueva sesión (rotación), revocación del id previo si existía.
- **[B-AUTH-04] Sesiones de cuenta**: id aleatorio de 256 bits en cookie `__Host-mtw_sid` (listener Wallet) o `__Host-mtr_sid` (listener Recovery); `HttpOnly; Secure; SameSite=Strict; Path=/`; en DB sólo `sha256(id)`. Idle timeout 30 min, absoluto 12 h. Rotación en login, step-up y cambio de privilegios. Listado y revocación individual/total.
- **[B-AUTH-05] CSRF**: además de SameSite=Strict, todo método no-GET exige `X-CSRF-Token = base64url(HMAC-SHA256(CSRF_SECRET, sessionId))` (entregado por `GET /api/v1/auth/csrf`), `Origin` exacto permitido para ese listener y `Content-Type: application/json`.
- **[B-AUTH-06] Logout**: revoca la sesión y todas las PlatformSessions hijas; borra cookie.
- **[B-AUTH-07] Forgot/Reset password**: token de 256 bits por email (link a `/reset-password#token=…`, fragmento para que no quede en logs), TTL 30 min, single-use, invalidado por un nuevo pedido. Reset → revoca **todas** las sesiones y PlatformSessions, notifica por email. **No toca** U.enc, registros OPAQUE ni nada de U/R.
- **[B-AUTH-08] Brute force / riesgo**: contador por cuenta y por IP; tras 5 fallos en 15 min se exige espera exponencial; tras 10, bloqueo blando de la cuenta (desbloqueo por email OTP). Alertas por picos (credential stuffing).
- **[B-AUTH-09] TOTP (RFC 6238)**: opcional, recomendado en onboarding; secreto 160 bits cifrado con `APP_FIELD_ENCRYPTION_KEY` (AES-256-GCM, AAD = userId); anti-replay por `last_used_step`; 10 códigos de recuperación (hash Argon2id). Si está activo es obligatorio en login y en step-up.

### 7.2 PlatformSession [B-PSES]

- **[B-PSES-01]** Estructura (V9 §3) extendida: `{userId, safe, platformId, sessionPublicKey, sessionId, issuedAt, expiresAt, scope, authMethod, accountSessionId}`; `scope ∈ {OPERATIONS, ONBOARDING, RECOVERY, U_REPLACEMENT, ENROLLMENT, KEY_RESTORE}`; `authMethod ∈ {OPAQUE_U, STEP_UP}`. Duración 15 min, no renovable (se re-autentica). `OPERATIONS` sólo se obtiene por OPAQUE con un registro ACTIVE (wallet ACTIVE); `ONBOARDING` (registrar U + registro OPAQUE inicial, activar Recovery, incorporar R, deploy) se obtiene por step-up porque todavía no existe registro OPAQUE utilizable.
- **[B-PSES-02] OPAQUE** (RFC 9807, `@serenity-kit/opaque`, ver §3): registro al crear U (y al cambiar Password U o activar U'); login para desbloquear la Wallet. La entrada OPAQUE es `hex(AuthSecret_U)` (ya estirado con Argon2id y de alta entropía), por lo que el `keyStretching` de OPAQUE se fija en `{"argon2id-custom": {memory: 16384, iterations: 1, parallelism: 1}}` (KiB) — **idéntico** en registro y login, versionado en `opaque_records`. `OPAQUE_SERVER_SETUP` es secreto de larga vida (Docker Compose secret en staging/producción, ADR-030). El cliente vincula la `sessionPublicKey` enviando `HMAC(opaqueSessionKey, sessionPublicKeyJwkThumbprint ‖ loginAttemptId)` en el mensaje final.
- **[B-PSES-03] Step-up** (sin U): cuenta autenticada + email OTP (+ TOTP si activo) → PlatformSession con `scope` restringido (ONBOARDING, RECOVERY, U_REPLACEMENT, ENROLLMENT). Nunca otorga `OPERATIONS`; `ONBOARDING` deja de emitirse cuando la wallet del usuario está ACTIVE. `KEY_RESTORE` (restaurar U en un dispositivo nuevo desde las 17 palabras, sin Password U previa, **o** re-registrar OPAQUE tras una rotación de `OPAQUE_SERVER_SETUP`) exige además **prueba de posesión**: firma EIP-712 `KeyRestore {userId, walletId, keyAddress, nonce, chainId}` con la U restaurada, que debe coincidir con el rol U vigente on-chain; sólo permite reemplazar el registro OPAQUE de esa misma U.
- **[B-PSES-04] Token**: JWS compacto EdDSA (Ed25519, lib `jose`) firmado con `SESSION_ISSUER_PRIVATE_KEY`; audiencia `mtw-api` y `mtw-signer`. Viaja en header `X-Platform-Session` (no cookie).
- **[B-PSES-05] Requests críticos** (crear/firmar operaciones, whitelist, rotaciones, enrollment, cancelaciones): header `X-Session-Signature` = ECDSA P-256 sobre `MTW-REQ-V1\n{method}\n{path}\n{sha256(body)}\n{timestamp}\n{requestNonce}\n{sessionId}`; timestamp ±60 s; `requestNonce` único (Valkey `SET NX` TTL 5 min). La session key se genera con WebCrypto `extractable=false` y vive sólo en memoria.
- **[B-PSES-06] Envelope de envío**: al enviar una firma U/R el cliente firma también `MTW-SUBMIT-V1 {operationId, safeTxHash, sessionId, submittedAt}`; backend y signer lo verifican (V9 §8: firmas fuera de una PlatformSession válida se ignoran). La validez se evalúa **al momento del envío**: `issuedAt ≤ submittedAt ≤ expiresAt` del token y envelope firmado por su session key; la ejecución puede ocurrir después (nonce menor pendiente, swap N+1, reintentos, reorg) siempre que la operación no supere la **antigüedad máxima de 24 h** desde `submittedAt` (pasado ese plazo pasa a FAILED_FINAL `SIGNATURE_STALE` y se ofrece re-firmar o cancelar).

### 7.3 Modelo de datos PostgreSQL [B-DB]

Migraciones con Kysely Migrator (archivos TS con SQL explícito), patrón expand/contract (compatibles hacia atrás para permitir rollback de aplicación sin "down"). Roles de DB: `mtw_migrator` (DDL), `mtw_app` (DML sin DELETE/UPDATE sobre `audit_events`), `mtw_readonly`.

| Tabla | Columnas clave | Constraints / índices |
|---|---|---|
| `users` | id uuid PK, platform_id, email citext, email_verified_at, password_hash, pepper_version, status (ACTIVE/LOCKED/DISABLED), failed_login_count, locked_until, totp_enabled, global_user_id null (futuro, ver doc de negocio), created_at, updated_at | UNIQUE(platform_id, email) |
| `sessions` | id uuid PK, user_id FK, client (WALLET/RECOVERY), token_hash bytea, created_at, last_seen_at, idle_expires_at, absolute_expires_at, rotated_from_id, revoked_at, revoke_reason, ip_prefix, user_agent | UNIQUE(token_hash); idx(user_id, revoked_at) |
| `platform_sessions` | id uuid PK, account_session_id FK, user_id FK, wallet_id FK null, scope, auth_method, session_public_key_jwk jsonb, issued_at, expires_at, revoked_at | idx(user_id, expires_at) |
| `opaque_records` | id, user_id FK, wallet_id FK, key_version int, registration_record bytea, status (PENDING/ACTIVE/RETIRED), created_at, activated_at | UNIQUE(wallet_id) WHERE status='ACTIVE' |
| `totp_factors` | user_id PK FK, secret_ciphertext bytea, last_used_step bigint, recovery_code_hashes text[], enabled_at | — |
| `wallets` | id uuid PK, user_id FK, platform_id, chain_id, status (CREATING/DEPLOYING/VERIFYING/ACTIVE/SOVEREIGN_MODIFIED/MIGRATING/FAILED/MIGRATED/ABANDONED), migrated_from_wallet_id FK null, safe_address null, salt_nonce numeric(78), factory_address, singleton_address, config_hash bytea, next_safe_nonce numeric, exec_lease_owner, exec_lease_expires_at, exec_lease_version bigint, deploy_tx_hash, deploy_block_number, created_at, activated_at | UNIQUE(chain_id, safe_address); UNIQUE(user_id) WHERE status NOT IN ('FAILED','ABANDONED','MIGRATED','MIGRATING') (V1: una wallet activa por usuario; durante una migración la vieja queda MIGRATING y la nueva se crea con `migrated_from_wallet_id`) |
| `wallet_keys_metadata` | id, wallet_id FK, role (U/R/S), key_address, key_version, status (PENDING/ACTIVE/ROTATED_OUT/REVOKED), source (INTERNAL/EXTERNAL_WALLET/SIGNER_SHARD), kdf_params jsonb null (públicos), storage_flags jsonb (drive, file, qr, words), created_at, activated_at, deactivated_at | UNIQUE(wallet_id, role) WHERE status='ACTIVE'; UNIQUE(key_address) WHERE status IN ('PENDING','ACTIVE') |
| `recovery_metadata` | id, wallet_id FK, enrollment_id, r_address, r_type (INTERNAL/EXTERNAL), connector_id null, enrollment_key_jwk, enrollment_payload jsonb, enrollment_key_signature, r_proof_signature, u_incorporation_signature, status (REQUESTED/SUBMITTED/CONFIRMED/EXPIRED/REJECTED), expires_at, created_at | UNIQUE(enrollment_id) |
| `signer_keys` | id, wallet_id FK, shard_id, key_ref, address, provider (development/selfhosted/hardware), status (ACTIVE/PENDING/RETIRED), created_at | UNIQUE(address); UNIQUE(wallet_id) WHERE status='ACTIVE' |
| `security_challenges` | id uuid, user_id, wallet_id null, type (EMAIL_VERIFY/PASSWORD_RESET/LOGIN_UNLOCK/STEP_UP/WHITELIST_ADD/ROTATION/HIGH_VALUE_TX/MIGRATION), binding jsonb (safe, chainId, destination, action, nonce, safeTxHash, token, amount), code_hash bytea, attempts, max_attempts, expires_at, consumed_at, created_ip_prefix, created_at | idx(user_id, type, created_at); CHECK(attempts <= max_attempts) |
| `whitelist_requests` | id, wallet_id, user_id, destination, label, status (PENDING_CHALLENGE/CHALLENGE_PASSED/AWAITING_SIGNATURE/SUBMITTED/ACTIVATING/ACTIVE/EXPIRED/CANCELLED/FAILED), challenge_id FK, operation_id FK null, created_at, updated_at | UNIQUE(wallet_id, destination) WHERE status NOT IN ('EXPIRED','CANCELLED','FAILED','ACTIVE') |
| `whitelisted_destinations` | id, wallet_id, destination, label, status (ACTIVATING/ACTIVE/REMOVED), activates_at, added_tx_hash, removed_tx_hash, created_at | UNIQUE(wallet_id, destination) WHERE status IN ('ACTIVATING','ACTIVE') |
| `wallet_operations` | id uuid, user_id, wallet_id, safe_address, chain_id, safe_nonce numeric, operation_type (SEND/SWAP_APPROVE/SWAP/WHITELIST_ADD/WHITELIST_REMOVE/ROTATION_PROPOSE/ROTATION_EXECUTE/NOOP_CANCEL/MIGRATION_TRANSFER/APPROVE_REVOKE/GUARD_UPGRADE), group_id null, safe_tx_hash bytea, target, value numeric, calldata bytea, canonical_intent jsonb, owner_signature bytea (= "u_signature" del prompt; firma de U **o** R), owner_role (U/R), s_signature bytea null, platform_session_id, submission_envelope jsonb, policy_snapshot_version, two_factor_challenge_id null, status, failure_reason, last_error_code, retry_count, next_attempt_at, lease_version, created_at, updated_at, submitted_at, mined_at, executed_at, confirmed_at, finalized_at, tx_hash, block_number, block_hash | UNIQUE(safe_tx_hash); UNIQUE(chain_id, safe_address, safe_nonce) WHERE status IN ('USER_SIGNED','QUEUED','VALIDATING','READY','SUBMITTED','MINED','FAILED_RETRYABLE','REORGED','CONFIRMED','FINALIZED') ; CHECK(value >= 0) |
| `chain_transactions` | id, chain_id, operation_id FK null, purpose (EXEC/DEPLOY/TOPUP/CANCEL_RELAY), from_address, account_nonce, tx_hash, raw_tx bytea, max_fee_per_gas, max_priority_fee_per_gas, gas_limit, status (BROADCAST/MINED/CONFIRMED/FINALIZED/REPLACED/DROPPED/REORGED/FAILED), replaced_by_id, block_number, block_hash, receipt_status, gas_used, effective_gas_price, created_at, updated_at | UNIQUE(tx_hash); UNIQUE(chain_id, from_address, account_nonce, tx_hash) |
| `rotation_requests` | id, wallet_id, role (U/R/S), old_key, new_key, proposal_id bytea null, initiated_by (U/R), status (DRAFT/AWAITING_SIGNATURE/PROPOSING/PENDING_TIMELOCK/READY_TO_EXECUTE/EXECUTING/EXECUTED/CANCELLED/FAILED), propose_operation_id, execute_operation_id, executable_at, cancelled_by (U/R/SAFE), cancel_tx_hash, created_at, updated_at | UNIQUE(wallet_id, role) WHERE status IN ('PROPOSING','PENDING_TIMELOCK','READY_TO_EXECUTE','EXECUTING') |
| `token_transfers` | id, chain_id, safe_address, token, direction (IN/OUT), counterparty, amount numeric, tx_hash, log_index, block_number, block_hash, status (MINED/CONFIRMED/FINALIZED/REORGED), created_at | UNIQUE(chain_id, tx_hash, log_index) |
| `audit_events` | id bigserial, occurred_at, actor_type (USER/SYSTEM/WORKER/SIGNER/OPERATOR), actor_id, user_id, wallet_id, session_id, event_type, target_type, target_id, request_id, ip_prefix, payload jsonb (redactado), prev_hash bytea, entry_hash bytea | append-only: trigger que rechaza UPDATE/DELETE + GRANT sólo INSERT/SELECT; `entry_hash = HMAC(AUDIT_CHAIN_KEY, prev_hash ‖ canonical(entry))` |
| `outbox_events` | id bigserial, aggregate_type, aggregate_id, event_type, payload jsonb, created_at, dispatched_at, attempts | idx(dispatched_at NULLS FIRST, id) |
| `idempotency_keys` | user_id, key, request_hash, status (IN_PROGRESS/COMPLETED), response_status, response_body jsonb, created_at, expires_at | PK(user_id, key) |
| `notifications` | id, user_id, wallet_id, type, payload jsonb, read_at, created_at | idx(user_id, read_at) |
| `operator_users`, `operator_actions` | operadores internos (TOTP obligatorio) y acciones con doble aprobación (caso de migración excepcional) | `operator_actions` append-only, CHECK(approver_1 <> approver_2) |
| `policy_snapshots` | version, sha256, signature, payload jsonb, activated_at | UNIQUE(version) |
| `integrity_status` | app (WALLET/RECOVERY), release_id, status (OK/MISMATCH/UNREACHABLE), details jsonb, observed_at | idx(app, observed_at) |
| `gas_topups` | id, executor_address, amount_wei, tx_id FK, reason, created_at | idx(created_at) |

Ninguna tabla contiene claves privadas U, R o S ni passwords U/R. `raw_tx` contiene sólo transacciones ya firmadas (públicas al transmitirse).

**[B-DB-FK]** Toda columna `*_id` que referencia otra tabla tiene **foreign key explícita** (`ON DELETE RESTRICT`; nada se borra en cascada): `sessions.user_id`, `platform_sessions.{account_session_id,user_id,wallet_id}`, `opaque_records.{user_id,wallet_id}`, `totp_factors.user_id`, `wallets.user_id`, `wallet_keys_metadata.wallet_id`, `recovery_metadata.wallet_id`, `signer_keys.wallet_id`, `security_challenges.{user_id,wallet_id}`, `whitelist_requests.{wallet_id,user_id,challenge_id,operation_id}`, `whitelisted_destinations.wallet_id`, `wallet_operations.{user_id,wallet_id,platform_session_id,two_factor_challenge_id,group_id→operation_groups}`, `chain_transactions.{operation_id,replaced_by_id}`, `rotation_requests.{wallet_id,propose_operation_id,execute_operation_id}`, `token_transfers.safe_address→wallets.safe_address`, `notifications.{user_id,wallet_id}`, `idempotency_keys.user_id`, `gas_topups.tx_id`, `operator_actions.{approver_1,approver_2}→operator_users`. `operation_groups` (id, type SWAP, status) agrupa las operaciones de un swap.

**[B-DB-ROLES]** Passwords de roles: `MTW_APP_DB_PASSWORD`, `MTW_MIGRATOR_DB_PASSWORD`, `MTW_SIGNER_DB_PASSWORD` (generadas en local por `secrets:local`; en producción, archivos de secrets de Docker Compose generados por `scripts/deploy/init-secrets.sh`, ADR-030); `DATABASE_URL`, `DATABASE_MIGRATION_URL` y `SIGNER_DATABASE_URL` se componen con ellas.

Backup/restore: [B-DB-BK] PostgreSQL del backend y del signer con **pgBackRest** (full semanal, diferencial diario, WAL archiving continuo para PITR, repositorio cifrado; repo1 local y repo2 off-host que se define al desplegar — ADR-031); local: `pnpm db:backup` / `pnpm db:restore` y perfil compose `backup` para ensayar pgBackRest. En producción la copia off-host cifrada es obligatoria. Restore test obligatorio en P26.

### 7.4 Máquina de estados de `wallet_operations` [B-SM]

```text
CREATED ──(firma U/R válida)──▶ USER_SIGNED ──(outbox)──▶ QUEUED ──(lease)──▶ VALIDATING
CREATED ──(15 min sin firma)──▶ EXPIRED                       ▲                  │
VALIDATING ──(checks OK)──▶ READY ──(signer OK + broadcast)──▶ SUBMITTED         │
VALIDATING ──(transitorio: RPC, signer, nonce aún no alcanzado)──▶ FAILED_RETRYABLE ─┘ (backoff, retry_count++)
VALIDATING ──(policy/firma/whitelist/saldo inválidos)──▶ FAILED_FINAL
SUBMITTED ──(receipt success)──▶ MINED ──(safe head + hash estable)──▶ CONFIRMED ──(finalized head + hash estable)──▶ FINALIZED
SUBMITTED ──(receipt status 0: la tx de S se minó y revirtió; nonce de S consumido, nonce de Safe NO)──▶ FAILED_RETRYABLE (gas/condición transitoria) | FAILED_FINAL (revert del Guard/policy)
SUBMITTED ──(dropped/reemplazo externo)──▶ FAILED_RETRYABLE
MINED|CONFIRMED ──(receipt desaparece / block hash cambia)──▶ REORGED ──▶ QUEUED (revalidar y retransmitir la MISMA SafeTx)
USER_SIGNED|QUEUED|READY|SUBMITTED|FAILED_RETRYABLE|FAILED_FINAL ──(usuario pide cancelar)──▶ CANCEL_REQUESTED ──(se mina la NoOp)──▶ CANCELLED
CANCEL_REQUESTED ──(se mina la original primero)──▶ MINED (sigue el camino normal; la NoOp queda FAILED_FINAL "demasiado tarde")
```

- **[B-SM-01]** Única función de transición `transitionOperation(id, fromStates[], toState, patch, leaseVersion)` que ejecuta en **una transacción DB**: `UPDATE … WHERE id=$1 AND status = ANY($2) AND lease_version=$3`, inserta `audit_events` y `outbox_events`. Si `rowCount = 0` → conflicto (otro worker o estado cambiado) → abortar sin efectos.
- **[B-SM-02]** Toda transición queda auditada (event_type `OPERATION_<ESTADO>`).
- **[B-SM-03]** Estados terminales: FINALIZED, FAILED_FINAL, CANCELLED, EXPIRED (CONFIRMED es estable pero el watcher lo sigue hasta FINALIZED). FAILED_FINAL con firma vigente obliga a ofrecer cancelación por NoOp (la SafeTx sigue válida hasta consumir su nonce y sólo S puede transmitirla).
- **[B-SM-04]** Revert minado (receipt status 0): se registra en `chain_transactions` (FAILED, `gas_used`), se decodifica el motivo (errores `GS0xx` de Safe y errores custom del Guard/SwapExecutor) y se clasifica: transitorio → FAILED_RETRYABLE con re-simulación obligatoria; determinístico → FAILED_FINAL + alerta (indica divergencia entre simulación y ejecución).

### 7.5 Nonce management [B-NONCE]

- **[B-NONCE-01] Asignación**: en `prepare`, dentro de una transacción con `SELECT … FROM wallets WHERE id=$1 FOR UPDATE`: `n = max(onchainNonce(quorum), next_safe_nonce, max(nonce activo)+1)`; se inserta la operación `CREATED` con `safe_nonce = n` y se actualiza `next_safe_nonce = n+1`. El índice único parcial impide dos operaciones activas con el mismo nonce.
- **[B-NONCE-02] Liberación**: si la operación expira o se cancela antes de `USER_SIGNED`, su nonce vuelve a estar disponible (`next_safe_nonce = min(...)` recalculado bajo lock).
- **[B-NONCE-03] Ejecución en orden estricto**: el worker sólo procesa la operación cuyo `safe_nonce == onchainNonce`. Las de nonce mayor quedan `QUEUED` con `blocked_reason=WAITING_LOWER_NONCE`.
- **[B-NONCE-04] Lease con fencing por Safe**: `UPDATE wallets SET exec_lease_owner=$w, exec_lease_expires_at=now()+30s, exec_lease_version=exec_lease_version+1 WHERE id=$1 AND (exec_lease_expires_at < now() OR exec_lease_owner=$w) RETURNING exec_lease_version`. Toda escritura posterior del worker incluye `lease_version` (fencing). Nada depende de memoria del worker.
- **[B-NONCE-05] Nonce de la cuenta S**: `chain_transactions` con UNIQUE(from_address, account_nonce, tx_hash); una sola tx en vuelo por S; reemplazo (fee bump ≥ 12.5 %) reutiliza el mismo `account_nonce` y la misma SafeTx.
- **[B-NONCE-06] Cancelación solicitada por el usuario**: `POST /operations/{id}/cancel` → si no está firmada: CANCELLED (nonce liberado). Si está firmada: la original pasa a **CANCEL_REQUESTED** (sale del índice único de nonces activos y el worker deja de procesarla), se prepara `NOOP_CANCEL` con el **mismo** `safe_nonce` (SafeTx a la propia Safe, value 0, data vacía, CALL), U (o R) la firma y S la ejecuta con prioridad. Si la original ya estaba SUBMITTED, el worker transmite la NoOp **reemplazando** la tx en vuelo de S (mismo nonce de cuenta, fee bump); gana la que se mine primero: NoOp minada → original CANCELLED (`SUPERSEDED_BY_NOOP`); original minada → original MINED y NoOp FAILED_FINAL ("demasiado tarde para cancelar"). Ambos órdenes tienen test.
- **[B-NONCE-07] Doble ejecución**: imposible on-chain (nonce de Safe); off-chain se previene con índice único + lease + `transitionOperation`. Dos workers con la misma operación: sólo el poseedor del lease transmite; el otro aborta en la primera escritura con fencing.

### 7.6 Cola, outbox y worker S [B-Q]

- **[B-Q-01] Outbox transaccional**: el cambio de estado y el evento `OPERATION_QUEUED` se escriben en la misma transacción; un dispatcher (`backend/app/src/queue/outbox-dispatcher.ts`) publica en BullMQ (`queue: wallet-operations`, `jobId = operationId` para deduplicar) y marca `dispatched_at`. Si Valkey se pierde, el dispatcher re-encola desde Postgres.
- **[B-Q-02] Pipeline del worker** (orden obligatorio, prompt §14):
  1. cargar operación (y adquirir lease de la Safe);
  2. verificar PlatformSession y envelope de envío (vigentes al momento del envío, scope correcto, mismo userId/safe);
  3. reconstruir SafeTx desde `canonical_intent` y recalcular SafeTxHash (debe igualar `safe_tx_hash`);
  4. validar firma U/R (ECDSA estricta: 65 bytes, low-s, v∈{27,28}) contra el rol vigente on-chain (`SecurityGuard.rolesOf`);
  5. leer nonce on-chain (quórum) — debe igualar `safe_nonce`;
  6. evaluar policy (snapshot firmado vigente; límites; 2FA si corresponde);
  7. leer whitelist on-chain (quórum) para destinos;
  7b. **verificar que la configuración on-chain de la Safe sigue intacta** (quórum): slot de guard == `SecurityGuard`, module guard == `DenyAllModuleGuard`, fallback == 0, sin módulos, threshold == 2, owners == `rolesOf(safe)`. Si algo difiere (p. ej. U+R retiraron el Guard soberanamente) **no se co-firma**: la wallet pasa a `SOVEREIGN_MODIFIED`, se alerta y se informa al usuario; sin el Guard no hay enforcement on-chain y la plataforma no puede cooperar;
  8. pre-check on-chain sin efectos: `SecurityGuard.evaluateAssisted(...)` [C-GRD-02] y `eth_call` de la llamada interna desde la Safe al target (la simulación completa de `execTransaction` necesita la firma de S, por eso la hace el signer en el paso 9 antes de devolver la tx firmada);
  9. solicitar al signer shard (mTLS) la firma S: el signer **repite independientemente** los pasos 2–8, firma la SafeTx (EIP-712) y la tx EIP-1559 `execTransaction`, y simula con `eth_call` antes de devolver;
  10. transmitir `execTransaction` a primario y secundario (idempotente por tx hash);
  11. esperar receipt (MINED) con timeout y política de reemplazo;
  12. actualizar estado (y luego el watcher lleva a CONFIRMED/FINALIZED).
  La firma S **nunca** se genera antes de completar de nuevo todos los checks (garantizado por el signer, no por el worker).
- **[B-Q-03] Reintentos**: backoff exponencial con jitter (base 5 s, máx. 10 min, máx. 20 reintentos → FAILED_FINAL + alerta). Errores clasificados en `last_error_code` (`RPC_TIMEOUT`, `RPC_DISAGREEMENT`, `SIGNER_UNAVAILABLE`, `NONCE_NOT_REACHED`, `POLICY_REJECTED`, `GUARD_WOULD_REVERT`, `INSUFFICIENT_BALANCE`, `WHITELIST_INACTIVE`, `SESSION_INVALID`, …).
- **[B-Q-04] Crash/restart**: al arrancar, el worker reclama operaciones `VALIDATING/READY/SUBMITTED` con lease vencido; las `SUBMITTED` se reconcilian contra la cadena por `chain_transactions` antes de retransmitir.
- **[B-Q-05] Batching**: no se implementa en V1 (ADR-019). El worker procesa en paralelo **entre** Safes (concurrencia configurable, default 8) y secuencial **dentro** de cada Safe.

### 7.7 Finalidad, reorgs y reconciliación [B-FIN]

- **[B-FIN-01]** Estados de cadena: `SUBMITTED` (broadcast) → `MINED` (receipt success; se guarda `block_number` + `block_hash`) → `CONFIRMED` → `FINALIZED`, según `CONFIRMATION_POLICY`: con `tags` (staging/producción) CONFIRMED = bloque ≤ head `safe` y FINALIZED = bloque ≤ head `finalized`, siempre con `block_hash` reconfirmado por quórum y **sin umbrales por cantidad de bloques** (ADR-018); con `depth` (local/fork) se usan `CONFIRMATION_DEPTH` y `FINALIZATION_DEPTH`.
- **[B-FIN-02] Watcher** (`backend/app/src/chain/watcher.ts`, cada bloque/2 s): para toda operación/tx no finalizada verifica receipt y hash de bloque; detecta: receipt desaparecido, block hash cambiado, tx reemplazada/dropped (nonce de S avanzó sin nuestro hash), inconsistencia entre RPCs. Acciones: `REORGED` → re-encolar; `DROPPED` → retransmitir/reemplazar; inconsistencia → reintento y alerta, **sin transición** hasta lograr consistencia.
- **[B-FIN-03] Reconciliación periódica DB ↔ chain**: cada 60 s para wallets con operaciones no finales; diaria completa (nonce Safe, roles del Guard, **configuración de la Safe — guard, module guard, fallback, módulos, threshold, owners vs roles —**, whitelist, rotaciones pendientes en `RotationTimelock`, saldos). Una deriva de configuración marca la wallet `SOVEREIGN_MODIFIED`. Toda discrepancia genera `audit_events` + alerta. Las transacciones soberanas (no originadas por backend) se indexan desde eventos de SafeL2 para que el historial sea completo.
- **[B-FIN-04] Local/fork**: Anvil no modela batches L1; `CONFIRMATION_POLICY=depth` con profundidad configurable; tests de reorg con `anvil_reorg`/`anvil_rollback` (verificado disponible en Anvil 1.5.1).

### 7.8 RPC [B-RPC]

- **[B-RPC-01]** `RpcQuorumClient` sobre viem con dos transports independientes (primario, secundario) y health checks (chainId, head lag, latencia) cada 10 s.
- **[B-RPC-02] Lecturas sensibles** (nonce de Safe, roles, whitelist, saldo para policy, receipts, códigos/codehash): se fija un `blockNumber` común (`min(headA, headB) - 1`) y se consulta en ambos; si difieren → reintento con backoff; si persiste → `RPC_DISAGREEMENT` (no se toma la decisión). En local (`RPC_QUORUM_MODE=local-single`) ambos apuntan a Anvil y el modo dual se testea con un proxy de inyección de fallas (test-only) delante del fork real.
- **[B-RPC-03] Escrituras**: `eth_sendRawTransaction` a ambos; éxito si al menos uno acepta o el tx hash ya es conocido.
- **[B-RPC-04]** El signer tiene **sus propias** credenciales RPC (no reutiliza las del backend).

### 7.9 Policy [B-POL]

- **[B-POL-01] Snapshot firmado** `config/policy/<env>/policy-snapshot.json` + `.sig` (Ed25519, clave del equipo de seguridad; pública fijada en backend y signer). Contenido: versión monótona, chainId, direcciones del sistema, tipos de operación habilitados por rol, tokens (USDC, USDT), límites, umbral 2FA, slippage, deadlines, platformId. El signer rechaza snapshots con firma inválida o versión menor a la vigente (anti-rollback).
- **[B-POL-02] Límites por defecto** (ADR-025): por operación 10.000 (USDC o USDT, 6 decimales); salida acumulada 24 h por Safe 20.000; umbral 2FA transaccional 1.000 (factor: TOTP si el usuario lo tiene activo, si no email OTP; challenge `HIGH_VALUE_TX` ligado a Safe, SafeTxHash, acción, token, monto, destino y nonce; el signer exige la atestación `ChallengeCompletion` correspondiente); swap máx. 10.000 por operación; slippage por defecto 30 bps, máx. 50 bps (= piso on-chain); deadline de swap 10 min; mínimo por operación 1 (unidad de token). `MIGRATION_TRANSFER` queda exento del límite de 24 h pero exige caso de operadores con doble aprobación + autorización on-chain madura y transfiere el saldo completo.
- **[B-POL-03] Operaciones tipificadas V1** (cualquier otra → rechazo): `SEND` (USDC/USDT `transfer` a destino whitelisteado activo), `SWAP_APPROVE` (`approve(SwapExecutor, amountIn)` exacto), `SWAP` (`SwapExecutor.swap`), `APPROVE_REVOKE` (`approve(SwapExecutor, 0)`), `WHITELIST_ADD`, `WHITELIST_REMOVE`, `ROTATION_PROPOSE`, `ROTATION_EXECUTE`, `NOOP_CANCEL`, `MIGRATION_TRANSFER` (sólo con autorización on-chain), `GUARD_UPGRADE` (sólo U: `setGuard`/`setModuleGuard` hacia el sucesor activo con propuesta madura, [C-GRD-17]). Sin multicall, sin DELEGATECALL, sin calldata arbitraria.
- **[B-POL-04]** Backend y signer evalúan la policy **por separado**, decodificando desde los bytes de la SafeTx (nunca desde descripciones del frontend).
- **[B-POL-05]** Implementación del backend en `backend/app/src/policy/` (P13.T10): verificación de firma y anti-rollback del snapshot, tabla de operaciones por rol, límites por operación, ledger de salidas 24 h por Safe (en Postgres), umbral de 2FA y validaciones de destino; el signer tiene la suya propia en `backend/signer/src/policy/` (P11.T03). Ambas se contrastan contra los mismos vectores.

### 7.10 Protocolo backend → signer [B-SIG]

- **[B-SIG-01] Transporte**: HTTPS con mTLS (CA privada por entorno, generada por `secrets-local` o `init-secrets.sh`) sobre la red Docker `signer` (`internal: true`); el signer no publica ningún puerto.
- **[B-SIG-02] `POST /v1/sign-safe-tx`**: `{operationId, walletId, safe, chainId, safeTx, ownerSignature, ownerRole, platformSessionToken, submissionEnvelope, submissionEnvelopeSignature, challengeAttestation?, keyAcceptance?, pairedSafeTx?, policySnapshotVersion}` → el signer verifica todo (pasos 2–8, incluido 7b, de [B-Q-02]) con su propio RPC y su propia DB de estado, y además: **rotación de S** sólo si `newKey` es una clave que el propio signer creó para esa wallet; **rotación de U o R** sólo con `keyAcceptance` válido (firma EIP-712 `KeyAcceptance` de la nueva clave, [W-01]); **secuencia**: un `SWAP_APPROVE` sólo se co-firma si llega acompañado de su `SWAP` N+1 firmado por U con el mismo executor y `amountIn == amount` (y el `SWAP` sólo tras el approve ejecutado); antigüedad ≤ 24 h ([B-PSES-06]). Responde `{sSignature, signedTx, txHash, accountNonce}` o un error tipificado.
- **[B-SIG-07] Atestación de clave S**: al crear S (`POST /v1/keys`) el signer devuelve `SignerKeyAttestation` firmada con su clave de atestación Ed25519 (pública fijada en los frontends, [W-07]); la Wallet la verifica antes de que U firme la autorización de creación (así un backend comprometido no puede sustituir S por una clave propia).
- **[B-SIG-08] Ciclo de vida de S** (`SelfHostedSoftwareSignerProvider`):
  - **Layout**: keystores en `SIGNER_KEYSTORE_DIR` (producción: `/var/lib/mtw-signer/keystore/<address>.json` en el volumen `signer-<shardId>-keystore`, archivos 0400 del UID del signer); credencial de desbloqueo del shard = 32 bytes aleatorios en `SIGNER_UNLOCK_CREDENTIAL_FILE` (producción: `/run/secrets/signer_unlock`, secret de Compose que vive en otro directorio del host); **keystore cifrado ≠ credencial de desbloqueo**. Las claves privadas nunca están en PostgreSQL, Valkey, la DB del backend, `.env`, código, logs ni ninguna API.
  - **create**: CSPRNG → escalar válido → contraseña = `hex(HKDF-SHA256(credencial, salt="mtw-signer-keystore-v1", info=address))` → keystore V3 (scrypt de `@noble/hashes` con N=2^14, r=8, p=1 — la contraseña ya tiene 256 bits —, AES-128-CTR, MAC keccak) → escritura atómica (temporal + fsync + rename) → alta en la DB del signer → `SignerKeyAttestation`. La clave nunca se devuelve ni se loguea.
  - **load**: al arrancar se indexa el directorio y se concilia con la DB del signer; faltantes o sobrantes generan alerta y esas claves no firman.
  - **unlock**: por cada firma: leer keystore → derivar contraseña → descifrar (verifica MAC) → firmar → sobrescribir buffers (best-effort); sin caché de claves en claro.
  - **restart**: el shard compara el `credentialFingerprint` (HMAC de una constante con la credencial) con la DB; si no coincide queda `not ready` y no firma.
  - **backup**: tras cada alta y diariamente: keystores + dump de la DB del signer, cifrados con `age` hacia la clave pública de backup y copiados off-host (ADR-031). La credencial de desbloqueo **no** se incluye: se custodia offline aparte (dos copias selladas, custodios distintos).
  - **restore**: en un host nuevo: restaurar keystores y DB, montar la credencial, arrancar en modo `restore-verify` (descifra cada keystore y comprueba la dirección, sin firmar) y luego en modo normal.
  - **rotation**: (a) de S por Safe: nueva clave (mismo u otro shard) y rotación on-chain con timelock (P15); la vieja pasa a RETIRED y su keystore se destruye 30 días después de ejecutar la rotación si no hay operaciones pendientes; (b) de la credencial del shard: job que re-cifra todos los keystores con contraseñas derivadas de la credencial nueva (archivo por archivo, atómico, `kdfVersion` + 1) y luego retira la anterior.
  - **lost/corrupted**: MAC inválido o archivo faltante → clave `BROKEN`, alerta crítica y restore desde el último backup; si es irrecuperable, la Safe queda sin camino asistido y se aplica el procedimiento de P15.T09 (U+R reemplazan S).
  - **shard migration**: herramienta offline en el host del signer que copia los keystores al shard destino, los re-cifra con la credencial destino, verifica y actualiza la asignación en la DB del signer y en el backend en dos fases (destino ACTIVE tras verificar, origen MIGRATED); sin cambio on-chain.
  - **compromiso del root del host del signer** = S comprometidas (de todos los shards de ese host): siguen necesitando U o R para alcanzar threshold; respuesta: rotar S de las Safes afectadas (con firma del usuario) y aplicar el playbook de incidente.
- **[B-SIG-09] Sharding**: cada shard se identifica por `shardId` + endpoint mTLS; la asignación se calcula por hash estable de `walletId` sobre los shards activos al crear la wallet y se **guarda** (no se recalcula); local: un shard `dev-1`; producción: el software soporta N shards aunque inicialmente corran en el mismo host físico, cada uno con su volumen, su credencial, su identidad mTLS y su DB lógica.
- **[B-SIG-03] Estado propio del signer** (PostgreSQL **propio** del dominio signer — en local la DB `mtw_signer_dev`; en producción el contenedor `signer-postgres`, con volumen, credenciales y backups propios, separado del Postgres del backend; una DB lógica por shard): `signed_safe_txs` (safe, nonce, safeTxHash, opType, token, amount, dest, signedAt) con la regla **"a lo sumo una SafeTx activa firmada por (safe, nonce)"** salvo reemplazo explícito (NoOp/reemplazo con nueva firma del usuario); ledger de salidas 24 h; registro de claves (`keyRef`, address, wallet, shard, estado, `kdfVersion`, `credentialFingerprint`). **Nunca contiene claves privadas**; el backend no tiene credenciales de esta DB.
- **[B-SIG-04] `SignerProvider`** (interfaz en `backend/signer/src/providers/SignerProvider.ts`): `createKey(walletId) → {keyRef, address}`, `getAddress(keyRef)`, `signDigest(keyRef, digest32)` (usada para el hash EIP-712 de la SafeTx y para el hash de firma de la tx EIP-1559, ambos calculados por el signer-service), `health()`. Se elige con `SIGNER_PROVIDER=development | selfhosted`. Implementaciones (ADR-014):
  - `SelfHostedSoftwareSignerProvider` — **producción y staging**: keystores Ethereum V3 cifrados en el volumen del shard, contraseñas derivadas de la credencial de desbloqueo del shard, firma en proceso con `@noble/curves`; ciclo de vida en [B-SIG-08].
  - `DevelopmentSignerProvider` — el **mismo** provider con guardas de desarrollo: sólo `APP_ENV=local` sobre un fork Anvil, credencial generada por `secrets:local`, keystores en `wallet/.secrets/signer/<shard>/keystore/` (así los tests ejercitan el código de producción).
  - `HardwareSignerProvider` — **futuro opcional** (HSM físico propio vía PKCS#11/YubiHSM, secp256k1 no exportable): interfaz y suite de contrato común listas en V1; la migración se hace Safe por Safe rotando S por el timelock (firma del usuario), sin exportar claves.
- **[B-SIG-05] Gas tank/relayer**: cuenta de plataforma (no owner de ninguna Safe) gestionada por el mismo mecanismo de firma (shard `platform`, keystore propio con su credencial), usada para: desplegar Safes vía `WalletFactory`, recargar ETH de cada S (umbral mín./objetivo, tope diario) y retransmitir cancelaciones firmadas por U/R (`RotationTimelock.cancelWithSignature`). S **sólo** transmite `execTransaction` hacia su propia Safe (regla del signer-service: la tx que firma la clave S debe tener `to == safe asociada`, selector `execTransaction`, `value == 0`, chainId 8453 y topes de gas/fee).
- **[B-SIG-06] "Ruleset" restrictivo y atestado**: la política del signer (código + snapshot firmado) se despliega como imagen inmutable cuyo digest se registra por release; el pipeline del signer es independiente del backend; las reglas estáticas mínimas (chainId, CALL, gas params en cero, allowlist de targets/selectores, `to` de la tx = Safe asociada) se evalúan **antes** de cualquier lectura on-chain y no dependen de datos provistos por el backend.

### 7.11 API `/api/v1` [B-API]

Convenciones: JSON, errores RFC 9457 (`application/problem+json` con `type`, `title`, `status`, `code`, `detail`, `requestId`), paginación por cursor, `Idempotency-Key` obligatorio en POST que crean recursos u operaciones (24 h), OpenAPI 3.1 generado desde los schemas Zod de cada ruta. "Crítico" = requiere PlatformSession + `X-Session-Signature` (§7.2).

| Grupo | Endpoint | Auth | Listener |
|---|---|---|---|
| health | `GET /health`, `GET /health/live`, `GET /health/ready` | pública/interna | ambos |
| auth | `POST /auth/register`, `POST /auth/verify-email`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/csrf`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/totp/setup`, `POST /auth/totp/enable`, `POST /auth/totp/disable` | pública / cuenta | ambos |
| sessions | `GET /sessions`, `DELETE /sessions/{id}`, `DELETE /sessions` (todas menos actual), `POST /platform-sessions/opaque/start`, `POST /platform-sessions/opaque/finish`, `POST /platform-sessions/step-up/start`, `POST /platform-sessions/step-up/finish`, `DELETE /platform-sessions/{id}` | cuenta | Wallet (OPAQUE) / ambos (step-up) |
| users | `GET /users/me`, `PATCH /users/me` (datos no sensibles) | cuenta | ambos |
| wallet | `POST /wallets` (inicia onboarding), `GET /wallets/me`, `POST /wallets/{id}/user-key` (registra dirección U + metadata KDF + OPAQUE registration), `POST /wallets/{id}/deploy` (tras incorporación de R), `GET /wallets/{id}/deployment` (estado CREATING→ACTIVE + datos para verificación) | cuenta / crítico | Wallet |
| balances | `GET /wallets/{id}/balances` (lectura quórum; el frontend además lee directo de su RPC) | cuenta | Wallet |
| whitelist | `GET /wallets/{id}/whitelist`, `POST /wallets/{id}/whitelist/requests`, `POST /whitelist/requests/{id}/confirm`, `POST /wallets/{id}/whitelist/{destination}/remove` | crítico | Wallet |
| send | `POST /wallets/{id}/send/prepare` | crítico | Wallet |
| swap | `GET /wallets/{id}/swap/quote`, `POST /wallets/{id}/swap/prepare` | cuenta / crítico | Wallet |
| operations | `GET /wallets/{id}/operations`, `GET /operations/{id}`, `POST /operations/{id}/signatures`, `POST /operations/{id}/cancel`, `POST /operations/{id}/two-factor` | cuenta / crítico | Wallet (y Recovery para firmas R) |
| recovery | `POST /wallets/{id}/recovery/enrollments`, `GET /recovery/enrollments/{id}`, `POST /recovery/enrollments/{id}/enrollment-key`, `POST /recovery/enrollments/{id}/submit`, `POST /recovery/enrollments/{id}/incorporate` (firma U), `POST /recovery/u-replacement` | crítico | Recovery (enrollment/submit/u-replacement) / Wallet (create/incorporate) |
| rotations | `GET /wallets/{id}/rotations`, `POST /wallets/{id}/rotations` (prepara propuesta), `POST /rotations/{id}/execute/prepare` | crítico | ambos |
| rotations (relay) | `POST /rotations/{id}/cancel` — **sin autenticación**: recibe la firma `CancelRotation` de U o R, verifica firma y propuesta pendiente on-chain y la retransmite por el gas tank (también se puede transmitir por cualquier relayer o wallet propia) | firma EIP-712 | ambos |
| emergencia (R) | `POST /wallets/{id}/emergency/whitelist-remove`, `POST /wallets/{id}/emergency/noop`, `POST /wallets/{id}/emergency/revoke-approval` — operaciones firmadas por R (WHITELIST_REMOVE, NOOP_CANCEL, APPROVE_REVOKE) | crítico (scope RECOVERY) | Recovery |
| migración | `POST /wallets/{id}/migration/prepare` (requiere caso de operadores aprobado y autorización on-chain madura) | crítico | ambos |
| notifications | `GET /notifications`, `POST /notifications/{id}/read` | cuenta | ambos |

Rate limits [B-RL] (Valkey store; claves por IP, usuario, sesión, Safe o propuesta según corresponda):

| Acción | Límite por defecto |
|---|---|
| login | 5/min por IP+email · 20/h por email · 100/h por IP |
| forgot-password | 3/h por email · 10/h por IP |
| verificación OTP | 5 intentos por challenge · 3 challenges/10 min por usuario y tipo |
| whitelist requests | 5/día por Safe · 10/día por usuario |
| send / swap prepare | 10/min por sesión · 30/h por usuario · 60/h por Safe |
| creación de operaciones (total) | 60/h por usuario |
| step-up de onboarding/enrollment | 10/día por usuario · 30/día por IP (bucket propio) |
| recovery / propuestas de rotación / step-up de recovery | 3/día por usuario · 10/día por IP |
| relay de cancelación de rotación (sin autenticación, verifica firma EIP-712 y propuesta pendiente) | 10/h por propuesta · 60/h por IP (nunca comparte bucket con lo anterior) |
| Swagger/API global | 300/min por IP (prod) · 1.000/min (local) |

**[B-AUTHZ] Autorización** (además de autenticación):

1. Todo recurso se resuelve con `user_id` y `platform_id` de la sesión de cuenta; un recurso de otro usuario responde **404** (no 403) para no permitir enumeración.
2. Las rutas críticas exigen además que la PlatformSession sea del mismo usuario, que su `scope` esté permitido para esa ruta y que `PlatformSession.safe` (o `walletId`) coincida con el recurso.
3. Cada listener expone sólo sus rutas: el de Recovery no expone send/swap/whitelist-add; el de Wallet no expone envío de enrollment ni propuestas firmadas por R.
4. Tests de IDOR en cada grupo (`/wallets/{id}`, `/operations/{id}`, `/rotations/{id}`, `/recovery/enrollments/{id}`, `/sessions/{id}`, `/whitelist/requests/{id}`): usuario B nunca lee ni modifica recursos de A, ni con PlatformSession de otra Safe.

**[B-API-SCH] Contratos de datos principales** (schemas Zod exportados a OpenAPI; nombres exactos):

- `PreparedOperation` (respuesta de todo `prepare`): `{operationId, groupId?, walletId, safe, chainId, operationType, safeTx: {to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce}, safeTxHash, typedData, decoded: {token?, amount?, destination?, tokenIn?, tokenOut?, minAmountOut?, deadline?, role?, oldKey?, newKey?}, requiresTwoFactor, expiresAt}`.
- `SubmitSignatureRequest`: `{ownerSignature, ownerRole: 'U'|'R', submissionEnvelope: {operationId, safeTxHash, sessionId, submittedAt}, submissionEnvelopeSignature, twoFactorChallengeId?}`.
- `OperationStatus`: `{id, status, operationType, safeNonce, safeTxHash, txHash?, blockNumber?, blockHash?, confirmations: {safe: bool, finalized: bool}, failureReason?, lastErrorCode?, history: [{status, at}]}`.
- `WhitelistRequest` / `WhitelistEntry`: `{id, destination, label, status, activatesAt?, challengeExpiresAt?}`.
- `RotationRequest`: `{id, role, oldKey, newKey, status, proposalId?, executableAt?, cancelledBy?}`.
- `DeploymentInfo`: `{walletId, status, U, R, S, saltNonce, factory, singleton, bootstrap, guard, moduleGuard, timelock, policyRegistry, whitelist, swapExecutor, expectedSafe, deployTxHash?}`.
- `Problem` (RFC 9457): `{type, title, status, code, detail, requestId, errors?[]}`.

Endpoints adicionales: `POST /security/csp-report` (ambos listeners; sin auth, rate limit estricto, cuerpo acotado), `POST /wallets/{id}/user-key/restore` (scope `KEY_RESTORE`, [B-PSES-03]). La API mTLS del signer tiene su propia spec OpenAPI interna (`backend/signer/openapi.json`), nunca publicada.

Swagger: `/docs` (Swagger UI) y `/docs/openapi.json` en ambos listeners. En **local/staging** "Try it out" habilitado: cookie de sesión + CSRF desde el mismo origen del API; para endpoints críticos un `requestInterceptor` (sólo builds no-producción) firma con una session key que el desarrollador obtiene mediante el flujo real (`pnpm --dir backend/app dev:session`, que hace login + OPAQUE con un usuario de prueba — **sin endpoints backdoor**). En **producción**: sólo spec de la API pública, "Try it out" deshabilitado; la API interna de operadores nunca se publica en `/docs`.

### 7.12 Email [B-MAIL]

- **[B-MAIL-01]** `EmailProvider` con adaptadores `mailgun` (staging/producción y tests reales; API HTTP con `fetch` nativo y autenticación Basic) y `smtp` (local/CI → Mailpit). Envío vía outbox (`email_outbox` lógico en `outbox_events`) con reintentos.
- **[B-MAIL-02] Plantillas sensibles** (whitelist, rotaciones, recovery, step-up, reset): muestran **acción**, **dirección completa** (checksum EIP-55, en grupos de 4), **red** ("Base mainnet — chainId 8453"; en local "Base fork local — chainId 8453"), **Safe**, **expiración** (hora local del usuario y UTC), IP/dispositivo de origen y qué hacer si no fue el usuario. Nunca incluyen links que ejecuten acciones; el código se ingresa en la app.
- **[B-MAIL-03]** Notificaciones: nuevo login, reset de password, whitelist solicitada/activada/removida, rotación propuesta/cancelada/ejecutada, recovery iniciado, operación de alto valor ejecutada, pausa de cooperación por integridad.

### 7.13 Audit log [B-AUD]

Escritura serializada: cada inserción toma `pg_advisory_xact_lock(<clave de auditoría>)` y lee la cabeza de la cadena dentro de la misma transacción (un solo escritor lógico; throughput suficiente para V1). Eventos mínimos: `AUTH_LOGIN_SUCCEEDED/FAILED`, `AUTH_LOGOUT`, `AUTH_PASSWORD_RESET_REQUESTED/COMPLETED`, `SESSION_REVOKED`, `PLATFORM_SESSION_ISSUED`, `TOTP_ENABLED/DISABLED`, `WHITELIST_REQUESTED`, `WHITELIST_CHALLENGE_PASSED/FAILED`, `WHITELIST_CONFIRMED_ONCHAIN`, `WHITELIST_REMOVED`, `OPERATION_PROPOSED`, `OPERATION_SIGNATURE_RECEIVED` (rol U/R), `OPERATION_<ESTADO>`, `S_SIGNATURE_ISSUED`, `S_EXECUTION_SUBMITTED`, `ROTATION_PROPOSED/CANCELLED/EXECUTED`, `RECOVERY_ENROLLMENT_*`, `RECOVERY_U_REPLACEMENT_STARTED`, `MIGRATION_CASE_*`, `POLICY_SNAPSHOT_ACTIVATED`, `INTEGRITY_MISMATCH`, `COOPERATION_PAUSED/RESUMED`, `OPERATOR_ACTION_*`, `RPC_DISAGREEMENT`, `REORG_DETECTED`. Cadena HMAC verificable (`pnpm --dir backend/app audit:verify`); export diario firmado y cifrado con `age` hacia la copia off-host (el hash de cada export queda anclado como evento de auditoría).

### 7.14 Observabilidad [B-OBS]

- Logs estructurados (pino, JSON) con `requestId`/`operationId`; **redacción** obligatoria por paths (`password`, `passwordU`, `passwordR`, `otp`, `code`, `token`, `authorization`, `cookie`, `set-cookie`, `x-platform-session`, `x-session-signature`, `privateKey`, `secret`, `mnemonic`, `seed`, `registrationRecord`) + serializer que trunca IP y enmascara email; tests de canario: valores secretos sembrados nunca aparecen en logs capturados.
- Métricas Prometheus (prom-client, puerto interno): HTTP, auth failures, rate-limit hits, cola (waiting/active/delayed/failed), lag del outbox, operaciones por estado, operaciones atascadas (edad > umbral), RPC (latencia, errores, head lag, desacuerdos, salud por proveedor), signer (latencia, rechazos por motivo, salud por shard), tx (submitted/mined/confirmed/reverted/reorged), saldo ETH de cada S (gauge agregado + lista de S bajo umbral), saldo del gas tank, estado de integridad, verificación de cadena de auditoría.
- Alertas (P24/P26): tx fallidas/revertidas, operaciones atascadas > 10 min, reorg detectado, desacuerdo RPC sostenido (> 3 en 5 min), proveedor RPC caído, signer caído o con rechazos anómalos, S con ETH bajo `GAS_TOPUP_MIN_WEI` y recarga fallida, gas tank bajo 0,05 ETH (el tope diario de recargas), mismatch de integridad (crítica), lag del outbox > 60 s, verificación de auditoría fallida (crítica), picos de login fallido, liquidez activa del pool canónico < 50 % de la observada en `FORK_BLOCK_NUMBER` o reservas USDC+USDT < US$ 100k, cotización USDC/USDT desviada > 0,5 % de 1:1 (además deshabilita swaps por policy), cambio de implementación del proxy de USDC, alarmas del signer (keystore ilegible o con MAC inválido, fingerprint de credencial distinto al arrancar, archivo de keystore creado o borrado fuera del flujo, clave `BROKEN`, backup de keystores fallido o atrasado).
- Nunca se loguean: U, R, passwords, secretos crudos, OTP completos, secretos de sesión, tokens de PlatformSession completos.

### 7.15 Formatos de intercambio y vectores compartidos [W]

Formatos exactos que comparten contratos, backend, signer y ambos frontends (implementados por separado en cada uno). Todos tienen vectores de test en `wallet/contracts/test/vectors/wire/*.json` (generados en P07.T05; cada consumidor guarda su copia con SHA-256 fijado y CI verifica igualdad).

- **[W-01] Dominios y tipos EIP-712** (todos con `chainId = 8453`):
  - SafeTx: dominio estándar de Safe `{chainId, verifyingContract: safe}`.
  - Plataforma: dominio `{name: "MTW Wallet", version: "1", chainId, verifyingContract: WalletFactory}` para:
    - `WalletCreationAuthorization(string userId,string platformId,string walletId,address userKey,address recoveryKey,address executor,uint256 saltNonce,address expectedSafe,bytes32 enrollmentNonce)` — firmada por **U**; reemplaza a la "incorporación" de V9 §6 incluyendo además S, salt y dirección esperada.
    - `RecoveryProofOfControl(string userId,string platformId,string enrollmentId,address recoveryKey)` — firmada por **R** (interna o wallet externa).
    - `KeyAcceptance(string walletId,uint8 role,address newKey,bytes32 nonce)` — firmada por la **nueva** U' o R' antes de proponer su rotación.
    - `KeyRestore(string userId,string walletId,address keyAddress,bytes32 nonce)` — firmada por U para `KEY_RESTORE`.
  - Timelock: dominio `{name: "MTW RotationTimelock", version: "1", chainId, verifyingContract: RotationTimelock}` para `CancelRotation(bytes32 proposalId,address safe)`.
- **[W-02] Firma de la Enrollment Key / session key**: ECDSA P-256 (WebCrypto, formato IEEE P1363 `r‖s`, 64 bytes, base64url) sobre SHA-256 del JSON canónico RFC 8785 (JCS) del objeto firmado (`RecoveryEnrollment {userId, platformId, R, nonce, issuedAt, expiresAt}`) o del string canónico de [B-PSES-05].
- **[W-03] Atestaciones JWS** (compactas, `alg: EdDSA`, `kid` obligatorio):
  - `PlatformSession` — emisor de sesiones: claims de [B-PSES-01] + `aud`.
  - `ChallengeCompletion` — emisor de sesiones: `{challengeId, type, userId, safe, chainId, action, destination?, safeTxHash?, token?, amount?, nonce, completedAt}`.
  - `IntegrityAttestation` — integrity monitor: `{platformId, app, environment, releaseId, manifestSha256, status, observedAt, expiresAt}`.
  - `SignerKeyAttestation` — signer: `{walletId, shardId, executor, chainId, issuedAt}` ([B-SIG-07]).
- **[W-04] Release manifest**: `{app, environment, releaseId, gitCommit, sourceDateEpoch, files: [{path, sha256, size}]}` (JSON canónico JCS); firma Ed25519 sobre los bytes exactos del archivo, en `release-manifest.json.sig` (base64).
- **[W-05] Intercambio soberano**: archivo JSON `{format: "mtw-sovereign-safetx", version: 1, chainId, safe, safeTx: {to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce}, safeTxHash, action: {type, params}, signatures: [{signer, role, signature}], createdAt}`; el receptor recalcula `safeTxHash` y decodifica `data` antes de mostrar o firmar. QR multi-frame: frames `MTWQR1:<i>/<n>:<sha256-del-contenido-completo>:<chunk-base64url>` (chunk ≤ 600 caracteres); se acepta sólo si todos los frames reconstruyen un contenido con ese SHA-256.
- **[W-06] Sobres y backup humano**: `X.enc` según [F-KEY-04]; 17 palabras según [F-KEY-06] con `MTW-WORDLIST-V1`.
- **[W-07] Matriz scope → operaciones** (backend y signer la aplican igual):

| Scope de PlatformSession | App | Operaciones/endpoints permitidos |
|---|---|---|
| `OPERATIONS` | Wallet | SEND, SWAP_APPROVE, SWAP, APPROVE_REVOKE, WHITELIST_ADD, WHITELIST_REMOVE, ROTATION_PROPOSE (U), ROTATION_EXECUTE (U), NOOP_CANCEL (U), MIGRATION_TRANSFER (U), GUARD_UPGRADE (U) |
| `RECOVERY` | Recovery | ROTATION_PROPOSE (R: roles U y S), ROTATION_EXECUTE (R), NOOP_CANCEL (R), WHITELIST_REMOVE (R), APPROVE_REVOKE (R), MIGRATION_TRANSFER (R) |
| `U_REPLACEMENT` | Wallet | registrar U' (OPAQUE PENDING) y su `KeyAcceptance` |
| `ENROLLMENT` | Recovery | endpoints de enrollment (incluye R' para reemplazo de R) |
| `ONBOARDING` | Wallet | registrar U, crear enrollment, `WalletCreationAuthorization`, deploy |
| `KEY_RESTORE` | Wallet | `user-key/restore` (nuevo registro OPAQUE para la misma U) |

## 8. Especificación de frontends

Dos aplicaciones **independientes**: `wallet/frontend/wallet` (trust domain A, U) y `wallet/frontend/recovery` (trust domain B, R). Stack común por elección (no por código compartido): React 19 + TypeScript 6.0.x + Vite 8, viem para codificación/lectura, sin librerías de UI de terceros, CSS propio con `design-tokens/tokens.css`.

### 8.1 Gestión de claves [F-KEY]

- **[F-KEY-01] Generación**: `crypto.getRandomValues(new Uint8Array(32))` → validar escalar `1 ≤ k < n` (secp256k1, `@noble/curves`); reintentar si inválido. Dirección derivada con viem `publicKeyToAddress`. Nunca `Math.random`.
- **[F-KEY-02] Password U / Password R**: generadas por la app como **5 palabras** uniformes de `MTW-WORDLIST-V1` (lista niceware de 65.536 palabras, ≈ 80 bits). El usuario las anota; confirmación reingresando 2 palabras al azar. Nunca se envían al backend ni se persisten.
- **[F-KEY-03] Derivación** (V9 §4/§5):
  - `Root_X = Argon2id(password, salt=16 bytes aleatorios, m, t=3, p=4, outLen=32)` con `m = 64 MiB` (baseline V9) para todo sobre; para U existe la opción avanzada de 128 MiB en desktop (desactivada por defecto, con advertencia de que ese sobre puede no abrir en móviles); R siempre 64 MiB porque la recuperación puede ocurrir en cualquier dispositivo. Parámetros guardados en el sobre.
  - `K_U = HKDF-SHA256(Root_U, salt="mtw-hkdf-v1", info="U-encryption-v1", 32)`; `AuthSecret_U = HKDF-SHA256(Root_U, salt="mtw-hkdf-v1", info="U-auth-v1", 32)`; `K_R = HKDF-SHA256(Root_R, salt="mtw-hkdf-v1", info="R-encryption-v1", 32)`.
  - Argon2id corre en un **Web Worker** dedicado del mismo origen con `@noble/hashes` (`argon2idAsync`, JS puro); presupuesto: ≤ 3 s p95 en el perfil móvil de referencia (si no se cumple, ADR-013 prevé `hash-wasm` fijado). HKDF y AES-GCM con WebCrypto. Vectores RFC 9106 en tests.
- **[F-KEY-04] Sobre cifrado `X.enc`** (JSON, `formatVersion: 1`): `{format:"mtw-key-envelope", formatVersion, platformId, chainId, walletId, role, keyAddress, keyVersion, kdf:{alg:"argon2id", version:19, memoryKiB, iterations, parallelism, salt}, cipher:{alg:"AES-256-GCM", nonce(12 bytes, nuevo por cifrado)}, ciphertext, createdAt}`. **AAD** = UTF-8 de `mtw-key-envelope|1|{platformId}|{chainId}|{walletId}|{role}|{keyAddress en minúsculas}|{keyVersion}`. Tras descifrar se verifica que la dirección derivada == `keyAddress`.
- **[F-KEY-05] Vida de U/R en memoria**: tras desbloquear, `K_U` se importa como `CryptoKey` AES-GCM **no exportable** (los bytes crudos se sobrescriben); U se descifra **sólo** para cada firma, se firma con `@noble/curves` sobre el hash EIP-712 calculado con viem y el `Uint8Array` se sobrescribe con ceros (best-effort). Al expirar la PlatformSession, bloquear o cerrar la pestaña se descartan las referencias.
- **[F-KEY-06] Backups** (V9 §4/§18): antes de que la Safe llegue a ACTIVE, **U y R deben tener cada una al menos un backup que no dependa de la plataforma** (archivo cifrado, QR del sobre o 17 palabras), porque el appDataFolder sólo es accesible con el cliente OAuth de la plataforma y la salida soberana debe funcionar aunque la plataforma desaparezca; Drive es el backup por defecto **adicional**. Opciones:
  1. Google Drive `appDataFolder` (default) — ver [F-DRV].
  2. Archivo cifrado descargable (`mtw-U-<walletId>.enc.json`).
  3. QR del sobre cifrado (canvas, sin librerías que usen `innerHTML`).
  4. Backup humano de la clave privada: 16 palabras (16 bits c/u) + 1 palabra de versión/checksum: `w17 = (version(4 bits) << 12) | checksum12`, `checksum12 = primeros 12 bits de SHA-256("MTW-KEY-BACKUP-V1|" ‖ rol ‖ "|" ‖ clave)`. Se muestra una sola vez, con confirmación explícita, opción de imprimir una página dedicada sin otros datos.
- **[F-KEY-07] Prohibido**: U/R en texto plano en localStorage, sessionStorage, IndexedDB, cookies, logs, analytics u observabilidad. Sólo sobres cifrados pueden cachearse en IndexedDB (opcional "recordar en este dispositivo").
- **[F-KEY-08] Cambio de Password U**: descifrar U → nuevo salt/Root → re-cifrar → subir a Drive (y ofrecer nuevo archivo) → nuevo registro OPAQUE (requiere PlatformSession OPERATIONS) → retirar registro anterior. U no cambia.
- **[F-KEY-10] Restauración en un dispositivo nuevo**: Wallet (`/restore`): (a) desde Drive (login de cuenta → OAuth → descargar `U.enc` → Password U → OPAQUE normal); (b) desde archivo o QR del sobre cifrado (mismo camino); (c) desde las 17 palabras (checksum → U → verificar que la dirección coincide con el rol U on-chain → nueva Password U → nuevo sobre → backups → PlatformSession `KEY_RESTORE` con prueba de posesión → reemplazo del registro OPAQUE). Recovery (`/restore`): R desde Drive de Recovery, archivo, QR o 17 palabras; se verifica que la dirección coincide con el rol R on-chain; con palabras se define una nueva Password R y se re-cifra. Nunca se restaura una clave cuya dirección no coincida con el rol vigente.
- **[F-KEY-09] R externa** (Recovery): wallet conectada vía wagmi; se exige **EOA** (proof-of-control con firma ECDSA EIP-712 que recupera exactamente R; conector Coinbase configurado sólo-EOA). No se aceptan smart-contract wallets como R en V1.

### 8.2 Google Drive appDataFolder [F-DRV]

- **[F-DRV-01]** OAuth 2.0 por **redirección de página completa** a `https://accounts.google.com/o/oauth2/v2/auth` con el `client_id` del proyecto de Google Cloud de **esa** app, `scope=https://www.googleapis.com/auth/drive.appdata`, `state` aleatorio (en `sessionStorage` sólo durante el viaje de ida/vuelta) y `prompt=consent` en el primer uso. Flujo según la regla de ADR-012 (spike P17.T02): (a) **authorization code + PKCE (S256) sin client secret**, canjeando el código desde el navegador contra `https://oauth2.googleapis.com/token`, si Google lo acepta para el cliente "Web application"; (b) si no, **implícito** (`response_type=token`). En ambos casos: **ningún JS de Google**, token sólo en memoria, fragmento/query limpiados con `history.replaceState` antes de renderizar, sin refresh tokens persistidos, revocación al cerrar sesión (`POST https://oauth2.googleapis.com/revoke`). **Orden**: como la redirección recarga la app y borra la memoria, la conexión con Drive se hace **antes** de generar o desbloquear la clave (onboarding: conectar Drive → volver → generar U → cifrar → subir → verificar); a través de la redirección sólo sobreviven `state` y el verificador PKCE (en `sessionStorage`), nunca claves ni sobres en claro.
- **[F-DRV-02]** REST Drive v3 con `fetch`: listar `GET /drive/v3/files?spaces=appDataFolder&q=name='U.enc.json'`, crear con `POST /upload/drive/v3/files?uploadType=multipart` (`parents:["appDataFolder"]`), actualizar con `PATCH /upload/drive/v3/files/{id}?uploadType=multipart`, leer con `GET /drive/v3/files/{id}?alt=media`. Tras subir se vuelve a descargar y se verifica byte a byte.
- **[F-DRV-03]** Proyectos de Google Cloud y clientes OAuth **separados** por app y por entorno (Wallet-local/staging/prod, Recovery-local/staging/prod) → appDataFolder separados (V9 §17). Test empírico obligatorio: un token del cliente Wallet no ve archivos del appDataFolder de Recovery y viceversa.
- **[F-DRV-04]** El backend nunca recibe tokens de Drive ni contenido de `U.enc`/`R.enc`.
- **[F-DRV-05]** El appDataFolder se borra si el usuario desinstala la app de Drive o lo elimina a mano (§3.5): un chequeo de salud **periódico** (cada 7 días o a pedido del usuario, nunca bloqueando el desbloqueo) reconecta Drive, verifica que el backup siga presente y coincida (hash) y, si falta, muestra una alerta persistente para re-subirlo; el backup independiente de la plataforma de [F-KEY-06] sigue siendo obligatorio.

### 8.3 Sesión y requests [F-SES]

- **[F-SES-01]** Login de cuenta con cookies (`credentials: 'include'`) contra el API host de esa app; CSRF token en memoria.
- **[F-SES-02]** Wallet: desbloqueo = Password U → Argon2id → OPAQUE → PlatformSession (15 min) + session key P-256 no exportable. Recovery: step-up (email OTP + TOTP si activo).
- **[F-SES-03]** Firma de requests críticos según [B-PSES-05]; envelope de envío según [B-PSES-06].
- **[F-SES-04]** Bloqueo automático por inactividad (5 min sin interacción en pantallas sensibles) y al expirar la PlatformSession.

### 8.4 Pantallas [F-UI]

Wallet (`frontend/wallet`):

| Ruta | Contenido |
|---|---|
| `/register`, `/verify-email`, `/login`, `/forgot-password`, `/reset-password` | cuenta centralizada (texto explícito: "esta password NO es tu Password U") |
| `/onboarding/*` | crear U → mostrar Password U → backups (Drive / archivo / QR / palabras) → registro OPAQUE → Activar Recovery (QR/link) → confirmar R → crear Safe → verificación → ACTIVE |
| `/unlock` | Password U → PlatformSession |
| `/restore` | restaurar U en un dispositivo nuevo desde Drive, archivo, QR o 17 palabras [F-KEY-10] |
| `/` (home) | dirección de la Safe (checksum, copiar, QR de recepción "enviá USDC en Base a esta dirección"), saldos, actividad reciente, alertas de rotaciones pendientes leídas **on-chain** |
| `/assets` | USDC, USDT: balance, símbolo, decimales, contrato (leídos on-chain y comparados con config fijada) |
| `/send` | token → destino (sólo whitelist ACTIVE) → monto → review (decodificado desde los bytes) → confirmar (Password U si la sesión no está desbloqueada) |
| `/swap` | USDC↔USDT: monto, cotización, slippage (≤ 0,5 %), review de las 2 SafeTx, confirmar |
| `/whitelist` | lista (ACTIVE/ACTIVATING con cuenta regresiva), alta (challenge por email), baja |
| `/activity` | operaciones (estados) + transfers entrantes/salientes indexados; detalle con tx hash |
| `/security` | sesiones (listar/revocar), TOTP, backups (re-exportar), cambiar Password U, "perdí mi Password U", rotaciones (pendientes, cancelar), estado de Recovery |
| `/sovereign` | importar SafeTx soberana preparada en Recovery, revisar, firmar con U, exportar firma |
| `/security/migration` | migración excepcional: muestra la Safe destino con sus owners leídos on-chain (U' propia, R, S'), la autorización on-chain y su madurez; U firma `MIGRATION_TRANSFER` |

Recovery (`frontend/recovery`, mínimo):

| Ruta | Contenido |
|---|---|
| `/login`, `/step-up` | cuenta + step-up |
| `/restore` | restaurar R desde Drive de Recovery, archivo, QR o 17 palabras [F-KEY-10] |
| `/enroll` | desde link/QR de Wallet: Enrollment Key, crear R (Password R + backups) o conectar wallet externa (chunk lazy), firmar enrollment, mostrar QR/link de regreso con R |
| `/recover-u` | propuesta de reemplazo U→U' (R firma), estado del timelock, ejecución al madurar |
| `/rotations` | pendientes (on-chain), cancelar con firma de R, ejecutar maduras |
| `/sovereign` | armar SafeTx soberana tipada (transferir saldo a dirección elegida, reemplazar S, retirar/cambiar Guard o module guard, `updateRoles` del Guard, NoOp), firmar con R, importar firma U, combinar, transmitir con wallet externa o exportar calldata |
| `/emergency` | con R + S: quitar destinos de la whitelist, cancelar una operación pendiente con NoOp y revocar allowances (botón de pánico si U está comprometida) |
| `/migration` | migración excepcional firmada por R: verificación on-chain de la Safe destino y firma de `MIGRATION_TRANSFER` |

### 8.5 Hardening de origins criptográficos [F-SEC]

- **[F-SEC-01] CSP** (header HTTP emitido por el servidor estático propio de cada frontend — contenedor `wallet-web`/`recovery-web` en producción — y por `vite preview` en local; `<meta>` equivalente en dev): `default-src 'none'; script-src 'self' [Wallet: 'wasm-unsafe-eval' — requerido por OPAQUE (WASM); Recovery: sin WASM]; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' <API host de la app> <RPC del frontend> https://www.googleapis.com https://oauth2.googleapis.com [Recovery: + endpoints de WalletConnect verificados en P19]; worker-src 'self'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; manifest-src 'none'; require-trusted-types-for 'script'; trusted-types mtw-default; upgrade-insecure-requests`.
- **[F-SEC-02] Trusted Types**: `require-trusted-types-for 'script'` con `trusted-types mtw-default`: la app crea **una sola** política `mtw-default` cuyo `createScriptURL` sólo devuelve URLs presentes en una allowlist generada en build (los assets con hash de los Web Workers, p. ej. el worker de Argon2id) y cuyo `createHTML`/`createScript` lanzan error; cualquier otra asignación de string a un sink (`innerHTML`, `script.src`, `eval`…) es bloqueada y reportada. Test E2E: el worker de Argon2id carga con TT forzado y cualquier violación (`securitypolicyviolation`) hace fallar el test. Un conector o librería que requiera sinks TT se excluye; no se relaja la política.
- **[F-SEC-03] Headers**: HSTS (2 años, preload), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` mínima (cámara sólo en rutas que escanean QR), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` (verificado compatible con los recursos propios).
- **[F-SEC-04] Sin service workers**: no se publica ningún script de SW; el servidor estático del frontend responde 403 a requests con header `Service-Worker: script`; al iniciar, la app desregistra cualquier SW existente y lo reporta.
- **[F-SEC-05] Sin third-party JS**, sin analytics, sin GTM, fuentes self-hosted, sin CDNs externos. Dependencias con versión exacta (sin `^`/`~`), lockfile congelado, `pnpm` con edad mínima de publicación y scripts de instalación bloqueados salvo allowlist.
- **[F-SEC-06] Builds reproducibles** (`SOURCE_DATE_EPOCH`, toolchain fijado) verificados compilando dos veces en runners distintos; **SRI** en todos los `<script>`/`<link>`; **manifest firmado** (Ed25519, clave de release de esa app) con `releaseId`, commit y SHA-256 de HTML/JS/WASM/CSS/assets publicado en `/.well-known/release-manifest.json(.sig)`; **SBOM** CycloneDX por build.
- **[F-SEC-08] Contratos del sistema fijados por entorno**: el build de cada app embebe `system-contracts.<env>.json` (address + codehash de Guard, Timelock, PolicyRegistry, Whitelist, SwapExecutor, Bootstrap, Factory y DenyAllModuleGuard), generado desde `contracts/deployments/<env>.json` y cubierto por el manifest firmado; si el backend informa direcciones distintas, la app se niega a operar. La clave pública de atestación del signer ([B-SIG-07]) también se embebe por entorno.
- **[F-SEC-09] Dependencias comunes**: un upgrade de una dependencia criptográfica común (`@noble/*`, `viem`, `@scure/*`) no se publica en Wallet y Recovery en la misma ventana (mínimo 72 h entre ambos releases) y requiere aprobación de revisores de cada dominio (V9 §17).
- **[F-SEC-07]** Wallet **no incluye** wagmi ni conectores. Recovery carga wagmi/conectores **sólo** en el chunk lazy de "wallet externa"; los flujos de R interna nunca importan ese chunk (test de grafo de bundle).

### 8.6 Conectores (Recovery) [F-CON]

- **[F-CON-01]** wagmi + viem con conectores: `injected` (EIP-6963: MetaMask, Coinbase Wallet extension, Rabby, etc.), `metaMask`, `coinbaseWallet` (preferencia **sólo EOA**), `walletConnect` (`projectId`, `showQrModal: false`, QR propio en canvas a partir del evento `display_uri`).
- **[F-CON-02]** Cadena fija Base (8453; en local el fork 8453 vía RPC propio). Se rechaza cualquier firma si la wallet reporta otra cadena.
- **[F-CON-03]** Firmas sólo con `eth_signTypedData_v4` (EIP-712). Nunca `eth_sign`/`personal_sign` para SafeTx.
- **[F-CON-04]** Compatibilidad CSP/Trusted Types de cada conector verificada en P19; un conector incompatible se excluye y se documenta.

### 8.7 Links y QR entre apps [F-LNK]

- **[F-LNK-01]** Wallet → Recovery: `https://recovery.<RECOVERY_DOMAIN>/enroll#eid=<enrollmentId>&n=<nonce>` (fragmento, no llega a servidores) + QR equivalente.
- **[F-LNK-02]** Recovery → Wallet: `https://wallet.<WALLET_DOMAIN>/onboarding/confirm-recovery#eid=<id>&r=<R>` + QR. La Wallet compara `r` del fragmento con el R que reporta el backend; si difieren → abortar. Si el usuario usa otro dispositivo sin link, la Wallet exige comparación manual de la dirección completa antes de que U firme.
- **[F-LNK-03]** Intercambio soberano (SafeTx parcialmente firmada) vía archivo JSON o QR multi-frame con el formato [W-05] — nunca vía backend.

## 9. Threat model y assertions de seguridad

### 9.1 Activos y adversarios

| Activo | Dónde vive | Quién no debe poder usarlo solo |
|---|---|---|
| Fondos USDC/USDT en la Safe | Base | ninguna parte individual (U, R, S, Wallet FE, Recovery FE, Backend/Signer) |
| U (clave privada) | memoria del Wallet FE durante la firma; `U.enc` en Drive Wallet/archivo | backend, Recovery |
| R (clave privada o wallet externa) | memoria del Recovery FE; `R.enc` en Drive Recovery | backend, Wallet |
| S (clave por Safe) | signer shard: keystore V3 cifrado en el volumen del shard; credencial de desbloqueo en un secret separado | backend API, worker, DB, Valkey |
| Password U / R | sólo en la cabeza/papel del usuario | todos |
| Sesiones, PlatformSession | cookies HttpOnly / memoria | terceros |
| Integridad de releases | contenedor estático de cada app (imagen firmada por digest) + manifest firmado con claves que no están en el host | backend (no puede firmar FE), pipeline del otro FE |

Adversarios considerados: atacante externo (phishing, credential stuffing, XSS, supply chain npm), insider o compromiso del backend/DB/cola, compromiso de un signer shard, compromiso del pipeline/hosting de un frontend, proveedor RPC malicioso o inconsistente, reorgs, MEV/sandwich en swaps, robo de dispositivo, pérdida de credenciales por parte del usuario.

### 9.2 Matriz de assertions (V9 §20 + adicionales)

| ID | Assertion | Enforcement principal | Tests (fase) |
|---|---|---|---|
| A1 | U sola nunca ejecuta una SafeTx asistida | threshold Safe + Guard exige S como msg.sender y co-firmante | P07 adversarial, P23 |
| A2 | R sola nunca ejecuta una SafeTx asistida | ídem | P07, P23 |
| A3 | S sola nunca alcanza threshold | threshold 2 + Guard exige `{S, X}` con X ∈ {U,R} | P07, P23 |
| A4 | U+S sólo ejecuta acciones permitidas por policy y Guard | Guard [C-GRD] + PolicyRegistry RESTRICTED + backend + signer | P07, P13–P14, P23 |
| A5 | R+S sólo ejecuta recovery permitido o flujo excepcional autorizado | Guard: tabla de operaciones por rol + autorización de migración on-chain | P07, P15, P23 |
| A6 | U+R opera sin Backend/S y sin business policies | Guard: camino soberano sin chequeos de negocio; modo soberano client-side | P07, P19, P23 |
| A7 | El Guard clasifica sólo con signers del threshold validado | parser espejo + `checkNSignatures` [C-GRD-03] | P04, P07 (fuzz de firmas), P23 |
| A8 | DELEGATECALL, modules y fallback cerrados en camino asistido | Guard + DenyAllModuleGuard + verificación de estado pre/post | P04, P07, P23 |
| A9 | Salida externa a destino no autorizado falla aunque U esté comprometida | DestinationWhitelist on-chain + challenge email + Guard | P05, P07, P14, P23 |
| A10 | Approvals/permits/operator rights fallan por defecto si no están tipificados | Guard: denylist de selectores de autoridad + única excepción approve→SwapExecutor | P04, P06, P07 |
| A11 | Safe con configuración distinta a Factory/Bootstrap no alcanza ACTIVE | WalletFactory verificación atómica + verificación backend + verificación Wallet FE | P05, P12, P18 |
| A12 | Una firma no puede reusarse con otro nonce, Safe o chain | EIP-712 SafeTx (domain chainId + verifyingContract, nonce) | P07, P13 |
| A13 | Cancelar con nonce N invalida cualquier SafeTx pendiente con nonce N | nonce de Safe + NoOp | P07, P13, P23 |
| A14 | Comprometer un único trust domain no entrega control completo | separación de dominios + todas las anteriores | P23, P27 |
| A15 | Ninguna allowance persistente a terceros; tras un swap asistido la allowance Safe→SwapExecutor es 0 | Guard post-check + SwapExecutor pull-only-from-caller | P06, P07 |
| A16 | El swap sólo opera USDC↔USDT, pool canónico, recipient = Safe, minOut ≥ piso | SwapExecutor inmutable | P06, P07, P23 |
| A17 | Rotaciones asistidas sólo tras 48 h y sin cancelación | RotationTimelock + Guard | P05, P07 |
| A18 | Backend solo no puede alterar la whitelist ni falsificar autorización del usuario | alta sólo por `msg.sender == safe` con firma U | P05, P14, P23, P27 |
| A19 | El signer nunca co-firma dos SafeTx distintas activas para el mismo (safe, nonce) sin reemplazo autorizado | estado propio del signer | P11, P13, P23 |
| A20 | Un frontend alterado (≠ manifest) pausa la cooperación de S | integrity monitor + atestación exigida por signer | P20, P23 |
| A21 | Ningún secreto/U/R/password/OTP aparece en logs, DB o analytics | redacción + tests de canario + revisión de esquema | P08–P19, P23, P24 |

### 9.3 Escenarios de compromiso (resumen; se profundiza en `docs/THREAT_MODEL.md` en P01 y se ataca en P27)

| Escenario | Qué obtiene el atacante | Por qué no alcanza para robar | Detección/mitigación |
|---|---|---|---|
| Wallet FE comprometido (JS malicioso) | U (al ingresar Password U) | sin S no hay threshold; con S (vía flujos normales) sólo a destinos whitelisteados; alta de destino requiere código enviado al email que muestra la dirección exacta | integrity monitor pausa S; email muestra dirección; activación de destino a 24 h |
| Recovery FE comprometido | R | R+S limitado a recovery (rotación con 48 h y cancelable por U) y migración autorizada on-chain | notificaciones on-chain leídas por Wallet; integrity monitor |
| Backend/DB/cola comprometidos | puede intentar inyectar operaciones, alterar estados, emitir sesiones y atestaciones de challenge (tiene esas claves) | no tiene U/R: toda operación exige firma U/R válida; S está en el signer que re-verifica firma, policy, configuración de la Safe y estado on-chain con su propio RPC; rotación de S sólo a claves creadas por el signer; Guard on-chain. **Límite conocido**: contra un backend comprometido, la verificación de PlatformSession y de challenges en el signer no agrega independencia (son claves del mismo dominio). | audit chain HMAC, reconciliación, alertas |
| Signer shard comprometido (keystores + credencial de desbloqueo) | S de las Safes de ese shard | S sola no alcanza threshold (A3) | rotación de S vía timelock con firma U; alarmas del signer; HSM físico como hardening futuro |
| RPC malicioso | respuestas falsas | quórum de dos proveedores; Guard on-chain decide al final | alertas de desacuerdo |
| Phishing de whitelist | usuario confirma destino del atacante | requiere además U; 24 h de activación con email; alerta in-app | educación + bajas inmediatas (también con R desde `/emergency`) |
| Rotación de S hacia clave del atacante | U comprometida + backend comprometido proponen `S → S_attacker` como "mantenimiento" | el signer sólo co-firma rotaciones de S hacia claves que él mismo creó para esa wallet; U o R pueden cancelar durante 48 h | notificaciones on-chain leídas por ambos frontends |
| U+R retiran o cambian el Guard | la Safe ya no tiene enforcement on-chain | backend y signer verifican la configuración on-chain antes de cada co-firma y dejan de cooperar (`SOVEREIGN_MODIFIED`) | reconciliación + alerta |
| Keystore de S perdido o corrupto | operaciones asistidas imposibles para esa Safe | backups cifrados (age) de keystores off-host + credencial custodiada aparte; restore con `restore-verify`; si es irrecuperable, U+R reemplazan S soberanamente y ejecutan `updateRoles` | runbook + test |
| MEV/sandwich en swaps | captura de valor dentro del slippage | piso on-chain de 0,5 %, slippage por defecto 0,3 %, deadline 10 min | riesgo residual documentado |
| JS distinto servido sólo a ciertos usuarios | el monitor no lo ve | builds reproducibles, SRI, servidor estático propio por dominio | riesgo residual documentado |
| Root del host del backend comprometido (CF-10) | S de los shards del host, secretos de Compose y API; **no** el JS de los frontends (servidores propios, ADR-022) | S sigue necesitando la firma de U o R para cualquier SafeTx; manifests firmados fuera del host; monitor off-host alerta; kill-switch y playbook (P26.T16): detener servicios, rotar S de todas las Safes vía timelock | riesgo residual documentado (RR-01) |
| Root del servidor de un frontend o de su cuenta de hosting | Puede servir JS malicioso en el origin de **esa** app (U **o** R; ambas sólo si los dos frontends comparten cuenta o proveedor de hosting: RR-16, CF-11) | manifests firmados fuera del servidor; el monitor local pausa la cooperación de S ante un mismatch mediante la `IntegrityAttestation` (A20, P20.T03) y el chequeo off-host alerta (P20.T02.a); la otra clave sigue intacta; playbook de servidor de frontend comprometido (P26.T16) | riesgo residual documentado (equivale a ESC-01/ESC-02 del threat model) |

## 10. Estrategia de testing

| Capa | Herramientas | Alcance | Umbral |
|---|---|---|---|
| Contratos unit/integration | Foundry (`forge test`) | cada contrato y su integración con Safe real | 100 % de funciones externas con test |
| Contratos fuzz | Foundry fuzz (runs ≥ 10.000 en CI, 1.000 local) | parser de firmas, decoders, montos, timelocks | sin fallos |
| Contratos invariant | Foundry invariant (handlers con actores U, R, S, atacante, relayer) | A1–A17 como invariantes | depth ≥ 50, runs ≥ 500 en CI |
| Contratos fork | Foundry con `--fork-url` al fork fijado (`FORK_BLOCK_NUMBER`) | Safe/USDC/USDT/Uniswap reales | obligatorio |
| Cobertura contratos | `forge coverage --report lcov` | `src/` propio | ≥ 95 % líneas y ≥ 90 % ramas |
| Análisis estático | Slither (versión fijada) + revisión manual de cada detector | `src/` | 0 High/Medium sin triage documentado |
| Backend/signer unit | Vitest | dominio, decoders, policy, máquina de estados | ≥ 90 % líneas en `domain/`, `chain/`, `policy/` |
| Backend integración | Vitest + Testcontainers (PostgreSQL 18, Valkey 9) + Anvil fork real | DB, cola, worker, API, signer dev | obligatorio |
| Backend seguridad | Vitest + Fastify inject | authz, CSRF, rate limits, replay, sesiones, OTP, idempotencia | obligatorio |
| Resiliencia | proxy de inyección de fallas RPC (test-only, delante del fork real), kill de procesos, Valkey flush | timeouts, desacuerdo, reorg, crash, restart, dos workers | obligatorio |
| Frontend unit | Vitest (jsdom) | crypto (vectores Argon2id/HKDF/AES-GCM/AAD), wordlist, backup de 17 palabras, codificación SafeTx, validaciones | ≥ 90 % en `crypto/` |
| Frontend integración | Vitest + backend real local | flujos de API y lectura on-chain | obligatorio |
| E2E | Playwright (Chromium; Firefox y WebKit en nightly) | todos los flujos de prompt §30 | obligatorio |
| Acceptance full-system | Playwright + scripts viem sobre el fork | 22 pasos de prompt §31 + caminos de falla | obligatorio antes de producción |
| Supply chain / secretos | gitleaks, OSV-Scanner, `pnpm audit`, Semgrep, zizmor, Trivy, syft | todo el repo/imagenes | 0 secretos; 0 vulnerabilidades High/Critical sin excepción documentada |

Reglas:

1. **Sin mocks del funcionamiento blockchain**: los tests que involucran cadena usan el fork de Base (Anvil) con contratos reales. Impersonación (`anvil_impersonateAccount`) y fondeo (`deal`/`anvil_setStorageAt` sobre balances reales de USDC/USDT) se usan **sólo** para preparar escenarios de test, nunca en el código de producto.
2. Vectores de prueba cruzados: `contracts/test/vectors/*.json` (SafeTxHash, codificación de calldata, firmas, direcciones CREATE2) generados por Foundry y consumidos por backend, signer y ambos frontends — cada consumidor guarda su copia y CI verifica que coincidan con la fuente.
3. Cada bug encontrado agrega un test de regresión antes del fix.
4. `FORK_BLOCK_NUMBER` fijo en CI; RPC cacheado por bloque (cache de Foundry) para reproducibilidad y costo.

## 11. Fases de ejecución

Resumen de fases:

| Fase | Nombre | Depende de |
|---|---|---|
| P00 | PREFLIGHT | — |
| P01 | Fundaciones del repositorio y toolchain fijado | P00 |
| P02 | CI base | P01 |
| P03 | Base fork y contratos externos verificados | P01 |
| P04 | Contratos I: librerías, PolicyRegistry, DestinationWhitelist, DenyAllModuleGuard | P03 |
| P05 | Contratos II: SecurityGuard, RotationTimelock, SafeBootstrap, WalletFactory | P04 |
| P06 | Contratos III: SwapExecutor (Uniswap USDC↔USDT) | P05 |
| P07 | Contratos IV: suite adversarial, fuzz/invariants, cobertura, Slither, deploy/seed local | P06 |
| P08 | Backend I: fundaciones (config, DB, cola, RPC, logs, métricas, OpenAPI, errores, idempotencia, rate limit, audit) | P07 |
| P09 | Backend II: cuenta y autenticación + email | P08 |
| P10 | Backend III: PlatformSession (OPAQUE, step-up, requests firmados) | P09 |
| P11 | Signer S self-hosted: signer-service, SignerProvider (development/selfhosted/hardware futuro), ciclo de vida de keystores, policy snapshot, gas tank | P10 |
| P12 | Backend IV: creación de wallet (enrollment R, incorporación U, S, deploy, verificación) | P11 |
| P13 | Backend V: pipeline de operaciones (estados, nonce, outbox/cola, worker, finalidad, reorgs, reconciliación, indexer) | P12 |
| P14 | Backend VI: whitelist, send, swap | P13 |
| P15 | Backend VII: rotaciones, recovery, migración excepcional, notificaciones | P14 |
| P16 | Frontends: base común por elección (hardening, build reproducible, design tokens) | P08 (puede correr en paralelo con P09–P15) |
| P17 | Frontend Wallet I: cuenta, gestión de U, backups, desbloqueo | P15, P16 |
| P18 | Frontend Wallet II: onboarding Safe, home, assets, whitelist, send, swap, actividad, seguridad | P15, P17 |
| P19 | Frontend Recovery | P15, P16 |
| P20 | Integridad de releases y pausa de cooperación de S | P18, P19 |
| P21 | Entorno local integrado y seed determinístico | P20 |
| P22 | Tests frontend y E2E Playwright | P21 |
| P23 | Acceptance tests full-system sobre el fork | P22 |
| P24 | Observabilidad, audit trail y abuse prevention (cierre) | P23 |
| P25 | Entornos, scripts de despliegue/verificación y deploy de staging sobre el fork | P24 |
| P26 | PRODUCTION READINESS: preparación para la VPS (artefactos, compose, scripts, runbooks, ensayo local; sin desplegar) | P25 |
| P27 | SECURITY AUDIT | P26 |
| P28 | SECURITY REMEDIATION (gate) | P27 |
| P29 | Documentación final, trazabilidad y release candidate | P28 |
| P30 | PRODUCTION READINESS: gate final, producción completa sobre el fork y paquete de go-live | P29 |

Checklist estándar de CHECKPOINT (cada fase lo incluye con comandos concretos):

```text
CHECKPOINT Pxx
[ ] build pasa
[ ] tests pasan
[ ] security tests pasan
[ ] integración anterior sigue funcionando
[ ] documentación actualizada
[ ] no secrets committed
[ ] git status revisado
```

---

### P00 — PREFLIGHT

**Objetivo:** que el entorno local tenga todo lo obligatorio para ejecutar el planner de punta a punta y que exista un comando único que **detecte, auto-remedie y verifique** (`PREFLIGHT PASSED`) o se detenga explicando exactamente qué falta, sólo cuando no pueda resolverlo solo.

**Archivos/componentes:** `wallet/package.json` (orquestación), `wallet/docker-compose.yml`, `wallet/scripts/preflight` (bash) y `wallet/scripts/preflight.d/*.mjs`, `wallet/scripts/tools/{bootstrap,versions.json}`, `wallet/scripts/env.sh`, `wallet/scripts/lib/*.sh`, `wallet/scripts/start-fork`, `stop-fork`, `reset-fork`, `wallet/scripts/secrets-local`, `wallet/.env.example`, `wallet/.env`, `wallet/docs/SETUP_EXTERNAL_SERVICES.md`.

**Dependencias:** ninguna. Credenciales externas de local: `BASE_RPC_URL` (archive), `BASE_RPC_URL_SECONDARY`, `WALLETCONNECT_PROJECT_ID`, `GOOGLE_CLIENT_ID_WALLET`, `GOOGLE_CLIENT_ID_RECOVERY` , `ETHERSCAN_API_KEY` y Mailgun (`EMAIL_PROVIDER_API_KEY`, `EMAIL_PROVIDER_DOMAIN`, `EMAIL_PROVIDER_BASE_URL`; dominio sandbox) (provistas por el owner el 2026-10-17), más las de los tests contra servicios reales: `GOOGLE_DRIVE_TEST_*` y `EMAIL_TEST_*`. El preflight las busca y valida (P00.T08) y sólo pide las que no encuentre (`SETUP_EXTERNAL_SERVICES.md` → USER ACTION REQUIRED).

**Implementación requerida:**

- [x] **P00.T01** — Crear `wallet/package.json` sólo de orquestación: `"private": true`, `"packageManager": "pnpm@12.14.0"` (§3.6), `"engines": {"node": "<versión exacta de .node-version>"}`, scripts: `preflight` (`bash scripts/preflight`), `secrets:local`, `infra:up` (`docker compose up -d`), `infra:down`, `fork:start`, `fork:stop`, `fork:reset`. Sin dependencias. Crear `wallet/.node-version` con la versión exacta de Node 26 (26.12.0, o la primera 26.x LTS si ya fue publicada — ADR-028) y `wallet/scripts/preflight.d/versions.json` con las versiones exactas exigidas por el preflight (Node, pnpm, Foundry v1.8.5, Slither 0.11.6, gitleaks 8.30.1, imágenes por digest).
      Verificación: `cd wallet && pnpm run` lista los scripts; `git diff --stat` sólo muestra archivos bajo `wallet/`.
- [x] **P00.T01.a** — `scripts/tools/bootstrap` + `scripts/tools/versions.json` (ADR-032): instala en `wallet/.tools/` (gitignored, sin sudo) Node 26 (tarball oficial de nodejs.org verificado con `SHASUMS256.txt`), pnpm 12.14.0 (con el npm de ese Node; Node 26 no trae Corepack), Foundry v1.8.5 (release oficial + `.sha256`), gitleaks 8.30.1 (release + `checksums.txt`) y Slither 0.11.6 (venv local; si no hay Python ≥ 3.10, imagen Docker fijada); `scripts/env.sh` antepone `wallet/.tools/*/bin` al `PATH` y todos los scripts del proyecto lo usan. Plataformas soportadas: linux-x64 y darwin-arm64.
      Verificación: en un shell sin las herramientas en el `PATH`, `bash scripts/tools/bootstrap && source scripts/env.sh && node -v && pnpm -v && forge --version && slither --version && gitleaks version` devuelve exactamente las versiones fijadas; una descarga alterada (checksum distinto) aborta.
- [x] **P00.T02** — Crear `wallet/docker-compose.yml` con imágenes **fijadas por digest** (tag+digest también en `versions.json`; en P01 pasan a `docs/VERSIONS.md`): `postgres:18.6` (healthcheck `pg_isready`, volumen, init script que crea las DBs `mtw_wallet` y `mtw_signer_dev` y los roles `mtw_migrator`/`mtw_app`/`mtw_signer` con las passwords del `.env`), `valkey/valkey:9.2` (`--appendonly yes --maxmemory-policy noeviction --requirepass $REDIS_PASSWORD`), `ghcr.io/foundry-rs/foundry:v1.8.5` (su entrypoint es `/bin/sh -c`: pasar el comando completo) corriendo `anvil --host 0.0.0.0 --port 8545 --fork-url ${BASE_RPC_URL} --fork-block-number ${FORK_BLOCK_NUMBER} --chain-id 8453 --block-time 2` con volumen para la caché RPC de Foundry, y `axllent/mailpit:v1.31.6`. Puertos host según §5.3. (El `BASE_RPC_URL` queda visible en `docker inspect` local: aceptable sólo en local.)
      Verificación: `docker compose config` sin errores; `docker compose up -d && docker compose ps` → todos `healthy`.
- [x] **P00.T03** — Scripts `scripts/start-fork`, `scripts/stop-fork`, `scripts/reset-fork` (bash, `set -euo pipefail`): start levanta sólo el servicio `anvil` y espera a que `eth_chainId == 0x2105`; stop lo detiene; reset ejecuta `anvil_reset` con `{forking:{jsonRpcUrl: BASE_RPC_URL, blockNumber: FORK_BLOCK_NUMBER}}` (o reinicia el contenedor) y verifica `anvil_nodeInfo.forkConfig.forkBlockNumber == FORK_BLOCK_NUMBER` y `eth_blockNumber == FORK_BLOCK_NUMBER`.
      Verificación: `pnpm fork:reset && cast block-number --rpc-url http://127.0.0.1:8545` = `FORK_BLOCK_NUMBER`.
- [x] **P00.T03.a** — Crear `config/chains/base-mainnet.json` y `config/chains/schema.json` con los valores ya verificados de §3.1–§3.4 (chainId, `forkBlockNumber`, direcciones y codehash de Safe, tokens y Uniswap, fuentes y fecha). P03 lo re-verifica con fork tests y lo extiende; PF-15 lo usa desde P00.
      Verificación: `node scripts/preflight.d/validate-chain-config.mjs` (valida contra el schema) y PF-15 en verde.
- [x] **P00.T04** — `scripts/secrets-local`: sólo si `APP_ENV=local`, completa en `wallet/.env` los secretos **locales** vacíos con valores aleatorios (`openssl rand`, `node:crypto` para Ed25519): `POSTGRES_PASSWORD`, passwords de los roles de DB, `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `SIGNER_DATABASE_URL`, `REDIS_PASSWORD`, `REDIS_URL`, `LOCAL_SEED`, `SESSION_SECRET`, `CSRF_SECRET`, `SESSION_ISSUER_PRIVATE_KEY/PUBLIC_KEY`, `APP_FIELD_ENCRYPTION_KEY`, `OTP_HMAC_KEY`, `PASSWORD_PEPPER_V1`, `AUDIT_CHAIN_KEY`, credencial de desbloqueo del shard de desarrollo (`wallet/.secrets/signer/dev-1/unlock.key`, fuera del directorio de keystores), clave Ed25519 de atestación del signer, pares Ed25519 de desarrollo para policy, integrity monitor y releases; genera CA y certificados mTLS de desarrollo en `wallet/.secrets/mtls/` (gitignored). Nunca sobrescribe valores existentes; se niega a correr si `APP_ENV != local`.
      Verificación: correrlo dos veces no cambia valores; `git status` no muestra `.env` ni `.secrets/`.
- [x] **P00.T05** — `scripts/preflight` (bash) + `scripts/preflight.d/*.mjs` (Node, sin dependencias externas) implementando los checks PF-01…PF-33 de abajo con el ciclo **detect → auto-remediar → verificar** (por defecto remedia lo remediable: toolchain con `scripts/tools/bootstrap`, secretos locales con `secrets-local`, servicios compose caídos con `docker compose up -d`, imágenes faltantes con `docker pull` por digest; `--no-fix` sólo diagnostica), con flags `--env local|staging|production` y `--json`. El `.env` se lee con un parser propio (nunca `source`) que respeta comillas y comentarios en línea, sin imprimir valores. Los checks marcados "desde Pxx" se activan solos cuando existe el artefacto correspondiente (p. ej. PF-25 por cada `package.json`/`foundry.toml` de proyecto presente, PF-29 si existe `backend/app/package.json`, PF-26 si existe `e2e/package.json`); el resumen indica qué checks se omitieron y por qué. Cada FAIL imprime: **qué falta**, **variable**, **cómo obtenerla**, **documento interno** (`docs/SETUP_EXTERNAL_SERVICES.md#<ancla>`) y termina con código ≠ 0 ("STOP"). Si todo pasa imprime exactamente `PREFLIGHT PASSED`.
      Verificación: casos de prueba de P00.T06 en verde.
- [x] **P00.T06** — Tests del preflight (`scripts/preflight.d/__tests__/*.test.mjs` con `node --test`): variable faltante → FAIL con ancla correcta; formato inválido de URL/ID → FAIL; RPC con chainId incorrecto → FAIL; puerto ocupado → FAIL; `.env` no ignorado → FAIL; todo correcto → `PREFLIGHT PASSED`.
      Verificación: `node --test scripts/preflight.d/__tests__/`.
- [x] **P00.T07** — Actualizar `SETUP_EXTERNAL_SERVICES.md` para que cada ancla citada por el preflight exista (test que compara anclas).
      Verificación: `node --test scripts/preflight.d/__tests__/anchors.test.mjs`.
- [x] **P00.T08** — Credenciales externas con autodiscovery: el preflight busca `BASE_RPC_URL`, `BASE_RPC_URL_SECONDARY`, `WALLETCONNECT_PROJECT_ID`, `GOOGLE_CLIENT_ID_WALLET`, `GOOGLE_CLIENT_ID_RECOVERY`, `GOOGLE_DRIVE_TEST_*`, `EMAIL_TEST_*` y `EMAIL_PROVIDER_*` (Mailgun) en las variables de entorno del proceso y en `wallet/.env`, las valida **sin mostrarlas** (PF-13, PF-14, PF-19, PF-20, PF-30, PF-31, PF-32) y las reutiliza; sólo las que falten o no validen se informan como **USER ACTION REQUIRED** (con su sección de `SETUP_EXTERNAL_SERVICES.md`) y en ese caso STOP.
      Verificación: PF-11, PF-13, PF-14, PF-19, PF-20, PF-30, PF-31 y PF-32 en verde (credencial encontrada y validada sin mostrarla) o reporte USER ACTION REQUIRED con la sección exacta de SETUP; nunca se pegan valores en el planner.
- [x] **P00.T09** — Ejecutar `cd wallet && docker compose up -d && pnpm preflight` hasta obtener `PREFLIGHT PASSED`; pegar el resumen (sin secretos) en el Registro de ejecución.
      Verificación: salida `PREFLIGHT PASSED` y resumen pegado (sin secretos) en §13.

Checks del preflight:

| ID | Check | Obligatorio en |
|---|---|---|
| PF-01 | bash ≥ 4, git ≥ 2.34 (firma SSH de commits; ninguna función usada requiere una versión mayor — ajustado el 2026-10-17 desde 2.40, ver §13), curl, openssl, tar, xz y python3 ≥ 3.10 (si falta Python, Slither usa la imagen Docker fijada); no auto-remediable sin privilegios → STOP con instrucción | todos |
| PF-02 | Node == `.node-version`: detecta en `wallet/.tools` y en el sistema; si falta o difiere → `scripts/tools/bootstrap node` y re-verifica | todos |
| PF-03 | pnpm == `packageManager`: si falta o difiere → bootstrap con el npm del Node fijado y re-verifica | todos |
| PF-04 | forge, cast, anvil == Foundry fijado: si falta o difiere → bootstrap y re-verifica | todos |
| PF-05 | Docker Engine activo + Compose v2 (si el daemon está detenido intenta iniciarlo sin sudo; si no está instalado o no hay permisos → STOP: es la única dependencia de sistema obligatoria) | todos |
| PF-06 | Slither == versión fijada: si falta o difiere → venv `wallet/.tools/slither` (o imagen Docker fijada) y re-verifica | todos |
| PF-07 | gitleaks == versión fijada: si falta o difiere → bootstrap (o imagen Docker fijada) y re-verifica | todos |
| PF-08 | Imágenes de herramientas de seguridad (Semgrep, OSV-Scanner, zizmor, syft, Trivy) presentes por digest; si faltan → `docker pull` automático | todos |
| PF-09 | Puertos libres: 5173, 5174, 8080, 8081, 8090, 8545, 55432, 56379, 1025, 8025, 9464–9470 (o en uso por los servicios propios ya levantados) | local |
| PF-10 | `wallet/.env` existe y `git check-ignore -q wallet/.env` | todos |
| PF-11 | Variables obligatorias del entorno presentes y con formato válido (URLs, direcciones EIP-55, claves base64 de longitud correcta, IDs de OAuth `*.apps.googleusercontent.com`) | todos |
| PF-12 | Secretos locales presentes (si faltan, `pnpm secrets:local` se ejecuta automáticamente) — y **prohibidos** valores de ejemplo en staging/prod | todos |
| PF-13 | `BASE_RPC_URL`: `eth_chainId == 0x2105`, latencia < 2 s | todos |
| PF-14 | `BASE_RPC_URL` es archive: `eth_getCode(USDC, FORK_BLOCK_NUMBER)` no vacío y `eth_getBalance(<Safe singleton>, FORK_BLOCK_NUMBER)` responde | local/CI |
| PF-15 | `FORK_BLOCK_NUMBER` ≤ bloque `finalized` y todas las direcciones de `config/chains/base-mainnet.json` tienen el codehash esperado en ese bloque | local/CI |
| PF-16 | `BASE_RPC_URL_SECONDARY`: chainId 8453, head a ≤ 10 bloques del primario, proveedor distinto | staging/prod (local si está definida) |
| PF-17 | Servicios compose: Postgres ≥ 18 (`select version()`), Valkey (`PING`, `noeviction`, `appendonly yes`), Anvil (`chainId 8453`, `forkBlockNumber` correcto, USDC con código), Mailpit (`/api/v1/info`) | local |
| PF-18 | `DATABASE_URL` y `REDIS_URL` conectan desde el host | todos |
| PF-19 | `WALLETCONNECT_PROJECT_ID`: 32 hex + validación online `POST https://rpc.walletconnect.org/v1/?chainId=eip155:8453&projectId=<ID>` con `eth_chainId` y header `Origin: <RECOVERY_ORIGIN>` → debe responder 200 con `0x2105` (un projectId inválido responde 401, verificado el 2026-10-16) | todos |
| PF-20 | `GOOGLE_CLIENT_ID_WALLET` y `GOOGLE_CLIENT_ID_RECOVERY`: formato, distintos entre sí, y el endpoint de autorización no devuelve `invalid_client`/`redirect_uri_mismatch` para el origin del entorno | todos |
| PF-21 | Email: local → Mailpit SMTP+API; mailgun → `GET <EMAIL_PROVIDER_BASE_URL>/v3/domains/<EMAIL_PROVIDER_DOMAIN>` con la API key devuelve 200 y `state: active` | todos |
| PF-22 | `ETHERSCAN_API_KEY` válida (API v2, `chainid=8453`) | staging/prod/deploy |
| PF-23 | Disco libre ≥ 15 GB; RAM ≥ 8 GB (WARN si menor) | local |
| PF-24 | Branch == `feat/walletWeb/cmarchese` (local) y `gitleaks` sin hallazgos en el índice | local |
| PF-25 | Lockfiles presentes y consistentes en cada proyecto existente (`pnpm install --frozen-lockfile --prefer-offline` dry check) | desde P01 |
| PF-26 | Navegadores de Playwright instalados (si existe `wallet/e2e`) | desde P22 |
| PF-27 | Signer: directorio de keystores escribible por el UID del signer, credencial de desbloqueo presente en una ubicación **distinta** de la de los keystores, y `credentialFingerprint` coincidente con la DB del signer si ya hay claves (local: `wallet/.secrets/signer/dev-1/`, generado si falta) | todos |
| PF-28 | Certificados mTLS presentes, no vencidos, CA correcta (local: regenerados automáticamente si faltan o vencen) | todos |
| PF-29 | `OPAQUE_SERVER_SETUP` presente (desde P10; se genera con `pnpm --dir backend/app opaque:setup`) | desde P10 |
| PF-30 | `GOOGLE_DRIVE_TEST_*`: el refresh token obtiene un access token (`POST https://oauth2.googleapis.com/token` → 200) y `GET https://www.googleapis.com/drive/v3/files?spaces=appDataFolder` responde 200 | local/CI |
| PF-31 | `EMAIL_TEST_*`: el refresh token de Gmail obtiene un access token (`POST https://oauth2.googleapis.com/token` → 200) y `GET https://gmail.googleapis.com/gmail/v1/users/me/profile` devuelve `emailAddress == EMAIL_TEST_ADDRESS` (scope `gmail.readonly`; sin mostrar ni loguear tokens) | local/CI |
| PF-32 | API real de Mailgun para los tests: `GET <EMAIL_PROVIDER_BASE_URL>/v3/<EMAIL_PROVIDER_DOMAIN>/events?limit=1` con la API key → 200 | local/CI |
| PF-33 | Resumen final y código de salida | todos |

**Tests a implementar:**

- [x] **P00.TST** — P00.T06.
      Verificación: `node --test scripts/preflight.d/__tests__/`.

**Checks manuales:**

- [x] **P00.MAN** — leer la salida de un preflight con una variable borrada y confirmar que el mensaje permite resolverla sin otra documentación.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** con un clon limpio + credenciales locales cargadas: `docker compose up -d && pnpm preflight` imprime `PREFLIGHT PASSED`; borrando cualquier variable obligatoria, el preflight termina con STOP y el mensaje exacto.

**Security checks:**

- [x] **P00.SEC** — `.env` y `.secrets/` ignorados; el preflight nunca imprime valores secretos (sólo "presente/ausente" y huellas truncadas); `secrets-local` se niega fuera de local.
      Verificación: `gitleaks git --redact` sin hallazgos y `scripts/secrets-local` se niega con `APP_ENV=staging`.

**Commits:** `chore(infra): add local compose stack and fork scripts`, `feat(infra): add preflight checks`.

#### CHECKPOINT P00

- [x] build pasa: `docker compose config` sin errores.
- [x] tests pasan: `node --test scripts/preflight.d/__tests__/`.
- [x] security tests pasan: `gitleaks git --redact` sin hallazgos y `scripts/secrets-local` se niega con `APP_ENV=staging`.
- [x] integración anterior sigue funcionando: N/A (primera fase): `git diff --stat main -- . ':!wallet'` vacío (el mock de la raíz no se tocó).
- [x] documentación actualizada: `node --test scripts/preflight.d/__tests__/anchors.test.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P01:** `PREFLIGHT PASSED` registrado en el Registro de ejecución.

---

### P01 — Fundaciones del repositorio y toolchain fijado

**Objetivo:** estructura de `wallet/`, versiones exactas verificadas y fijadas, convenciones, ADRs y threat model base.

**Archivos/componentes:** `wallet/.node-version`, `wallet/.editorconfig`, `wallet/.gitattributes`, `wallet/.gitleaks.toml`, `wallet/docs/VERSIONS.md`, `wallet/docs/adr/ADR-001…032`, `wallet/docs/THREAT_MODEL.md`, `wallet/config/wordlist/*`, `wallet/scripts/hooks/pre-commit`, plantillas de `.npmrc`/settings de pnpm por proyecto.

**Dependencias:** P00.

**Implementación requerida:**

- [x] **P01.T01** — Re-verificar contra fuentes oficiales (registry npm, nodejs.org, releases de GitHub, Docker Hub) cada versión de §3.6 y fijar **versiones exactas** en `docs/VERSIONS.md` (herramienta, versión, URL, fecha, digest para imágenes) y en `scripts/tools/versions.json` (URL oficial + SHA-256 por plataforma). Si una versión cambió desde la fecha de este planner, actualizar la tabla y anotar el motivo en el Registro de ejecución.
      Verificación: `docs/VERSIONS.md` no contiene rangos (`^`, `~`, `latest`); cada fila tiene URL y fecha.
- [x] **P01.T02** — Confirmar/actualizar `.node-version` (Node 26 LTS exacta, ADR-028), `packageManager` (pnpm exacta), Foundry (`foundryup --install v1.8.5` documentado), solc exacto (P03), Slither exacto, y sincronizar `scripts/preflight.d/versions.json` con `docs/VERSIONS.md` (test de igualdad).
      Verificación: `pnpm preflight` sigue en `PREFLIGHT PASSED`.
- [x] **P01.T03** — Crear la estructura de directorios de §5.2 (sólo carpetas con `README.md` de una línea que indique qué fase las implementa; ningún código simulado).
      Verificación: `tree -d wallet -L 2` coincide con §5.2.
- [x] **P01.T04** — Convenciones: `.editorconfig`, `.gitattributes` (`* text=auto eol=lf`), configuración de Prettier/ESLint **por proyecto** (se crean al crear cada proyecto, no compartidas).
      Verificación: `git ls-files wallet/.editorconfig wallet/.gitattributes` y `git diff --check` sin errores de fin de línea.
- [x] **P01.T05** — Política de supply chain de pnpm (aplicada en cada proyecto al crearlo): `save-exact=true`, edad mínima de publicación de paquetes (≥ 7 días, setting de pnpm verificado en la doc de la versión fijada), bloqueo de scripts de instalación salvo allowlist explícita, `strict-peer-dependencies=true`, `--frozen-lockfile` en CI. Documentar en `docs/VERSIONS.md#supply-chain`.
      Verificación: `node scripts/check-pnpm-policy.mjs` confirma `save-exact`, edad mínima de publicación, scripts de instalación bloqueados y `strict-peer-dependencies` en cada proyecto existente.
- [x] **P01.T06** — `wallet/docs/adr/`: un archivo por cada ADR de §4 (ADR-001…ADR-032: contexto, decisión, alternativas, consecuencias).
      Verificación: `ls wallet/docs/adr | wc -l` = 32 y `node scripts/check-docs.mjs` sin errores.
- [x] **P01.T06.a** — `scripts/check-docs.mjs` (sin dependencias): valida anclas y links internos de todos los `.md` bajo `wallet/`, que todo ID `[C-…]`, `[B-…]`, `[F-…]`, `ADR-…` y `Pxx.Tyy` citado esté definido, y que cada tarea del planner tenga línea `Verificación:`. Se usa en todos los CHECKPOINT ("documentación actualizada").
      Verificación: `node scripts/check-docs.mjs` → `DOCS OK`.
- [x] **P01.T07** — `wallet/docs/THREAT_MODEL.md` v1 a partir de §9 (activos, adversarios, escenarios, assertions A1–A21, comportamientos deliberados).
      Verificación: `node scripts/check-docs.mjs` y revisión de un agente revisor independiente registrada en §13.
- [x] **P01.T08** — Wordlist: vendorizar la lista niceware 4.0.0 (npm `niceware@4.0.0`, tarball con integridad verificada) como `config/wordlist/mtw-wordlist-v1.txt` (una palabra por línea, LF, orden original) + `mtw-wordlist-v1.sha256` = `c2bf4e5b768581bc101620e9ec735e1b91b9b3e33d10535c5fbcada87b1e7e1e` + `LICENSE-niceware` (MIT). Script de verificación: 65.536 entradas, únicas, `[a-z]+`, ordenadas, hash exacto.
      Verificación: `node scripts/verify-wordlist.mjs` → OK.
- [x] **P01.T09** — `wallet/.gitleaks.toml` (reglas por defecto + patrones propios: claves Ed25519 PEM, `OPAQUE_SERVER_SETUP`, keystores) y hook `scripts/hooks/pre-commit` (lo instala `scripts/tools/bootstrap`) (gitleaks sobre staged + lint del archivo tocado).
      Verificación: `gitleaks git --redact` (o subcomando equivalente de la versión fijada) sin hallazgos y prueba con un secreto de mentira en un archivo temporal no commiteado → el hook lo detecta.

**Tests a implementar:**

- [x] **P01.TST** — verificación de wordlist; test que falla si algún `package.json` bajo `wallet/` contiene rangos de versión (se activa a medida que existen proyectos).
      Verificación: `node scripts/verify-wordlist.mjs && node scripts/check-docs.mjs`.

**Checks manuales:**

- [x] **P01.MAN** — revisar ADRs contra V9 y prompt (CF-01 no bloquea y CF-06 ya está aprobado).
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** versiones fijadas y trazables; ADRs y threat model presentes; wordlist verificada.

**Security checks:**

- [x] **P01.SEC** — licencia y hash de la wordlist; ningún paquete instalado sin versión exacta.
      Verificación: `gitleaks git --redact` sin hallazgos.

**Commits:** `docs(wallet): add architecture decision records and threat model`, `chore(wallet): pin toolchain versions and add wordlist v1`.

#### CHECKPOINT P01

- [x] build pasa: `pnpm preflight` → `PREFLIGHT PASSED`.
- [x] tests pasan: `node scripts/verify-wordlist.mjs && node scripts/check-docs.mjs`.
- [x] security tests pasan: `gitleaks git --redact` sin hallazgos.
- [x] integración anterior sigue funcionando: `docker compose up -d && pnpm fork:reset`.
- [x] documentación actualizada: `node scripts/check-docs.mjs` → `DOCS OK`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P02:** versiones exactas registradas y toolchain local verificado con `scripts/tools/bootstrap`.

---

### P02 — CI base

**Objetivo:** que cada área tenga pipeline reproducible desde el inicio, separada por trust domain, y un runner local equivalente.

**Archivos/componentes:** `wallet/ci/scripts/*.sh`, `wallet/ci/actions/*/action.yml` (composite), `wallet/package.json` (`ci:local`), y `.github/workflows/wallet-*.yml` (aprobados por el owner el 2026-10-16).

**Dependencias:** P01.

**Implementación requerida:**

- [ ] **P02.T01** — Crear `.github/workflows/wallet-contracts.yml`, `wallet-backend.yml`, `wallet-signer.yml`, `wallet-frontend-wallet.yml`, `wallet-frontend-recovery.yml`, `wallet-security.yml`, `wallet-e2e.yml`, `wallet-repro-build.yml` (disparadores finos con `paths: ['wallet/<área>/**']`) y `.github/CODEOWNERS` con un equipo revisor por trust domain (contracts, backend/signer, frontend-wallet, frontend-recovery, infra). **Aprobado por el owner el 2026-10-16: no volver a preguntar.**
      Verificación: archivos presentes y `docker run --rm -v "$PWD:/src" <imagen zizmor fijada> /src/.github/workflows` sin hallazgos High.
- [ ] **P02.T02** — Scripts `wallet/ci/scripts/ci-<área>.sh` que ejecutan, si el proyecto existe (si no, imprimen `SKIP: proyecto no creado aún (fase Pxx)`): instalación con lockfile congelado, lint, typecheck, unit, integración, cobertura y build del área. `ci-contracts.sh`: `forge build --sizes`, `forge test --profile ci` (unit, integración, fork, fuzz, invariants), `forge coverage` con umbrales (≥ 95 % líneas, ≥ 90 % ramas en `src/`; falla si no se cumplen) y **Slither** (`slither . --config-file slither.config.json --fail-high --fail-medium`). `ci-security.sh`: gitleaks (historia completa del branch), OSV-Scanner sobre todos los lockfiles, `pnpm audit --prod` por proyecto, Semgrep (reglas TS + Solidity), zizmor sobre workflows. Herramientas vía imágenes Docker fijadas por digest.
      Verificación: `pnpm ci:local` corre todos los scripts y termina en verde.
- [ ] **P02.T03** — Workflows: acciones fijadas por **SHA de commit**, `permissions: contents: read` por defecto, sin `pull_request_target`, `concurrency` por ref, caché de Foundry RPC por `FORK_BLOCK_NUMBER`, secretos por **GitHub Environment** separado por área (el workflow de Recovery no puede leer secretos de Wallet y viceversa), runners efímeros. `wallet-e2e.yml` en PR con label `e2e` y nightly. `wallet-repro-build.yml` compila cada frontend dos veces en jobs distintos y compara manifests. Jobs cubiertos: lint, typecheck, tests, fork tests, fuzz/invariants, Slither, security scans, builds y builds reproducibles. **Ningún workflow despliega** (los artefactos de release se agregan en P26.T02.a, también sin deploy).
      Verificación: un PR de prueba dispara sólo los workflows del área tocada.
- [ ] **P02.T04** — `wallet/docs/CI.md`: matriz de jobs, secretos por Environment y required checks. El agente aplica con `gh api` la branch protection de la rama principal (required checks, revisión de CODEOWNERS, "include administrators", commits firmados; el `gh` del entorno tiene permisos de administrador, verificado el 2026-10-17), carga con `gh secret set` los secrets que usa CI (`BASE_RPC_URL` —la misma URL de local—, `GOOGLE_DRIVE_TEST_*`, `EMAIL_TEST_*` y `EMAIL_PROVIDER_*`) y crea los Environments sin reviewer obligatorio, restringidos a tags `wallet-v*` protegidos por un ruleset, para que la ejecución no frene.
      Verificación: `node scripts/check-docs.mjs` (incluye `docs/CI.md`).

**Tests a implementar:**

- [ ] **P02.TST** — el propio pipeline; zizmor sin hallazgos High.
      Verificación: `pnpm ci:local`.

**Checks manuales:**

- [ ] **P02.MAN** — verificar con `gh api` que los Environments tienen secretos separados, que `production` sólo acepta tags `wallet-v*` protegidos y que existen los secrets de CI (`BASE_RPC_URL`, `GOOGLE_DRIVE_TEST_*`, `EMAIL_TEST_*`, `EMAIL_PROVIDER_*`).
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** `pnpm ci:local` verde y workflows verdes en el branch.

**Security checks:**

- [ ] **P02.SEC** — acciones fijadas por SHA; mínimos permisos; sin secretos en logs de CI (máscaras).
      Verificación: `bash ci/scripts/ci-security.sh`.

**Commits:** `ci(wallet): add per-domain ci scripts and workflows`.

#### CHECKPOINT P02

- [ ] build pasa: `pnpm ci:local`.
- [ ] tests pasan: `pnpm ci:local`.
- [ ] security tests pasan: `bash ci/scripts/ci-security.sh`.
- [ ] integración anterior sigue funcionando: `pnpm preflight`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P03:** `pnpm ci:local` verde y workflows de GitHub Actions corriendo en el branch.

---

### P03 — Base fork y contratos externos verificados

**Objetivo:** fijar y verificar on-chain (en el bloque del fork) todas las dependencias externas: Safe, Uniswap, USDC, USDT; dejar el proyecto Foundry con dependencias fijadas.

**Archivos/componentes:** `wallet/config/chains/base-mainnet.json`, `wallet/contracts/foundry.toml`, `remappings.txt`, `lib/` (o Soldeer), `wallet/contracts/test/fork/ExternalContracts.t.sol`, `wallet/scripts/verify-external`, `wallet/docs/EXTERNAL_CONTRACTS.md`.

**Dependencias:** P01.

**Implementación requerida:**

- [ ] **P03.T01** — Re-verificar y completar `config/chains/base-mainnet.json` (creado en P00.T03.a): `chainId`, `forkBlockNumber`, `confirmations` (ADR-018), explorer, y para cada contrato externo de §3.2–§3.4: `address`, `codehash`, `source` (URL), `verifiedAt`, `notes` (proxy/implementation para tokens).
      Verificación: JSON Schema propio (`config/chains/schema.json`) valida el archivo.
- [ ] **P03.T02** — Inicializar `wallet/contracts` (Foundry): solc exacto (§3.6), `evm_version` compatible con Base (verificar en P03.T03 que el bytecode corre en el fork), `optimizer` habilitado (runs 200, `via_ir` sólo si se justifica), perfiles `default`, `ci` (fuzz 10.000 runs, invariants profundidad 50), `fork`. Dependencias con **Soldeer** fijadas en `soldeer.lock` (versión exacta y checksum del registry; Safe por commit git): `forge-std` 1.17.0, `@openzeppelin-contracts` 5.6.1, `@uniswap-v3-core` 1.0.1 (sólo tests) y `safe-smart-account` 1.5.0 (`dc437e8`). No se usan submódulos porque `.gitmodules` tendría que vivir en la raíz del repositorio (R-02; cambio registrado en §13). `script/verify-deps.sh` compara cada `.sol` instalado con el commit del tag oficial (GitHub por SHA) o con el tarball de npm (integridad sha512) y exige el commit exacto de Safe.
      Verificación: `forge build` OK; `bash script/verify-deps.sh` → `DEPENDENCIAS VERIFICADAS`; PF-25 valida `soldeer.lock`.
- [ ] **P03.T03** — `test/fork/ExternalContracts.t.sol` (fork en `FORK_BLOCK_NUMBER`): cada dirección tiene código y `extcodehash` == config; Safe singleton `VERSION()` == versión fijada; `SafeProxyFactory.proxyCreationCode()` hash esperado; USDC/USDT `name/symbol/decimals` (6); pool Uniswap: `factory.getPool(USDC, USDT, fee) == pool`, `token0/token1/fee` correctos, liquidez > 0.
      Verificación: `forge test --match-path test/fork/ExternalContracts.t.sol --fork-url $BASE_RPC_URL --fork-block-number $FORK_BLOCK_NUMBER`.
- [ ] **P03.T04** — `scripts/verify-external` (cast): recorre `base-mainnet.json` y verifica codehash en un bloque dado (default `FORK_BLOCK_NUMBER`; `--block latest` para monitoreo en producción). Integrarlo como PF-15.
      Verificación: `bash scripts/verify-external --block $FORK_BLOCK_NUMBER` → todos OK; alterar un codehash en una copia temporal del JSON → FAIL.
- [ ] **P03.T05** — `docs/EXTERNAL_CONTRACTS.md`: tabla completa + supuestos de confianza por token (emisor, upgradeability, pausa/blacklist) y por Uniswap/Safe; política ante cambio de implementación de un proxy de token (alerta + revisión, no bloqueo automático de retiros).
      Verificación: `node scripts/check-docs.mjs` y cada dirección de `EXTERNAL_CONTRACTS.md` coincide con `config/chains/base-mainnet.json` (test `node scripts/check-external-docs.mjs`).
- [ ] **P03.T06** — Documentar en `docs/runbooks/fork.md` cómo cambiar `FORK_BLOCK_NUMBER` (re-verificar codehash, liquidez y tests; commit dedicado). Incluir la advertencia del upgrade **Denim** de Base (bloques de 200 ms, mainnet previsto para noviembre de 2026): antes de mover el fork a un bloque posterior a Denim, verificar compatibilidad de la versión de Anvil fijada y ajustar `--block-time` y los parámetros de confirmación locales.
      Verificación: `node scripts/check-docs.mjs` (runbook presente y enlazado).

**Tests a implementar:**

- [ ] **P03.TST** — P03.T03.
      Verificación: `forge test --match-path test/fork/ExternalContracts.t.sol --fork-url $LOCAL_RPC_URL`.

**Checks manuales:**

- [ ] **P03.MAN** — contrastar cada dirección contra la fuente oficial citada.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** fork reproducible y todas las dependencias externas verificadas por codehash en el bloque fijado.

**Security checks:**

- [ ] **P03.SEC** — ninguna dirección se acepta sin fuente oficial + verificación on-chain; ningún token falso desplegado.
      Verificación: `bash scripts/verify-external --block $FORK_BLOCK_NUMBER`.

**Commits:** `feat(contracts): pin external base dependencies and fork verification`.

#### CHECKPOINT P03

- [ ] build pasa: `forge build` (en `contracts/`).
- [ ] tests pasan: `forge test --match-path test/fork/ExternalContracts.t.sol --fork-url $LOCAL_RPC_URL`.
- [ ] security tests pasan: `bash scripts/verify-external --block $FORK_BLOCK_NUMBER`.
- [ ] integración anterior sigue funcionando: `pnpm preflight && pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P04:** codehash de todas las dependencias externas verificados en el bloque fijado.

---

### P04 — Contratos I: librerías, PolicyRegistry, DestinationWhitelist, DenyAllModuleGuard

**Objetivo:** piezas on-chain sin dependencias del Guard, con tests unitarios completos.

**Archivos/componentes:** `contracts/src/libraries/{SafeSignatureParser.sol,CallDecoder.sol,Roles.sol,OpTypes.sol}`, `contracts/src/interfaces/{ISafe.sol,ITransactionGuard.sol,IModuleGuard.sol,ISecurityGuard.sol,IPolicyRegistry.sol,IDestinationWhitelist.sol,IRotationTimelock.sol,ISwapExecutor.sol,IUniswapV3PoolMinimal.sol}`, `contracts/src/{PolicyRegistry.sol,DestinationWhitelist.sol,DenyAllModuleGuard.sol}`, `contracts/test/unit/*`.

**Dependencias:** P03.

**Implementación requerida:**

- [ ] **P04.T01** — Interfaces mínimas tomadas de Safe v1.5.0 (firmas exactas de §3.2: `ITransactionGuard`, `IModuleGuard`, `getStorageAt`, `getOwners`, `getThreshold`, `nonce`, `getTransactionHash`, `getModulesPaginated`, `setGuard`, `setModuleGuard`, `swapOwner`) y de Uniswap v3 (pool `swap`, `token0/token1/fee`, callback). Interfaces propias de §6.
      Verificación: test que compara selectores de las interfaces con los de la Safe real del fork (`bytes4(keccak256(...))` vs código desplegado).
- [ ] **P04.T02** — `SafeSignatureParser` [C-PAR-01] + test diferencial [C-PAR-02] contra la Safe real (fork).
      Verificación: `forge test --match-contract SafeSignatureParser --fork-url $LOCAL_RPC_URL` (incluye el diferencial con ≥ 10.000 runs en perfil `ci`).
- [ ] **P04.T03** — `CallDecoder` [C-DEC-01..03] con tests de longitud exacta (bytes extra, truncados, selector parcial) y **test parametrizado** que recorre cada selector de autoridad de [C-DEC-03] (`increaseAllowance`, `decreaseAllowance`, `permit` EIP-2612 y DAI, `setApprovalForAll`, `transferFrom`, `authorizeOperator`, `send`, `transferWithAuthorization`, `receiveWithAuthorization`, `transferAndCall`, `approveAndCall`, `safeTransferFrom` ×2, `safeBatchTransferFrom`, cualquier llamada a Permit2) verificando su clasificación como autoridad económica.
      Verificación: `forge test --match-contract CallDecoderTest`.
- [ ] **P04.T04** — `PolicyRegistry` [C-POL-01..06]: modos, registros, timelock 24 h, guardianes, revocación inmediata, sucesores de Guard y module guard ([C-POL-06]), eventos.
      Verificación: `forge test --match-contract PolicyRegistryTest`.
- [ ] **P04.T05** — `DestinationWhitelist` [C-WHL-01..03].
      Verificación: `forge test --match-contract DestinationWhitelistTest`.
- [ ] **P04.T06** — `DenyAllModuleGuard` [C-MGD] + test en fork: `setModuleGuard(DenyAll)` aceptado por Safe 1.5.0 (ERC-165) y cualquier `execTransactionFromModule` revierte.
      Verificación: `forge test --match-contract DenyAllModuleGuardTest --fork-url $LOCAL_RPC_URL`.

**Tests a implementar:**

- [ ] **P04.TST** — unit + fuzz de cada contrato; PolicyRegistry: transición BOOTSTRAP→RESTRICTED irreversible, alta antes de 24 h no activa, cancelación por guardián, revocación inmediata, guardián no puede cancelar su propia baja, admin distinto rechazado; Whitelist: activación a las 24 h exactas (`vm.warp`), aislamiento entre Safes, `dest == msg.sender` rechazado.
      Verificación: `forge test`.

**Checks manuales:**

- [ ] **P04.MAN** — revisión de NatSpec y eventos.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** `forge test --match-path 'test/unit/*'` verde; cobertura de estos contratos ≥ 95 % líneas.

**Security checks:**

- [ ] **P04.SEC** — `slither src/PolicyRegistry.sol src/DestinationWhitelist.sol src/DenyAllModuleGuard.sol src/libraries` sin High/Medium sin triage.
      Verificación: `slither . --config-file slither.config.json --fail-high --fail-medium` (en `contracts/`).

**Commits:** `feat(contracts): add policy registry, destination whitelist and deny-all module guard`.

#### CHECKPOINT P04

- [ ] build pasa: `forge build --sizes`.
- [ ] tests pasan: `forge test`.
- [ ] security tests pasan: `slither . --config-file slither.config.json --fail-high --fail-medium` (en `contracts/`).
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P05:** test diferencial del parser verde con ≥ 10.000 runs.

---

### P05 — Contratos II: SecurityGuard, RotationTimelock, SafeBootstrap, WalletFactory

**Objetivo:** núcleo de seguridad integrado con la Safe v1.5.0 real del fork.

**Archivos/componentes:** `contracts/src/{SecurityGuard.sol,RotationTimelock.sol,SafeBootstrap.sol,WalletFactory.sol}` (y `AssistedPolicyEngine.sol` si [C-GRD-16] lo exige), `contracts/test/integration/*`.

**Dependencias:** P04.

**Implementación requerida:**

- [ ] **P05.T01** — `RotationTimelock` [C-RTL-01..05].
      Verificación: `forge test --match-contract RotationTimelockTest`.
- [ ] **P05.T02** — `SecurityGuard` [C-GRD-01..17] con contexto apilado por Safe en transient storage, inmutable `WALLET_FACTORY` predicho y registro sólo para Safes de la factory.
      Verificación: `forge build --sizes` — si el runtime > 24.576 bytes aplicar [C-GRD-16] y documentar en ADR-003.
- [ ] **P05.T03** — `SafeBootstrap` [C-BST-01..02].
      Verificación: `forge test --match-contract SafeBootstrapTest --fork-url $LOCAL_RPC_URL`.
- [ ] **P05.T04** — `WalletFactory` [C-FAC-01..06] usando `createProxyWithNonceL2` de la factory real.
      Verificación: `forge test --match-contract WalletFactoryTest --fork-url $LOCAL_RPC_URL`.
- [ ] **P05.T05** — `script/DeployCore.s.sol` [C-SCR-01] (con predicción y verificación de la dirección de `WalletFactory`, §6.1) y `VerifyDeployment.s.sol` [C-SCR-02] ejecutables contra el fork.
      Verificación: `forge script script/DeployCore.s.sol --rpc-url $LOCAL_RPC_URL --broadcast` seguido de `forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL` → OK.
- [ ] **P05.T06** — Tests de integración en fork: creación de Safe y verificación completa; NoOp; transfer a destino whitelisteado activo (OK) y no whitelisteado (revert); approve a executor (OK) / a Permit2 / a otro (revert); propuesta y ejecución de rotación con `vm.warp(48h)`; cancelación por firma de U y por firma de R; camino soberano U+R: retirar Guard, cambiar S, transferir a cualquier dirección (OK sin backend); `msg.sender ≠ S` en asistido (revert); firma S tipo `v=1` (revert en asistido). Cambios soberanos de configuración: U+R ejecutan `enableModule`, `setFallbackHandler`, `setModuleGuard(otro)` y `setModuleGuard(0)` (OK) y luego se verifica que el camino asistido queda deshabilitado (fail-closed, [C-GRD-03] paso 6) hasta que U+R restauran la configuración. **El camino soberano nunca revierte**: `setGuard(0)`, MultiSend vía DELEGATECALL, `execTransaction` anidado y cualquier otra tx U+R pasan. Registro: una Safe creada directo con SafeProxyFactory + SafeBootstrap (sin la factory) o un contrato que imita a una Safe no puede registrarse. Upgrade del Guard [C-GRD-17]: sin sucesor registrado, antes de 48 h o con la propuesta cancelada → revert; completo → OK.
      Verificación: `forge test --match-path 'test/integration/*' --fork-url $LOCAL_RPC_URL`.

**Tests a implementar:**

- [ ] **P05.TST** — los de P05.T06 + unit de cada contrato.
      Verificación: `forge test --fork-url $LOCAL_RPC_URL`.

**Checks manuales:**

- [ ] **P05.MAN** — inspeccionar con `cast` una Safe creada: owners, threshold, slots de guard/module guard/fallback, `rolesOf`.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** A1, A2, A3, A6, A7, A8, A11, A12, A13, A17 con test explícito verde.

**Security checks:**

- [ ] **P05.SEC** — Slither sobre `src/`; revisión manual de cada llamada externa en el Guard.
      Verificación: `slither . --config-file slither.config.json --fail-high --fail-medium` (en `contracts/`) + `forge test --match-path 'test/integration/*' --fork-url $LOCAL_RPC_URL`.

**Commits:** `feat(contracts): add security guard, rotation timelock and wallet factory`, `feat(wallet): add deterministic safe deployment`.

#### CHECKPOINT P05

- [ ] build pasa: `forge build --sizes` (Guard < 24.576 bytes o [C-GRD-16] aplicado).
- [ ] tests pasan: `forge test --fork-url $LOCAL_RPC_URL`.
- [ ] security tests pasan: `slither . --config-file slither.config.json --fail-high --fail-medium` (en `contracts/`) + `forge test --match-path 'test/integration/*' --fork-url $LOCAL_RPC_URL`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P06:** Safe creada por la factory alcanza todas las verificaciones de [C-FAC-05] en el fork.

---

### P06 — Contratos III: SwapExecutorV3

**Objetivo:** swaps USDC↔USDT contra el pool real del fork con el diseño de menor riesgo (ADR-015).

**Archivos/componentes:** `contracts/src/SwapExecutorV3.sol`, `contracts/test/fork/Swap*.t.sol`, `docs/adr/ADR-015-*.md` (análisis completo de alternativas: router, UniversalRouter+Permit2, v4, MultiSend).

**Dependencias:** P05.

**Implementación requerida:**

- [ ] **P06.T01** — `SwapExecutorV3` [C-SWP-01..05].
      Verificación: `forge test --match-contract SwapExecutorV3Test --fork-url $LOCAL_RPC_URL`.
- [ ] **P06.T02** — Registro del executor y de USDC/USDT en `PolicyRegistry`; integración con [C-GRD-07]/[C-GRD-09].
      Verificación: `forge test --match-contract SwapGuardIntegrationTest --fork-url $LOCAL_RPC_URL`.
- [ ] **P06.T03** — Tests en fork: USDC→USDT y USDT→USDC reales (saldos verificados, executor sin fondos, allowance final 0); fill parcial (monto que excede liquidez) → revert y el callback **nunca** paga un monto distinto del delta pedido por el pool; `minOut` bajo el piso → revert; deadline vencido → revert; token arbitrario → revert; callback llamado por un no-pool → revert; reentrancia → revert; recipient distinto de la Safe imposible por construcción; approve residual sin swap no utilizable por terceros (un atacante que llama `swap` paga con **su** allowance, no la de la Safe).
      Verificación: `forge test --match-path 'test/fork/Swap*.t.sol' --fork-url $LOCAL_RPC_URL`.
- [ ] **P06.T04** — Script de cotización de referencia (QuoterV2 `eth_call`) usado por los tests para validar `minOut`.
      Verificación: `forge test --match-contract QuoteReferenceTest --fork-url $LOCAL_RPC_URL`.

**Tests a implementar:**

- [ ] **P06.TST** — P06.T03 + fuzz de montos (1 unidad … 10.000 tokens) y slippage.
      Verificación: `forge test --fork-url $LOCAL_RPC_URL`.

**Checks manuales:**

- [ ] **P06.MAN** — comparar resultado del swap en fork con la cotización QuoterV2 al mismo bloque.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** A15 y A16 verdes; ADR-015 con el análisis escrito.

**Security checks:**

- [ ] **P06.SEC** — Slither; verificación de que no existe ninguna ruta de `transferFrom` con payer ≠ `msg.sender`.
      Verificación: `slither . --config-file slither.config.json --fail-high --fail-medium` (en `contracts/`) + `forge test --match-path 'test/fork/Swap*.t.sol' --fork-url $LOCAL_RPC_URL`.

**Commits:** `feat(swap): add restricted usdc usdt swap executor`.

#### CHECKPOINT P06

- [ ] build pasa: `forge build --sizes`.
- [ ] tests pasan: `forge test --fork-url $LOCAL_RPC_URL`.
- [ ] security tests pasan: `slither . --config-file slither.config.json --fail-high --fail-medium` (en `contracts/`) + `forge test --match-path 'test/fork/Swap*.t.sol' --fork-url $LOCAL_RPC_URL`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P07:** swaps reales en fork en ambos sentidos con post-condiciones del Guard verificadas.

---

### P07 — Contratos IV: suite adversarial, fuzz/invariants, cobertura, Slither, deploy/seed local

**Objetivo:** demostrar las invariantes de seguridad y dejar `deploy-local`/`seed-local` reproducibles; exportar ABIs y vectores.

**Archivos/componentes:** `contracts/test/adversarial/*.t.sol`, `contracts/test/invariant/{handlers/*,WalletInvariants.t.sol}`, `contracts/test/vectors/*.json` + generador, `contracts/script/{DeployLocal.s.sol,SeedLocal.s.sol,ExportAbis.s.sol}`, `wallet/scripts/{deploy-local,seed-local}`, `contracts/slither.config.json`, `contracts/deployments/local.json` (gitignored).

**Dependencias:** P06.

**Implementación requerida:**

- [ ] **P07.T01** — Suite adversarial `test/adversarial/` (un test por ataque, prompt §28; cada subtarea = un contrato de test que **demuestra que el ataque falla**). Corre en los dos modos de policy (P07.T09).
      Verificación: `forge test --match-path 'test/adversarial/*' --fork-url $LOCAL_RPC_URL` (todas las subtareas en verde).
  - [ ] **P07.T01.a** — send a destino no whitelisteado (y a destino pendiente de activación, y a destino de otra Safe).
  - [ ] **P07.T01.b** — DELEGATECALL en camino asistido.
  - [ ] **P07.T01.c** — ejecución por módulo (con y sin módulo habilitado soberanamente) y llamada al fallback.
  - [ ] **P07.T01.d** — parámetros de gas/refund: `safeTxGas`, `baseGas`, `gasPrice` ≠ 0, `gasToken` ≠ 0, `refundReceiver` ≠ 0 (vector de drenaje por refund) y `value` ≠ 0 en camino asistido.
  - [ ] **P07.T01.e** — executor incorrecto (`msg.sender ≠ S`) y combinación de signers incorrecta.
  - [ ] **P07.T01.f** — U sola, R sola, S sola (threshold y clasificación).
  - [ ] **P07.T01.g** — firmas malformadas: longitud, `v` inválido, orden, duplicadas, tipos `v=0/1/>30` en asistido, bytes anexados para engañar la clasificación.
  - [ ] **P07.T01.h** — replay en otro nonce, otra Safe y otra cadena; nonce incorrecto.
  - [ ] **P07.T01.i** — bypass de rotación y de timelock (ejecutar antes de 48 h, con old ≠ rol, propuesta cancelada, R proponiendo rol R).
  - [ ] **P07.T01.j** — swap de token arbitrario, recipient arbitrario, calldata maliciosa (longitud/encoding), minOut bajo el piso.
  - [ ] **P07.T01.k** — allowance persistente: approve a Permit2, router, otro spender; cada selector de autoridad de [C-DEC-03].
  - [ ] **P07.T01.l** — inicialización de factory: Safe sin bootstrap, re-setup, front-run de `createWallet`, initializer alterado.
  - [ ] **P07.T01.m** — implementación de Safe incorrecta (otro singleton/versión/proxy factory).
  - [ ] **P07.T01.n** — cambios administrativos asistidos: `addOwnerWithThreshold`, `removeOwner`, `changeThreshold`, `setGuard`, `setModuleGuard`, `enableModule`, `setFallbackHandler`, `approveHash`, `execTransaction` anidado.
  - [ ] **P07.T01.o** — migración no autorizada y R+S intentando operar como U+S (send, swap, whitelist add).
  - [ ] **P07.T01.p** — suplantación de registro: contrato que imita las vistas de una Safe, Safe creada sin la factory, re-registro de una Safe ya registrada.
  - [ ] **P07.T01.q** — el Guard nunca bloquea el camino soberano: `setGuard(0)`, `setModuleGuard(0)`, MultiSend vía DELEGATECALL, `execTransaction` anidado, transferencias a cualquier destino.
  - [ ] **P07.T01.r** — upgrade del Guard: sucesor no registrado, propuesta inmadura o cancelada, `setGuard` hacia un contrato arbitrario en camino asistido.
- [ ] **P07.T02** — Invariant tests con handlers (actores U, R, S, atacante, relayer; operaciones aleatorias asistidas y soberanas, warps de tiempo): A1–A17 como invariantes (`invariant_*`), p. ej. "ningún saldo sale de la Safe hacia un destino no whitelisteado por camino asistido", "allowance a terceros siempre 0", "roles del Guard == owners tras cualquier secuencia asistida", "ninguna tx asistida exitosa tuvo gas params, gasToken, refundReceiver o value ≠ 0", "toda tx U+R con firmas válidas se ejecuta (el Guard nunca la revierte)".
      Verificación: `forge test --profile ci --match-path 'test/invariant/*'`.
- [ ] **P07.T03** — Cobertura: `forge coverage --report lcov --report summary` ≥ 95 % líneas y ≥ 90 % ramas en `src/`.
      Verificación: `forge coverage --report summary` cumple ≥ 95 % líneas y ≥ 90 % ramas en `src/` (el script de CI falla si no).
- [ ] **P07.T04** — Slither 0.11.6 con `slither.config.json` (excluye `lib/` y `test/`); cada hallazgo resuelto o justificado en `docs/security/slither-triage.md` (no `disable` sin justificación).
      Verificación: `slither . --config-file slither.config.json --fail-high --fail-medium` y `docs/security/slither-triage.md` sin hallazgos abiertos.
- [ ] **P07.T05** — Vectores cruzados `test/vectors/*.json` (SafeTxHash por tipo de operación, calldata, firmas EIP-712 de ejemplo con claves de test, direcciones CREATE2 predichas, typed data de `CancelRotation`) + `pnpm`-agnóstico: script `contracts/script/export-vectors.sh`.
      Verificación: `bash script/export-vectors.sh && git diff --exit-code test/vectors` (regenerar no produce cambios).
- [ ] **P07.T06** — Export de ABIs (`contracts/script/export-abis.sh`) a `contracts/out-abi/*.json`; cada consumidor (backend, signer, wallet, recovery) los copia a su propio directorio en su fase con check de igualdad en CI.
      Verificación: `bash script/export-abis.sh && git diff --exit-code out-abi`.
- [ ] **P07.T07** — Agregar `deploy-local` y `seed-local` a los scripts de `wallet/package.json`; `scripts/deploy-local` (corre `DeployLocal.s.sol` contra Anvil, escribe `deployments/local.json`, idempotente: si ya hay deploy para este estado del fork lo verifica) y `scripts/seed-local` [C-SCR-03] determinístico; `pnpm fork:reset && pnpm deploy-local && pnpm seed-local` produce siempre las mismas direcciones y saldos.
      Verificación: `pnpm fork:reset && pnpm deploy-local && pnpm seed-local` dos veces → mismas direcciones y saldos (`diff` de `deployments/local.json`).
- [ ] **P07.T08** — `docs/security/invariants.md`: mapa assertion → test.
      Verificación: `node scripts/check-docs.mjs` y cada A1–A17 tiene al menos un test listado.
- [ ] **P07.T09** — Perfiles de policy: `deploy-local --policy-mode restricted` (default, igual que producción, set V1 de [C-POL-04]) y `--policy-mode bootstrap` (desarrollo de contratos). CI corre P07.T01–T02 en **ambos** modos; en RESTRICTED se verifica además que operaciones desconocidas y tokens no soportados revierten ([C-GRD-03] paso 7, [C-GRD-06]).
      Verificación: `POLICY_MODE=restricted forge test --profile ci` y `POLICY_MODE=bootstrap forge test --profile ci`.

**Tests a implementar:**

- [ ] **P07.TST** — P07.T01–T02.
      Verificación: `POLICY_MODE=restricted forge test --profile ci && POLICY_MODE=bootstrap forge test --profile ci`.

**Checks manuales:**

- [ ] **P07.MAN** — revisión independiente del triage de Slither por un agente revisor (contexto nuevo); cada objeción se resuelve o se documenta con su justificación.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** todos los ataques del prompt §28 con test que **falla el ataque**; invariantes verdes en perfil `ci`; cobertura en umbral; seed reproducible.

**Security checks:**

- [ ] **P07.SEC** — Slither + Semgrep (reglas Solidity) sin hallazgos abiertos.
      Verificación: `slither . --config-file slither.config.json --fail-high --fail-medium` (en `contracts/`) + `bash ci/scripts/ci-security.sh` (Semgrep Solidity) + suite adversarial.

**Commits:** `test(security): add wallet invariants and adversarial tests`, `chore(contracts): add deterministic local deploy and seed`.

#### CHECKPOINT P07

- [ ] build pasa: `forge build --sizes`.
- [ ] tests pasan: `POLICY_MODE=restricted forge test --profile ci && POLICY_MODE=bootstrap forge test --profile ci`.
- [ ] security tests pasan: `slither . --config-file slither.config.json --fail-high --fail-medium` (en `contracts/`) + `bash ci/scripts/ci-security.sh` (Semgrep Solidity) + suite adversarial.
- [ ] integración anterior sigue funcionando: `pnpm preflight && pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P08:** contratos congelados para V1 (cambios posteriores requieren re-ejecutar P07 completo).

---

### P08 — Backend I: fundaciones

**Objetivo:** proyecto `wallet/backend/app` con configuración validada, Postgres + migraciones, Valkey/BullMQ, cliente RPC de quórum, logging con redacción, métricas, health, OpenAPI/Swagger, errores RFC 9457, idempotencia, rate limiting y audit log append-only.

**Archivos/componentes:** `backend/app/package.json` + `pnpm-lock.yaml`, `tsconfig.json`, `src/config/env.ts` (Zod), `src/db/{kysely.ts,migrations/*,repositories/*}`, `src/queue/{queues.ts,outbox-dispatcher.ts}`, `src/chain/{rpc-quorum.ts,abis/*,safe-tx.ts,decoders/*}`, `src/observability/{logger.ts,redaction.ts,metrics.ts}`, `src/api/{server.ts,plugins/*,errors.ts,openapi.ts}`, `src/audit/audit-writer.ts`, `test/**`.

**Dependencias:** P07 (ABIs, vectores y deploy local).

**Implementación requerida:**

- [ ] **P08.T01** — Crear el proyecto con versiones exactas (§3.6): Fastify 5, Zod 4, `fastify-type-provider-zod`, `@fastify/swagger`, `@fastify/swagger-ui`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, Kysely + `pg`, BullMQ + `ioredis`, viem, pino, prom-client, `jose`, `@node-rs/argon2`, `@serenity-kit/opaque`, `otpauth`, `nodemailer`; dev: TypeScript 6.0.x, Vitest, Testcontainers, ESLint + typescript-eslint, Prettier. Settings de supply chain de P01.T05.
      Verificación: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint`.
- [ ] **P08.T02** — `src/config/env.ts`: schema Zod por `APP_ENV` (local/staging/production); toda variable secreta acepta también `<VAR>_FILE` (lectura del secret de Docker Compose en `/run/secrets/…`, ADR-030) y en staging/prod **exige** la forma `_FILE`; falla si detecta valores de ejemplo o secretos con baja entropía; nunca imprime valores. (El mismo patrón se replica, implementado por separado, en `backend/signer` y `backend/integrity-monitor`.)
      Verificación: tests de configuración (faltante, formato inválido, valor de ejemplo en prod → error).
- [ ] **P08.T03** — Migraciones iniciales con **todas** las tablas de [B-DB] (constraints, FKs, índices únicos parciales, CHECKs, trigger append-only de `audit_events`, roles y GRANTs). `pnpm db:migrate`, `pnpm db:status`, `pnpm db:backup`, `pnpm db:restore`.
      Verificación: test de integración que aplica migraciones sobre Postgres 18 (Testcontainers) y verifica: UPDATE/DELETE en `audit_events` falla; índice parcial impide dos operaciones activas con el mismo nonce; `wallet_keys_metadata` impide claves duplicadas.
- [ ] **P08.T04** — Repositorios con límites transaccionales explícitos (`withTransaction(fn)` con `SERIALIZABLE` donde se asignan nonces o se transicionan estados; reintento ante `40001`).
      Verificación: `pnpm --dir backend/app vitest run test/integration/repositories.test.ts` (incluye reintento ante `40001`).
- [ ] **P08.T05** — `RpcQuorumClient` [B-RPC] con health checks, lecturas en bloque común, comparación y reintentos; métricas por proveedor.
      Verificación: tests con dos Anvil (mismo fork) y con el proxy de inyección de fallas (timeouts, respuesta divergente, chainId incorrecto).
- [ ] **P08.T06** — Codificación SafeTx/EIP-712 y decoders de calldata tipificados (`src/chain/safe-tx.ts`, `src/chain/decoders/*`) validados contra `contracts/test/vectors/*.json` (copia local en `backend/app/test/vectors/`, CI verifica igualdad con la fuente).
      Verificación: `pnpm --dir backend/app vitest run test/chain/safe-tx-vectors.test.ts`.
- [ ] **P08.T07** — Logger pino con redacción [B-OBS] + tests de canario; métricas base; `/health`, `/health/live`, `/health/ready` (DB, Valkey, RPC, migraciones al día).
      Verificación: `pnpm --dir backend/app vitest run test/observability` (canarios de logs) y `curl -s localhost:8080/api/v1/health/ready`.
- [ ] **P08.T08** — Servidor Fastify con dos listeners (Wallet 8080 / Recovery 8081) y `client` derivado del listener; helmet; CORS estricto por listener (sólo el origin de su frontend, `credentials: true`); límites de body; errores RFC 9457; `requestId`.
      Verificación: `pnpm --dir backend/app vitest run test/api/server-cors.test.ts`.
- [ ] **P08.T09** — OpenAPI 3.1 generado desde schemas Zod; Swagger UI en `/docs` con comportamiento por entorno (§7.11); test que falla si una ruta no tiene schema de request/response/errores documentado.
      Verificación: `pnpm --dir backend/app vitest run test/api/openapi-coverage.test.ts` y `curl -s localhost:8080/docs/openapi.json | head -c 200`.
- [ ] **P08.T10** — Idempotencia (`Idempotency-Key`, tabla `idempotency_keys`, hash del request, respuesta repetida; conflicto si mismo key con distinto body → 422).
      Verificación: `pnpm --dir backend/app vitest run test/api/idempotency.test.ts`.
- [ ] **P08.T11** — Rate limiting [B-RL] con store Valkey y claves por IP/usuario/sesión/Safe.
      Verificación: `pnpm --dir backend/app vitest run test/api/rate-limit.test.ts`.
- [ ] **P08.T12** — Audit writer: cadena HMAC [B-AUD], `pnpm audit:verify`; outbox dispatcher [B-Q-01] con BullMQ (`jobId` = id de agregado).
      Verificación: `pnpm --dir backend/app vitest run test/audit test/queue/outbox.test.ts` y `pnpm --dir backend/app audit:verify`.

**Tests a implementar:**

- [ ] **P08.TST** — unit (config, decoders, SafeTx hash vs vectores, redacción), integración (migraciones, repositorios, outbox, RPC quórum, rate limit, idempotencia, audit chain), API (health, docs, errores).
      Verificación: `pnpm --dir backend/app test`.

**Checks manuales:**

- [ ] **P08.MAN** — abrir `http://localhost:8080/docs` y `:8081/docs`; verificar que la spec lista sólo lo correspondiente a cada listener.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** backend arranca contra compose + fork; migraciones idempotentes; outbox resiliente a flush de Valkey; audit verificable.

**Security checks:**

- [ ] **P08.SEC** — canarios de logs; `audit_events` inmodificable por `mtw_app`; CORS rechaza otros origins; ninguna ruta sin schema.
      Verificación: `pnpm --dir backend/app test:security && bash ci/scripts/ci-security.sh`.

**Commits:** `feat(backend): add service foundations, schema and observability`.

#### CHECKPOINT P08

- [ ] build pasa: `pnpm --dir backend/app build`.
- [ ] tests pasan: `pnpm --dir backend/app test`.
- [ ] security tests pasan: `pnpm --dir backend/app test:security && bash ci/scripts/ci-security.sh`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local` (incluye contratos).
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P09:** fundaciones verdes en CI.

---

### P09 — Backend II: cuenta, autenticación y email

**Objetivo:** cuenta centralizada production-grade [B-AUTH] + proveedor de email real [B-MAIL].

**Archivos/componentes:** `src/auth/{password.ts,sessions.ts,csrf.ts,totp.ts,otp.ts,risk.ts}`, `src/api/routes/v1/{auth,sessions,users}.ts`, `src/email/{provider.ts,mailgun.ts,smtp.ts,templates/*}`.

**Dependencias:** P08.

**Implementación requerida:**

- [ ] **P09.T01** — Registro + verificación de email [B-AUTH-01/02] (OTP 8 dígitos hash HMAC con `OTP_HMAC_KEY`, comparación en tiempo constante).
      Verificación: `pnpm --dir backend/app vitest run test/auth/register-verify.test.ts`.
- [ ] **P09.T02** — Login/logout/sesiones/rotación/expiración/revocación [B-AUTH-03/04/06]; listado de sesiones con dispositivo y última actividad.
      Verificación: `pnpm --dir backend/app vitest run test/auth/sessions.test.ts`.
- [ ] **P09.T03** — CSRF [B-AUTH-05] y verificación de `Origin`.
      Verificación: `pnpm --dir backend/app vitest run test/security/csrf.test.ts`.
- [ ] **P09.T04** — Forgot/reset password [B-AUTH-07]; test explícito: reset no modifica `opaque_records` ni metadatos de claves.
      Verificación: `pnpm --dir backend/app vitest run test/auth/reset-password.test.ts` (incluye el caso "reset no toca OPAQUE ni metadatos de claves").
- [ ] **P09.T05** — Brute force, lockout blando y señales de riesgo [B-AUTH-08].
      Verificación: `pnpm --dir backend/app vitest run test/security/bruteforce-totp.test.ts`.
- [ ] **P09.T06** — TOTP + códigos de recuperación [B-AUTH-09].
      Verificación: `pnpm --dir backend/app vitest run test/auth/totp.test.ts`.
- [ ] **P09.T07** — `EmailProvider` (Mailgun + SMTP/Mailpit) con outbox y reintentos; plantillas [B-MAIL-02/03] con tests de snapshot que verifican presencia de acción, dirección completa, red y expiración.
      Verificación: `pnpm --dir backend/app vitest run test/email` (snapshots de plantillas) y email visible en Mailpit (`http://localhost:8025`).
      Verificación adicional (si `EMAIL_PROVIDER_API_KEY` presente): envío real con token de servidor de staging a una casilla de prueba.

**Tests a implementar:**

- [ ] **P09.TST.a** — credenciales inválidas y enumeración de usuarios (respuesta y tiempo uniformes).
      Verificación: `pnpm --dir backend/app vitest run test/security/auth-login.test.ts`.
- [ ] **P09.TST.b** — sesión expirada (idle y absoluta), sesión revocada, logout invalida sesión y PlatformSessions.
      Verificación: `pnpm --dir backend/app vitest run test/security/sessions.test.ts`.
- [ ] **P09.TST.c** — CSRF ausente/incorrecto, `Origin` extraño, `Content-Type` no JSON.
      Verificación: `pnpm --dir backend/app vitest run test/security/csrf.test.ts`.
- [ ] **P09.TST.d** — OTP expirado, OTP reusado, OTP con > 5 intentos, token de reset reusado o reemplazado.
      Verificación: `pnpm --dir backend/app vitest run test/security/otp-reset.test.ts`.
- [ ] **P09.TST.e** — lockout blando, rate limits de login/forgot, TOTP replay y códigos de recuperación de un solo uso.
      Verificación: `pnpm --dir backend/app vitest run test/security/bruteforce-totp.test.ts`.
- [ ] **P09.TST.f** — atributos de cookies (`__Host-`, HttpOnly, Secure, SameSite=Strict, Path=/) y que la API nunca devuelve tokens de sesión en el body.
      Verificación: `pnpm --dir backend/app vitest run test/security/cookies.test.ts`.
- [ ] **P09.TST.g** — adaptador `mailgun` contra la **API real de Mailgun** con el dominio sandbox: cada plantilla se envía a la casilla autorizada `EMAIL_TEST_ADDRESS` y el test confirma el evento `delivered` en la Events API.
      Verificación: `pnpm --dir backend/app vitest run test/email/mailgun.live.test.ts`.
- [ ] **P09.TST.h** — entrega real de punta a punta: la verificación de email, los OTP y el reset de password salen por Mailgun (dominio sandbox, remitente `no-reply@<EMAIL_PROVIDER_DOMAIN>`) hacia la casilla real `EMAIL_TEST_ADDRESS`, y el test lee cada código con la **Gmail API** (OAuth 2.0, scope `gmail.readonly`: `users.messages.list` con una consulta que incluye un identificador único del envío e `includeSpamTrash=true` —el dominio sandbox compartido suele caer en spam—, y `users.messages.get`) y completa el flujo; sin mocks y sin tokens en logs.
      Verificación: `pnpm --dir backend/app vitest run test/email/real-delivery.live.test.ts`.

**Checks manuales:**

- [ ] **P09.MAN** — recorrer el flujo en Mailpit (`http://localhost:8025`) y revisar textos de emails.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** todos los flujos de cuenta del prompt §7 funcionan contra API real; tests de seguridad verdes.

**Security checks:**

- [ ] **P09.SEC** — no se guardan tokens en localStorage (no aplica en backend, pero la API no devuelve tokens de sesión en el body); hashes con pepper; tiempos uniformes.
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(auth): add account and session management`, `feat(backend): add transactional email provider`.

#### CHECKPOINT P09

- [ ] build pasa: `pnpm --dir backend/app build`.
- [ ] tests pasan: `pnpm --dir backend/app test`.
- [ ] security tests pasan: `pnpm --dir backend/app test:security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` + OpenAPI de auth en `/docs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P10:** suite de seguridad de autenticación verde.

---

### P10 — Backend III: PlatformSession

**Objetivo:** [B-PSES] completo: OPAQUE con AuthSecret_U, step-up, tokens EdDSA, session keys y requests críticos firmados.

**Archivos/componentes:** `src/platform-session/{opaque.ts,step-up.ts,token.ts,request-signature.ts,plugin.ts}`, rutas `/platform-sessions/*`, script `opaque:setup`, `dev:session`.

**Dependencias:** P09.

**Implementación requerida:**

- [ ] **P10.T01** — `pnpm --dir backend/app opaque:setup` genera `OPAQUE_SERVER_SETUP` (sólo local; en staging/prod se genera una vez con `scripts/deploy/init-secrets.sh` y se monta como Docker Compose secret, ADR-030). PF-29 pasa a obligatorio.
      Verificación: PF-29 en verde (`pnpm preflight`).
- [ ] **P10.T02** — Registro OPAQUE ligado a `wallet_id` + `key_version` (estado PENDING hasta que U se confirma on-chain como owner; ACTIVE después).
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/opaque-registration.test.ts`.
- [ ] **P10.T03** — Login OPAQUE (estado de servidor en Valkey con TTL 60 s, un solo uso) + binding de `sessionPublicKey` [B-PSES-02] → PlatformSession `OPERATIONS`.
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/opaque-login.test.ts`.
- [ ] **P10.T04** — Step-up [B-PSES-03] → scopes restringidos.
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/step-up.test.ts`.
- [ ] **P10.T05** — Token JWS EdDSA [B-PSES-04] + plugin Fastify que valida token, revocación, sesión de cuenta padre, scope por ruta.
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/token-scopes.test.ts`.
- [ ] **P10.T06** — Firma de requests críticos y anti-replay [B-PSES-05]; verificación de envelope de envío [B-PSES-06] (librería reutilizada por el worker; el signer tiene su propia implementación en P11).
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/request-signature.test.ts`.
- [ ] **P10.T07** — `dev:session` (sólo `APP_ENV=local`): realiza login de cuenta + OPAQUE de un usuario de prueba con su Password U y emite el material para Swagger; no existe endpoint equivalente.
      Verificación: `APP_ENV=local pnpm --dir backend/app dev:session` emite material y con `APP_ENV=staging` se niega; check manual en Swagger.

**Tests a implementar:**

- [ ] **P10.TST** — OPAQUE ida y vuelta; password U incorrecta → falla sin filtrar información; token expirado/revocado; scope incorrecto (step-up intentando operar); firma de request inválida, timestamp fuera de ventana, nonce repetido; logout revoca PlatformSessions; reset de password revoca PlatformSessions.
      Verificación: `pnpm --dir backend/app test`.

**Checks manuales:**

- [ ] **P10.MAN** — Swagger "Try it out" de un endpoint crítico con el material de `dev:session`.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** ninguna ruta crítica acepta requests sin PlatformSession válida y firma correcta.

**Security checks:**

- [ ] **P10.SEC** — el servidor nunca recibe Password U ni AuthSecret_U (inspección de payloads en tests); `OPAQUE_SERVER_SETUP` sólo desde env/Docker Compose secret (`*_FILE`).
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(auth): add opaque-based platform sessions and signed critical requests`.

#### CHECKPOINT P10

- [ ] build pasa: `pnpm --dir backend/app build`.
- [ ] tests pasan: `pnpm --dir backend/app test`.
- [ ] security tests pasan: `pnpm --dir backend/app test:security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P11:** PlatformSession end-to-end verde.

---

### P11 — Signer S

**Objetivo:** signer **self-hosted** independiente por shard [B-SIG] con `SignerProvider` (development, selfhosted, hardware futuro), ciclo de vida completo de keystores [B-SIG-08], sharding [B-SIG-09], política propia basada en snapshot firmado, estado propio, mTLS y gas tank/relayer.

**Archivos/componentes:** `wallet/backend/signer/` (proyecto propio): `src/server.ts` (HTTPS mTLS), `src/policy/*` (implementación **independiente**), `src/chain/*` (RPC propio de quórum, SafeTx), `src/state/*` (PostgreSQL propio del signer, migraciones propias), `src/providers/{SignerProvider.ts,SelfHostedSoftwareSignerProvider.ts,DevelopmentSignerProvider.ts,HardwareSignerProvider.ts}`, `src/keystore/{v3.ts,derive-password.ts,atomic-write.ts,fingerprint.ts}`, `scripts/{create-shard.ts,restore-verify.ts,rotate-unlock-credential.ts,shard-migrate.ts}`; `wallet/config/policy/<env>/policy-snapshot.json(.sig)`; en `backend/app`: `src/signer-client/*`, `src/gas/*`.

**Dependencias:** P10.

**Implementación requerida:**

- [ ] **P11.T01** — Interfaz `SignerProvider` [B-SIG-04] y `DevelopmentSignerProvider` = `SelfHostedSoftwareSignerProvider` con guardas: **se niega a arrancar** si `APP_ENV != local` o si el RPC no es un fork Anvil (`anvil_nodeInfo.forkConfig` presente); keystores en `wallet/.secrets/signer/dev-1/keystore/` y credencial en `wallet/.secrets/signer/dev-1/unlock.key` (generada por `secrets:local`, fuera del directorio de keystores). Nunca escribe claves en DB, `.env`, logs, código ni respuestas de API.
      Verificación: `pnpm --dir backend/signer vitest run test/providers/development.test.ts` (incluye negativa fuera de Anvil).
- [ ] **P11.T02** — Servidor mTLS [B-SIG-01]; `POST /v1/sign-safe-tx` [B-SIG-02], `POST /v1/keys` (crear S para un wallet), `GET /v1/health`. Cliente mTLS en `backend/app/src/signer-client`.
      Verificación: `pnpm --dir backend/signer vitest run test/server-mtls.test.ts`.
- [ ] **P11.T03** — Política independiente del signer: decodificación desde bytes de SafeTx, tabla de operaciones por rol y scope [B-POL-03]/[W-07], límites y ledger 24 h, verificación de PlatformSession token (clave pública del emisor fijada) con validez al momento del envío y antigüedad ≤ 24 h [B-PSES-06], envelope de envío, atestación de challenge (whitelist/2FA), lectura on-chain con su RPC (nonce, roles del Guard, **configuración de la Safe — paso 7b de [B-Q-02]**, whitelist activa, saldo, rotaciones), simulación `eth_call`, regla "una SafeTx activa por (safe, nonce)" [B-SIG-03], rotación de S sólo hacia claves propias, `KeyAcceptance` para U'/R', emparejamiento approve/swap, pausa por integridad (atestación vigente requerida cuando `INTEGRITY_REQUIRED=true`).
      Verificación: `pnpm --dir backend/signer vitest run test/policy` (tabla completa de rechazos) y vectores compartidos.
- [ ] **P11.T04** — Snapshot de policy firmado [B-POL-01]: `config/policy/local/policy-snapshot.json` (los de staging/production se generan en P25.T07, cuando existen sus direcciones); herramienta `pnpm --dir backend/signer policy:sign` (sólo con clave local de dev; en staging/producción, durante la ejecución, firma con la clave de policy de cada entorno generada en `~/.config/mtw/secrets/<entorno>/` (fuera del repo); en el despliegue final se re-firma offline) y `policy:verify`; anti-rollback.
      Verificación: `pnpm --dir backend/signer policy:verify config/policy/local/policy-snapshot.json` y test de anti-rollback.
- [ ] **P11.T05** — Reglas estáticas restrictivas [B-SIG-06] evaluadas antes de cualquier I/O: typed data `SafeTx` con `chainId == 8453`, `operation == 0`, gas params en cero, `to`/selector dentro de la allowlist del sistema; tx a firmar por la clave S con `to == Safe asociada`, selector `execTransaction`, `value == 0`, tope de gas/fees; para la cuenta gas tank sólo transferencias de ETH a S registradas (≤ tope), `WalletFactory.createWallet` y `RotationTimelock.cancelWithSignature`. Tabla de casos de rechazo en tests.
      Verificación: `pnpm --dir backend/signer vitest run test/policy/static-rules.test.ts`.
- [ ] **P11.T06** — `SelfHostedSoftwareSignerProvider` [B-SIG-08] (producción/staging): create, load, unlock y restart con keystores Ethereum V3 (scrypt de `@noble/hashes`, AES-128-CTR de `node:crypto`, MAC keccak), contraseñas derivadas por HKDF de la credencial del shard leída de `SIGNER_UNLOCK_CREDENTIAL_FILE` (secret de Compose), escritura atómica, `credentialFingerprint`, firma con `@noble/curves` (low-s, RFC 6979) y cálculo de `v`. Interoperabilidad: tests que descifran los keystores generados con `cast wallet decrypt-keystore` del Foundry fijado y que verifican vectores oficiales del formato V3.
      Verificación: `pnpm --dir backend/signer vitest run test/providers/selfhosted.test.ts test/keystore` (incluye interop con `cast`).
- [ ] **P11.T07** — `HardwareSignerProvider` (futuro opcional, HSM físico propio vía PKCS#11/YubiHSM): interfaz, suite de contrato común (la misma que corren los otros providers) y runbook `docs/runbooks/signer-hardware-migration.md` (migración Safe por Safe rotando S por el timelock); **no se implementa contra hardware en V1**. Documentar en ADR-014 la evaluación de Clef y Web3Signer (§3.5).
      Verificación: `pnpm --dir backend/signer vitest run test/providers/contract-suite.test.ts` (corre contra Development y SelfHosted) y runbook presente (`node scripts/check-docs.mjs`).
- [ ] **P11.T08** — Sharding [B-SIG-09]: asignación de wallet a shard por hash estable de `walletId` sobre los shards activos al crearla, **guardada** (no se recalcula); registro en `signer_keys`; un shard `dev-1` en local; el software y los tests soportan N shards (dos shards locales en los tests de integración), aunque en producción inicialmente compartan host físico.
      Verificación: `pnpm --dir backend/app vitest run test/signer-client/sharding.test.ts` y `pnpm --dir backend/signer vitest run test/multi-shard.test.ts`.
- [ ] **P11.T09** — Gas tank/relayer [B-SIG-05]: job de recarga (mín./objetivo/tope diario), retransmisión de cancelaciones firmadas, deploy de Safes; métricas de saldos.
      Verificación: `pnpm --dir backend/app vitest run test/gas/gas-tank.test.ts` contra el fork.
- [ ] **P11.T10** — Procedimientos del ciclo de vida [B-SIG-08] como scripts + runbooks (`docs/runbooks/signer-lifecycle.md`), cada uno con test que lo ejecuta en local: backup cifrado con `age` (sin la credencial), restore + `restore-verify`, rotación de la credencial del shard (re-cifrado de todos los keystores), keystore corrupto o faltante (`BROKEN` + restore), migración de wallets entre shards (dos fases), y custodia offline de la credencial de desbloqueo (dos copias selladas, custodios distintos).
      Verificación: `pnpm --dir backend/signer vitest run test/lifecycle` (cada procedimiento ejecutado de punta a punta sobre un shard de prueba).
- [ ] **P11.T11** — `SignerKeyAttestation` [B-SIG-07]/[W-03]: clave de atestación Ed25519 del signer por entorno (pública exportada para los frontends), emitida en `POST /v1/keys`.
      Verificación: `pnpm --dir backend/signer vitest run test/attestation.test.ts`.

**Tests a implementar:**

- [ ] **P11.TST** — unit de política del signer contra vectores compartidos (mismo resultado que backend para cada caso), integración backend↔signer por mTLS (cert inválido → rechazo), firma S nunca emitida si cualquier check falla (tabla de casos: firma U inválida, sesión vencida, envelope ausente, nonce on-chain distinto, whitelist inactiva, saldo insuficiente, simulación revierte, policy snapshot inválido o con versión menor, pausa de integridad, regla estática violada), regla (safe, nonce), ledger diario, dev signer se niega fuera de Anvil, suite de contrato común a todos los `SignerProvider` (firma recuperable a la dirección, low-s, `v` correcto).
      Verificación: `pnpm --dir backend/signer test && pnpm --dir backend/app test`.

**Checks manuales:**

- [ ] **P11.MAN** — inspeccionar que ningún log del signer contiene material sensible; revisar la tabla de reglas estáticas línea por línea; revisar permisos de archivos del volumen de keystores y del secret de desbloqueo.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** el worker puede obtener firmas S sólo para operaciones válidas; las reglas estáticas rechazan por sí mismas cualquier operación fuera de la allowlist aunque el backend la pida.

**Security checks:**

- [ ] **P11.SEC** — S nunca en DB, Valkey, `.env`, logs, código ni API; keystores 0400 del UID del signer; credencial de desbloqueo en un secret separado de los keystores; mTLS obligatorio; signer sin puertos publicados y sólo en la red interna `signer`.
      Verificación: `pnpm --dir backend/signer test:security && bash ci/scripts/ci-security.sh`.

**Commits:** `feat(signer): add self-hosted signer service with encrypted keystores`, `feat(signer): add signed policy snapshots and gas tank`.

#### CHECKPOINT P11

- [ ] build pasa: `pnpm --dir backend/signer build && pnpm --dir backend/app build`.
- [ ] tests pasan: `pnpm --dir backend/signer test && pnpm --dir backend/app test`.
- [ ] security tests pasan: `pnpm --dir backend/signer test:security && bash ci/scripts/ci-security.sh`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (runbooks del signer).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P12:** suite de rechazo del signer completa y verde.

---

### P12 — Backend IV: creación de wallet

**Objetivo:** onboarding server-side completo (V9 §6 y §16): registro de U, enrollment de R, incorporación firmada por U, asignación de S, cálculo de dirección, deploy atómico, verificación y estados CREATING → DEPLOYING → VERIFYING → ACTIVE.

**Archivos/componentes:** `src/wallets/*`, `src/recovery/enrollment.ts`, rutas `wallet` y `recovery`.

**Dependencias:** P11.

**Implementación requerida:**

- [ ] **P12.T01** — Con PlatformSession `ONBOARDING` (step-up, [B-PSES-03]): `POST /wallets` crea `wallets` (CREATING, `walletId`); `POST /wallets/{id}/user-key` registra dirección U, metadata pública KDF, flags de backup (debe existir ≥ 1 método persistente confirmado) y registro OPAQUE PENDING (pasa a ACTIVE en P12.T07).
      Verificación: `pnpm --dir backend/app vitest run test/wallets/create-user-key.test.ts`.
- [ ] **P12.T02** — Enrollment de R: `POST /wallets/{id}/recovery/enrollments` (Wallet; nonce 128 bits, TTL 15 min) → `POST /recovery/enrollments/{id}/enrollment-key` (Recovery, PlatformSession ENROLLMENT; registra JWK P-256) → `POST /recovery/enrollments/{id}/submit` con `RecoveryEnrollment {userId, platformId, R, nonce, issuedAt, expiresAt}` firmado por la Enrollment Key + proof-of-control EIP-712 de R. Validaciones: firma, nonce, expiración, R ≠ U, R no usada por otra wallet, R es EOA (código vacío o designador EIP-7702), cadena correcta.
      Verificación: `pnpm --dir backend/app vitest run test/recovery/enrollment.test.ts`.
- [ ] **P12.T03** — Asignación de S tras el enrollment de R: el backend pide `POST /v1/keys` al shard asignado; guarda `signer_keys` y la `SignerKeyAttestation` [B-SIG-07].
      Verificación: `pnpm --dir backend/app vitest run test/wallets/assign-executor.test.ts`.
- [ ] **P12.T04** — Dirección esperada: `saltNonce = uint256(keccak256(abi.encode("MTW_SALT_V1", platformId, walletId)))`; cálculo local (TS) y `WalletFactory.predictWalletAddress` (eth_call) deben coincidir; se persiste `config_hash` (hash del initializer).
      Verificación: `pnpm --dir backend/app vitest run test/wallets/predict-address.test.ts` (TS vs `predictWalletAddress` en el fork).
- [ ] **P12.T05** — `POST /recovery/enrollments/{id}/incorporate` (Wallet): firma EIP-712 de U `WalletCreationAuthorization {userId, platformId, walletId, U, R, S, saltNonce, expectedSafe, enrollmentNonce}` [W-01] después de que la Wallet verificó la atestación de S y recalculó la dirección; el backend acepta sólo si R coincide exactamente con el del enrollment y S/salt/dirección con los asignados.
      Verificación: `pnpm --dir backend/app vitest run test/recovery/creation-authorization.test.ts`.
- [ ] **P12.T06** — `POST /wallets/{id}/deploy` (crítico): gas tank fondea S (monto inicial de policy) y envía `WalletFactory.createWallet(U, R, S, saltNonce)` → DEPLOYING; receipt → VERIFYING.
      Verificación: `pnpm --dir backend/app vitest run test/wallets/deploy.test.ts` contra el fork.
- [ ] **P12.T07** — Verificación post-deploy por lectura directa on-chain (quórum) de **todos** los ítems de V9 §16 [C-FAC-05]; sólo si todo coincide → ACTIVE; si no → FAILED + alerta (la Safe nunca se presenta como operativa). OPAQUE PENDING → ACTIVE al quedar ACTIVE la wallet.
      Verificación: `pnpm --dir backend/app vitest run test/wallets/verify-active.test.ts` (incluye Safe con config alterada → nunca ACTIVE).
- [ ] **P12.T08** — `GET /wallets/{id}/deployment` devuelve los datos que el frontend necesita para su verificación independiente (U, R, S, salt, factory, singleton, direcciones del sistema, expected address).
      Verificación: `pnpm --dir backend/app vitest run test/api/deployment-info.test.ts`.

**Tests a implementar:**

- [ ] **P12.TST** — integración sobre el fork con signer dev: onboarding completo hasta ACTIVE; enrollment con R distinto en firma de U → rechazo; R reutilizada → rechazo; enrollment expirado; Safe pre-desplegada por un tercero con mismo initializer → idempotente (registro); verificación falla si se altera cualquier ítem (usando una Safe creada fuera de la factory con otra config) → nunca ACTIVE.
      Verificación: `pnpm --dir backend/app test`.

**Checks manuales:**

- [ ] **P12.MAN** — inspeccionar en el fork la Safe creada (`cast call` de owners/threshold/guard).
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** A11 cubierto server-side; onboarding reproducible.

**Security checks:**

- [ ] **P12.SEC** — el backend no aporta calldata arbitraria a la factory; sólo (U, R, S, salt).
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(wallet): add deterministic safe deployment`, `feat(recovery): add recovery key enrollment`.

#### CHECKPOINT P12

- [ ] build pasa: `pnpm --dir backend/app build`.
- [ ] tests pasan: `pnpm --dir backend/app test`.
- [ ] security tests pasan: `pnpm --dir backend/app test:security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P13:** wallet ACTIVE end-to-end en el fork por API.

---

### P13 — Backend V: pipeline de operaciones

**Objetivo:** [B-SM], [B-NONCE], [B-Q], [B-FIN] completos, más indexer de transfers y reconciliación.

**Archivos/componentes:** `src/operations/{state-machine.ts,service.ts,nonce-manager.ts}`, `src/worker/{main.ts,pipeline.ts,lease.ts}`, `src/chain/{watcher.ts,reconciler.ts,indexer.ts}`, rutas `operations`.

**Dependencias:** P12.

**Implementación requerida:**

- [ ] **P13.T01** — Máquina de estados y `transitionOperation` [B-SM-01..03] con tabla de transiciones permitidas testeada exhaustivamente.
      Verificación: `pnpm --dir backend/app vitest run test/operations/state-machine.test.ts` (todas las transiciones permitidas y prohibidas).
- [ ] **P13.T02** — Nonce manager [B-NONCE-01..03] con lock de fila y lease con fencing [B-NONCE-04].
      Verificación: `pnpm --dir backend/app vitest run test/integration/nonce-race.test.ts test/integration/two-workers.test.ts`.
- [ ] **P13.T03** — `POST /operations/{id}/signatures` (crítico): verifica firma (ECDSA estricta) contra rol on-chain, envelope de envío, recalcula SafeTxHash, policy, 2FA si corresponde → USER_SIGNED → outbox.
      Verificación: `pnpm --dir backend/app vitest run test/operations/submit-signature.test.ts`.
- [ ] **P13.T04** — Worker con el pipeline de 12 pasos [B-Q-02], reintentos [B-Q-03], recuperación tras crash [B-Q-04], concurrencia entre Safes.
      Verificación: `pnpm --dir backend/app vitest run test/worker/pipeline.test.ts` contra el fork y el signer dev.
- [ ] **P13.T05** — Gestión de tx de S: fees EIP-1559 con topes de policy, reemplazo por fee bump, `chain_transactions` [B-NONCE-05].
      Verificación: `pnpm --dir backend/app vitest run test/worker/fees-replacement.test.ts`.
- [ ] **P13.T06** — Watcher de finalidad y reorgs [B-FIN-01/02] (parámetros de ADR-018; en local `depth`).
      Verificación: `pnpm --dir backend/app vitest run test/resilience/reorg.test.ts`.
- [ ] **P13.T07** — Reconciliador [B-FIN-03] + indexado de transacciones soberanas (eventos SafeL2) + indexer de `Transfer` de USDC/USDT hacia/desde Safes (`token_transfers`, con confirmaciones y reorg).
      Verificación: `pnpm --dir backend/app vitest run test/chain/reconciler-indexer.test.ts`.
- [ ] **P13.T08** — Cancelación por NoOp con estado `CANCEL_REQUESTED` y reemplazo de la tx en vuelo [B-NONCE-06].
      Verificación: `pnpm --dir backend/app vitest run test/integration/cancel-session-destination.test.ts`.
- [ ] **P13.T09** — Decisión de batching documentada (ADR-019) + test que demuestra que el worker procesa Safes distintas en paralelo y una Safe en orden.
      Verificación: `pnpm --dir backend/app vitest run test/worker/parallelism.test.ts`.
- [ ] **P13.T10** — Policy del backend [B-POL-05] en `backend/app/src/policy/`: verificación del snapshot firmado y anti-rollback, tabla de operaciones por rol, límites por operación, ledger 24 h por Safe, umbral de 2FA y validación de destinos; usada por `prepare` y por el paso 6 del worker. Implementación independiente de la del signer, contrastada con los mismos vectores.
      Verificación: `pnpm --dir backend/app vitest run test/policy`.
- [ ] **P13.T11** — Chequeo de configuración de la Safe antes de co-firmar (paso 7b de [B-Q-02]) en backend y signer, y estado `SOVEREIGN_MODIFIED` con alerta y aviso al usuario.
      Verificación: `pnpm --dir backend/app vitest run test/integration/config-drift.test.ts` (P13.TST.k).

**Tests a implementar:**

- [ ] **P13.TST** — (prompt §29)
      Verificación: `pnpm --dir backend/app test` (incluye `test/resilience`).

- [ ] **P13.TST.a** — requests duplicados e idempotencia (`Idempotency-Key` repetido, mismo body / distinto body).
      Verificación: `pnpm --dir backend/app vitest run test/integration/idempotency.test.ts`.
- [ ] **P13.TST.b** — carrera de nonces: N `prepare` concurrentes → nonces únicos y consecutivos; liberación por expiración.
      Verificación: `pnpm --dir backend/app vitest run test/integration/nonce-race.test.ts`.
- [ ] **P13.TST.c** — dos workers sobre la misma operación: sólo el dueño del lease transmite (fencing).
      Verificación: `pnpm --dir backend/app vitest run test/integration/two-workers.test.ts`.
- [ ] **P13.TST.d** — timeout de RPC y desacuerdo de RPC (sin transición hasta consistencia) con el proxy de fallas.
      Verificación: `pnpm --dir backend/app vitest run test/resilience/rpc-faults.test.ts`.
- [ ] **P13.TST.e** — transacción fallida (dropped), revertida por el Guard (receipt status 0, [B-SM-04]) y simulación que revierte (nunca se transmite).
      Verificación: `pnpm --dir backend/app vitest run test/integration/failed-reverted.test.ts`.
- [ ] **P13.TST.f** — reorg con `anvil_reorg`: MINED → REORGED → re-ejecución de la misma SafeTx; CONFIRMED → FINALIZED.
      Verificación: `pnpm --dir backend/app vitest run test/resilience/reorg.test.ts`.
- [ ] **P13.TST.g** — retry de cola, crash del proceso en cada paso del pipeline (kill -9 y reinicio) y reinicio del backend.
      Verificación: `pnpm --dir backend/app vitest run test/resilience/crash-restart.test.ts`.
- [ ] **P13.TST.h** — flush de Valkey: el outbox re-encola sin pérdida ni duplicados.
      Verificación: `pnpm --dir backend/app vitest run test/resilience/valkey-flush.test.ts`.
- [ ] **P13.TST.i** — cancelación NoOp ganando y perdiendo la carrera (original en QUEUED y en SUBMITTED); sesión expirada al enviar firma; ejecución legítima > 15 min después de firmar (OK) y > 24 h (SIGNATURE_STALE); destino no autorizado en el paso 7.
      Verificación: `pnpm --dir backend/app vitest run test/integration/cancel-session-destination.test.ts`.
- [ ] **P13.TST.j** — policy del backend (P13.T10) contra los vectores compartidos: mismo veredicto que el signer en cada caso.
      Verificación: `pnpm --dir backend/app vitest run test/policy/vectors.test.ts`.
- [ ] **P13.TST.k** — U+R retiran el Guard (o cambian module guard/fallback) soberanamente en el fork → backend y signer se niegan a co-firmar y la wallet queda `SOVEREIGN_MODIFIED`.
      Verificación: `pnpm --dir backend/app vitest run test/integration/config-drift.test.ts`.

**Checks manuales:**

- [ ] **P13.MAN** — observar en métricas la evolución de estados de una operación en el fork.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** ninguna doble ejecución ni nonce duplicado bajo concurrencia; reorgs y crashes recuperados sin intervención.

**Security checks:**

- [ ] **P13.SEC** — S sólo firma vía signer tras checks; ninguna transición sin auditoría.
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(backend): add operation pipeline with nonce management and finality tracking`.

#### CHECKPOINT P13

- [ ] build pasa: `pnpm --dir backend/app build`.
- [ ] tests pasan: `pnpm --dir backend/app test` (incluye `test/resilience`).
- [ ] security tests pasan: `pnpm --dir backend/app test:security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (diagrama de estados).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P14:** suite de concurrencia/resiliencia verde 3 corridas consecutivas.

---

### P14 — Backend VI: whitelist, send y swap

**Objetivo:** operaciones de usuario V1 con validación doble (backend + signer) y enforcement on-chain.

**Archivos/componentes:** `src/whitelist/*`, `src/send/*`, `src/swap/{quote.ts,prepare.ts}`, rutas correspondientes.

**Dependencias:** P13.

**Implementación requerida:**

- [ ] **P14.T01** — Whitelist (prompt §10): request → challenge ligado a `{userId, safe, chainId, destination, action, nonce, expiresAt}` (single-use, expirable, auditable, idempotente) → email [B-MAIL-02] → confirmación con código → atestación `ChallengeCompletion` firmada por el emisor de sesiones (la verifica el signer) → SafeTx `addDestination(dest)` firmada por U → ejecución → `ACTIVATING` → `ACTIVE` cuando `isWhitelisted` es true on-chain (24 h). Baja: `removeDestination` (U o R) inmediata.
      Verificación: `pnpm --dir backend/app vitest run test/integration/whitelist-challenge.test.ts`.
- [ ] **P14.T02** — Validaciones de destino: EIP-55, ≠ Safe, ≠ contratos del sistema, ≠ dirección cero, ≠ tokens; no duplicado.
      Verificación: `pnpm --dir backend/app vitest run test/whitelist/destination-validation.test.ts`.
- [ ] **P14.T03** — Send: `prepare` reconstruye SafeTx `token.transfer(dest, amount)`; valida policy, whitelist ACTIVE (quórum on-chain), saldo (quórum), nonce; 2FA si `amount ≥ umbral` (challenge ligado a SafeTxHash, token, monto, destino, nonce).
      Verificación: `pnpm --dir backend/app vitest run test/integration/send.test.ts`.
- [ ] **P14.T04** — Swap quote: QuoterV2 (`eth_call`) sobre el pool canónico fijado; devuelve `expectedOut`, `minOut` según slippage (≤ 50 bps), impacto de precio, `deadline` (now + 10 min).
      Verificación: `pnpm --dir backend/app vitest run test/swap/quote.test.ts` contra el fork.
- [ ] **P14.T05** — Swap prepare: grupo de 2 operaciones (`SWAP_APPROVE` nonce N con `approve(SwapExecutor, amountIn)` exacto; `SWAP` nonce N+1), enviadas juntas al signer para el chequeo de secuencia [B-SIG-02]; si la ejecución del swap falla en forma final, el backend ofrece re-cotizar (nueva SafeTx N+1) o `APPROVE_REVOKE`. Job de limpieza: allowances residuales detectadas → notificación al usuario.
      Verificación: `pnpm --dir backend/app vitest run test/integration/swap.test.ts`.
- [ ] **P14.T06** — Endpoints de lectura: whitelist, operaciones del grupo, balances.
      Verificación: `pnpm --dir backend/app vitest run test/api/read-endpoints.test.ts` (incluye IDOR de [B-AUTHZ]).

**Tests a implementar:**

- [ ] **P14.TST.a** — destino no whitelisteado en **tres capas**: API manipulada → rechazo del backend; SafeTx enviada directo al signer → rechazo del signer; ejecución directa con firmas válidas U+S en el fork → revert del Guard (A9).
      Verificación: `pnpm --dir backend/app vitest run test/security/whitelist-three-layers.test.ts`.
- [ ] **P14.TST.b** — challenge expirado, reusado o con otra dirección; whitelist en ACTIVATING no usable; idempotencia del request.
      Verificación: `pnpm --dir backend/app vitest run test/integration/whitelist-challenge.test.ts`.
- [ ] **P14.TST.c** — send real de USDC y USDT a destino activo con saldos verificados; 2FA exigido sobre el umbral.
      Verificación: `pnpm --dir backend/app vitest run test/integration/send.test.ts`.
- [ ] **P14.TST.d** — swap USDC→USDT y USDT→USDC reales contra el pool del fork, allowance final 0, minOut bajo el piso → revert, token arbitrario → rechazo/revert, fallo final del swap → re-cotización o revocación.
      Verificación: `pnpm --dir backend/app vitest run test/integration/swap.test.ts`.

**Checks manuales:**

- [ ] **P14.MAN** — email de whitelist en Mailpit muestra acción, dirección, red y expiración.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** send y swap funcionan con tokens y pool reales del fork; toda vía de bypass termina en rechazo o revert.

**Security checks:**

- [ ] **P14.SEC** — A4, A9, A10, A15, A16, A18 cubiertos por tests en tres capas.
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(policy): add destination whitelist enforcement`, `feat(wallet): add whitelisted sends`, `feat(swap): add restricted usdc usdt swaps`.

#### CHECKPOINT P14

- [ ] build pasa: `pnpm --dir backend/app build`.
- [ ] tests pasan: `pnpm --dir backend/app test`.
- [ ] security tests pasan: `pnpm --dir backend/app test:security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P15:** bypass tests en tres capas verdes.

---

### P15 — Backend VII: rotaciones, recovery, migración excepcional, notificaciones

**Objetivo:** V9 §14 completo.

**Archivos/componentes:** `src/rotations/*`, `src/recovery/{u-replacement.ts,migration.ts}`, `src/notifications/*`, CLI de operadores `src/operators/cli.ts`.

**Dependencias:** P14.

**Implementación requerida:**

- [ ] **P15.T01** — Propuesta asistida: `POST /wallets/{id}/rotations` para rol U (X = R; requiere U' registrado con OPAQUE PENDING), R (X = U; requiere R' enrollado) o S (X = U o R; S' asignado por shard) → SafeTx `RotationTimelock.propose(role, old, new)` → ejecución → `PENDING_TIMELOCK` con `executable_at` leído on-chain; email + notificación in-app.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-propose.test.ts`.
- [ ] **P15.T02** — Cancelación individual: `POST /rotations/{id}/cancel` **sin autenticación** recibe la firma EIP-712 `CancelRotation` de U **o** R, verifica firma y propuesta pendiente on-chain y la retransmite vía gas tank (`cancelWithSignature`), con rate limit propio por propuesta [B-RL]; además la firma exportada se puede transmitir por cualquier relayer o por Recovery con wallet externa (procedimiento documentado). Estado CANCELLED al confirmarse.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-cancel.test.ts`.
- [ ] **P15.T03** — Ejecución: al madurar, `POST /rotations/{id}/execute/prepare` prepara `swapOwner(prev, old, new)` (prev calculado on-chain); firma de U o R; ejecución por S vigente; roles actualizados on-chain (`RoleRotated`); efectos: U' → OPAQUE ACTIVE y retiro del registro viejo; R' → recovery_metadata; S' → signer_keys ACTIVE, S anterior RETIRED.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-execute.test.ts`.
- [ ] **P15.T04** — Flujo "perdí U / Password U" (V9 §14) orquestado: step-up → U_REPLACEMENT → registro U' → propuesta firmada por R desde Recovery → 48 h → ejecución firmada por R.
      Verificación: `pnpm --dir backend/app vitest run test/integration/recovery-flows.test.ts` (caso U perdida).
- [ ] **P15.T05** — Flujo "perdí R": step-up/OPERATIONS → enrollment R' → U propone → 48 h → U ejecuta.
      Verificación: `pnpm --dir backend/app vitest run test/integration/recovery-flows.test.ts` (caso R perdida).
- [ ] **P15.T06** — Migración excepcional (credencial comprometida que veta): caso de operador con doble aprobación (`operator_actions`, dos operadores distintos con TOTP), wallet vieja → `MIGRATING`, creación de la Safe nueva con `migrated_from_wallet_id` (por la factory, con la credencial sana como owner), propuesta on-chain de autorización de migración en `PolicyRegistry` por la Governance Safe (24 h, guardianes pueden cancelar), `MIGRATION_TRANSFER` (saldo completo, exento del límite de 24 h) firmado por la credencial sana + S, wallet vieja → `MIGRATED`. Runbook `docs/runbooks/exceptional-migration.md`.
      Verificación: `pnpm --dir backend/app vitest run test/integration/migration.test.ts`.
- [ ] **P15.T07** — Notificaciones (email + in-app) para todos los eventos de [B-MAIL-03]; el watcher detecta propuestas de rotación on-chain **no originadas por el backend** y notifica igual.
      Verificación: `pnpm --dir backend/app vitest run test/notifications` (incluye propuesta on-chain no originada por el backend).
- [ ] **P15.T08** — Upgrade del Guard [C-GRD-17]: operación `GUARD_UPGRADE` (propuesta en el timelock, notificación, 48 h, ejecución con firma U + S), habilitada sólo si hay sucesor activo en `PolicyRegistry`.
      Verificación: `pnpm --dir backend/app vitest run test/integration/guard-upgrade.test.ts` (con un Guard sucesor de prueba desplegado en el fork).
- [ ] **P15.T09** — Pérdida de una clave S: runbook `docs/runbooks/executor-key-loss.md` (U+R reemplazan S soberanamente desde Recovery `/sovereign` + `updateRoles` + alta de la nueva S en el signer) y test en el fork del procedimiento completo.
      Verificación: `pnpm --dir backend/app vitest run test/integration/executor-key-loss.test.ts`.

**Tests a implementar:**

- [ ] **P15.TST.a** — propuesta → cancelación por U (firma) → ejecución imposible; propuesta → cancelación por R; cancelación transmitida por un relayer ajeno al backend.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-cancel.test.ts`.
- [ ] **P15.TST.b** — ejecución antes de 48 h → revert; con old ≠ rol actual → revert; R+S proponiendo rol R → revert.
      Verificación: `pnpm --dir backend/app vitest run test/security/rotation-bypass.test.ts`.
- [ ] **P15.TST.c** — recovery completo de U en el fork (warp 48 h) y flujo de R perdida.
      Verificación: `pnpm --dir backend/app vitest run test/integration/recovery-flows.test.ts`.
- [ ] **P15.TST.d** — rotación de S y continuidad de operaciones con S'.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-s.test.ts`.
- [ ] **P15.TST.e** — migración excepcional: sin autorización → revert; con autorización madura → OK sólo hacia la Safe autorizada; doble aprobación de operadores obligatoria.
      Verificación: `pnpm --dir backend/app vitest run test/integration/migration.test.ts`.

**Checks manuales:**

- [ ] **P15.MAN** — emails de rotación propuesta/cancelada/ejecutada.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** V9 §14 y A5/A17 cubiertos; ninguna rotación asistida sin 48 h.

**Security checks:**

- [ ] **P15.SEC** — cancelación posible sin backend (firma + cualquier relayer).
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(recovery): add key rotation, recovery and cancellation flows`.

#### CHECKPOINT P15

- [ ] build pasa: `pnpm --dir backend/app build`.
- [ ] tests pasan: `pnpm --dir backend/app test`.
- [ ] security tests pasan: `pnpm --dir backend/app test:security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (runbooks de recovery y migración).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P16–P19:** API completa y estable (OpenAPI congelada para v1; cambios posteriores con versionado).

---

### P16 — Frontends: base común por elección

**Objetivo:** crear `frontend/wallet` y `frontend/recovery` como proyectos independientes con el hardening de [F-SEC] desde el primer commit, builds reproducibles y design tokens compartidos sólo como CSS.

**Archivos/componentes:** `frontend/design-tokens/{tokens.css,fonts/*,LICENSES}`, por app: `package.json` + `pnpm-lock.yaml`, `vite.config.ts`, `index.html`, `src/security/{trusted-types.ts,sw-killswitch.ts,csp-report.ts}`, `build/{sri-plugin.ts,manifest.ts,sign-manifest.ts,headers.json}`, `eslint.config.js`, `scripts/sync-design-tokens.mjs`; backend: `POST /api/v1/security/csp-report`.

**Dependencias:** P08 (puede avanzar en paralelo a P09–P15).

**Implementación requerida:**

- [ ] **P16.T01** — `design-tokens/tokens.css` (variables CSS: colores, tipografía, espaciado; look & feel coherente con la landing existente sin copiar código) y fuentes self-hosted con licencia. Cada app lo copia en build con `scripts/sync-design-tokens.mjs` verificando SHA-256 (sin dependencia npm compartida).
      Verificación: `node frontend/wallet/scripts/sync-design-tokens.mjs --check` y `node frontend/recovery/scripts/sync-design-tokens.mjs --check`.
- [ ] **P16.T02** — Scaffold de cada app con versiones exactas (§3.6) y settings de supply chain (P01.T05), con `@playwright/test` como dependencia de desarrollo propia para `test:browser` (tests de navegador de esa app contra el stack local; el proyecto `e2e/` de P22 cubre luego los flujos completos entre apps). Wallet: sin wagmi/conectores (test de dependencias). Recovery: wagmi/conectores declarados pero importados sólo vía `import()` en `src/external-wallet/`.
      Verificación: `pnpm --dir frontend/wallet install --frozen-lockfile && pnpm --dir frontend/wallet build`; ídem `frontend/recovery`; test de dependencias (Wallet sin wagmi).
- [ ] **P16.T03** — ESLint: prohibidos `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`, `eval`/`new Function`, `localStorage`/`sessionStorage` fuera de módulos allowlisteados (sólo flags no sensibles y `state` OAuth), imports fuera del directorio de la app (salvo el CSS de tokens).
      Verificación: `pnpm --dir frontend/wallet lint` y `pnpm --dir frontend/recovery lint` (con un caso prohibido que debe fallar en `lint-fixtures/`).
- [ ] **P16.T04** — Seguridad en runtime: política Trusted Types única `mtw-default` con allowlist de URLs de workers generada en build y comprobación al arrancar de que la CSP está activa ([F-SEC-02]), kill-switch de service workers ([F-SEC-04]), listener de `securitypolicyviolation` → `POST /api/v1/security/csp-report` (endpoint agregado en backend en esta tarea; rate limited, sin datos sensibles).
      Verificación: `pnpm --dir frontend/wallet test:browser -- security/trusted-types` y lo mismo en `frontend/recovery` (worker carga con TT forzado; sink de prueba bloqueado; sin SW).
- [ ] **P16.T05** — Headers: `build/headers.json` por app (CSP de [F-SEC-01] con hosts por entorno, HSTS, COOP/COEP/CORP, Referrer-Policy, Permissions-Policy, nosniff) aplicado por `vite preview` en local y por el contenedor estático propio de cada app (`wallet-web`/`recovery-web`) en P26; `build.modulePreload.polyfill = false` y cero scripts/estilos inline (CSP `'self'`).
      Verificación: `pnpm --dir frontend/wallet test:browser -- security/headers` y lo mismo en `frontend/recovery` (contra `vite preview`).
- [ ] **P16.T06** — Build reproducible: `SOURCE_DATE_EPOCH` = fecha del commit, nombres por hash de contenido, toolchain fijado; plugin SRI propio; generador de `release-manifest.json` (releaseId, commit, SHA-256 por archivo) y firma Ed25519 con la clave de release **de esa app** (dev local en `.secrets/`; CI por Environment en P20/P26). Implementado por separado en cada app.
      Verificación: `bash ci/scripts/repro-build.sh wallet` y `bash ci/scripts/repro-build.sh recovery` → manifests idénticos y firma verificable.
- [ ] **P16.T07** — SBOM CycloneDX por build (syft vía imagen Docker fijada).
      Verificación: SBOM generado por build en `dist/sbom.cdx.json` de cada app (`bash ci/scripts/sbom.sh`).
- [ ] **P16.T08** — Test de grafo de bundle en Recovery: los chunks de entrada y de los flujos de R interna no contienen módulos de wagmi/conectores/WalletConnect/Coinbase/MetaMask.
      Verificación: `pnpm --dir frontend/recovery vitest run test/bundle-graph.test.ts`.
- [ ] **P16.T09** — Contratos del sistema por entorno [F-SEC-08]: script de build que genera `system-contracts.<env>.json` desde `contracts/deployments/<env>.json` (local: `deployments/local.json`), lo embebe y lo incluye en el manifest; incluye la clave pública de atestación del signer.
      Verificación: build local contiene el archivo y su hash figura en `release-manifest.json`; test que rechaza una dirección distinta informada por el backend.
- [ ] **P16.T10** — Regla de dependencias comunes [F-SEC-09]: check de CI que compara los lockfiles de Wallet y Recovery y bloquea publicar en ambas apps, dentro de 72 h, un mismo bump de `@noble/*`, `viem` o `@scure/*`; requiere aprobación de revisores de cada dominio.
      Verificación: `bash ci/scripts/check-shared-deps.sh` con un caso que falla y otro que pasa.

**Tests a implementar:**

- [ ] **P16.TST** — build sin scripts inline; SRI presente en todo `<script>`/`<link>`; manifest verificable con la clave pública; dos builds consecutivos → manifests idénticos; headers presentes en `vite preview` (Playwright); TT bloquea un sink de prueba; SW inexistente.
      Verificación: `pnpm --dir frontend/wallet test && pnpm --dir frontend/recovery test`.

**Checks manuales:**

- [ ] **P16.MAN** — auditar con DevTools que no hay requests a terceros al cargar cada app.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** ambas apps arrancan y se construyen de forma reproducible con CSP/TT activos y sin violaciones.

**Security checks:**

- [ ] **P16.SEC** — `pnpm audit --prod`, OSV-Scanner sobre cada lockfile, Semgrep reglas frontend.
      Verificación: `pnpm --dir frontend/wallet test:browser -- security && pnpm --dir frontend/recovery test:browser -- security && bash ci/scripts/ci-security.sh`.

**Commits:** `feat(wallet): scaffold hardened wallet frontend`, `feat(recovery): add independent recovery frontend`.

#### CHECKPOINT P16

- [ ] build pasa: `pnpm --dir frontend/wallet build && pnpm --dir frontend/recovery build` (reproducibles).
- [ ] tests pasan: `pnpm --dir frontend/wallet test && pnpm --dir frontend/recovery test`.
- [ ] security tests pasan: `pnpm --dir frontend/wallet test:browser -- security && pnpm --dir frontend/recovery test:browser -- security && bash ci/scripts/ci-security.sh`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P17/P19:** CSP/TT sin violaciones y builds reproducibles.

---

### P17 — Frontend Wallet I: cuenta, gestión de U, backups y desbloqueo

**Objetivo:** [F-KEY], [F-DRV], [F-SES] en la app Wallet.

**Archivos/componentes:** `frontend/wallet/src/{api/*,crypto/*,workers/argon2.worker.ts,drive/*,auth/*,onboarding/*,unlock/*,security/*}`, `src/config/chain.base.json` (copia propia de direcciones fijadas + test de igualdad con `config/chains/base-mainnet.json`), `src/vendor/mtw-wordlist-v1.txt` (+ hash).

**Dependencias:** P10, P16.

**Implementación requerida:**

- [ ] **P17.T01** — Cliente API: `credentials: 'include'`, CSRF, `Idempotency-Key`, errores RFC 9457, firma de requests críticos con la session key y envelope de envío ([F-SES-03]).
      Verificación: `pnpm --dir frontend/wallet vitest run src/api`.
- [ ] **P17.T02** — **Spike OAuth Google (ADR-012)**: con los clientes OAuth locales reales, probar authorization code + PKCE sin client secret canjeado desde el navegador (el endpoint de token real se sondea con un código de prueba: distingue "falta client_secret" de "código inválido" sin necesitar un login interactivo). Registrar resultado (request/response sin secretos) en `docs/adr/ADR-012-*.md` y fijar el flujo. Implementar `drive/` ([F-DRV-01..05]) con verificación post-subida y chequeo de salud del backup.
      Verificación: ADR-012 actualizado con el resultado del spike y `pnpm --dir frontend/wallet vitest run src/drive`; check manual del round-trip OAuth registrado en §13.
- [ ] **P17.T03** — Pantallas de cuenta: registro, verificación de email, login (+TOTP), logout, forgot/reset, sesiones (listar/revocar), TOTP setup. Texto explícito: password de cuenta ≠ Password U; reset de cuenta no recupera U.
      Verificación: `pnpm --dir frontend/wallet vitest run src/auth` + `pnpm --dir frontend/wallet test:browser -- auth`.
- [ ] **P17.T04** — Módulo `crypto/`: generación de U [F-KEY-01], Password U [F-KEY-02], Argon2id en worker + HKDF [F-KEY-03], sobre `U.enc` con AAD [F-KEY-04], vida en memoria y zeroización [F-KEY-05], backup de 17 palabras con checksum [F-KEY-06.4], firma EIP-712 con `@noble/curves` (low-s).
      Verificación: `pnpm --dir frontend/wallet vitest run src/crypto` (vectores RFC 9106, RFC 5869, AES-GCM con AAD, 17 palabras).
- [ ] **P17.T05** — Onboarding de U en este orden: conectar Drive (OAuth, [F-DRV-01]) → generar U → mostrar Password U → confirmar 2 palabras → subir a Drive y verificar → **backup independiente de la plataforma obligatorio** (archivo, QR o 17 palabras, [F-KEY-06]) → registro OPAQUE y alta de U en backend.
      Verificación: `pnpm --dir frontend/wallet vitest run src/onboarding` + `pnpm --dir frontend/wallet test:browser -- onboarding`.
- [ ] **P17.T06** — Desbloqueo: Password U → Argon2id → OPAQUE → PlatformSession; `K_U` como CryptoKey no exportable; bloqueo por inactividad/expiración; chequeo periódico no bloqueante del backup en Drive [F-DRV-05]. Para probar el desbloqueo con scope `OPERATIONS` (que exige wallet ACTIVE) los tests completan el onboarding por API (P12) antes de usar la UI.
      Verificación: `pnpm --dir frontend/wallet vitest run src/unlock`.
- [ ] **P17.T07** — Cambio de Password U [F-KEY-08] y flujo "perdí mi Password U" (step-up → U' → handoff a Recovery con QR/link).
      Verificación: `pnpm --dir frontend/wallet vitest run src/security/password-u`.
- [ ] **P17.T08** — Medición de rendimiento de Argon2id en el perfil móvil de referencia (Playwright con emulación de dispositivo móvil y throttling de CPU 4×, en Chromium y WebKit): registrar p95 en ADR-013; aplicar la regla de fallback si supera 3 s.
      Verificación: p95 registrado en ADR-013 (`pnpm --dir frontend/wallet test:browser -- perf/argon2` con throttling de CPU).
- [ ] **P17.T09** — Restauración de U en un dispositivo nuevo [F-KEY-10]: desde Drive, archivo, QR y 17 palabras; verificación contra el rol U on-chain; flujo `KEY_RESTORE` (prueba de posesión + reemplazo del registro OPAQUE) para la restauración por palabras.
      Verificación: `pnpm --dir frontend/wallet vitest run src/restore` + `pnpm --dir frontend/wallet test:browser -- restore`.

**Tests a implementar:**

- [ ] **P17.TST** — vectores (RFC 9106 Argon2id, RFC 5869 HKDF, AES-GCM con AAD), alteración de AAD/ciphertext → falla, password errónea → falla sin oráculo, checksum de 17 palabras detecta errores de tipeo, wordlist con hash correcto, zeroización best-effort, integración con backend real (OPAQUE), Drive contra la API real con la cuenta de prueba (`GOOGLE_DRIVE_TEST_*`, obligatorio en cada `pnpm ci:local` y en CI).
      Verificación: `pnpm --dir frontend/wallet test && pnpm --dir frontend/wallet test:browser`.

**Checks manuales:**

- [ ] **P17.MAN** — onboarding completo en Chromium y Firefox; revisar textos de advertencia.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** U nunca sale del navegador ni se persiste en claro (verificado en P22); desbloqueo y backups funcionando contra servicios reales.

**Security checks:**

- [ ] **P17.SEC** — búsqueda automática de la clave U/Password U en todos los requests y storages tras los flujos (test de canario).
      Verificación: `pnpm --dir frontend/wallet test:browser -- security`.

**Commits:** `feat(wallet): add user key management and encrypted backups`, `feat(wallet): add account and unlock flows`.

#### CHECKPOINT P17

- [ ] build pasa: `pnpm --dir frontend/wallet build`.
- [ ] tests pasan: `pnpm --dir frontend/wallet test && pnpm --dir frontend/wallet test:browser`.
- [ ] security tests pasan: `pnpm --dir frontend/wallet test:browser -- security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (ADR-012, ADR-013).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P18:** flujo de cuenta + U + desbloqueo verde contra backend local.

---

### P18 — Frontend Wallet II: onboarding Safe y operación

**Objetivo:** completar la app Wallet (prompt §7, §10–§12, V9 §6/§16).

**Archivos/componentes:** `frontend/wallet/src/{recovery-activation/*,safe/{predict.ts,verify.ts},home/*,assets/*,whitelist/*,send/*,swap/*,activity/*,security/rotations/*,sovereign/*,chain/{client.ts,safe-tx.ts,decoders.ts,abis/*}}`.

**Dependencias:** P15, P17.

**Implementación requerida:**

- [ ] **P18.T01** — Activar Recovery: crear enrollment, QR/link [F-LNK-01], esperar envío, confirmar R por fragmento de regreso o comparación manual completa [F-LNK-02], verificar la `SignerKeyAttestation` de S con la clave fijada [F-SEC-08], recalcular la dirección esperada y que U firme `WalletCreationAuthorization` [W-01].
      Verificación: `pnpm --dir frontend/wallet vitest run src/recovery-activation` + `pnpm --dir frontend/wallet test:browser -- recovery-activation`.
- [ ] **P18.T02** — Creación de Safe: cálculo **propio** de la dirección (initializer + CREATE2 con direcciones de su `chain.base.json`) comparado con el backend; tras el deploy, verificación **propia** por RPC del frontend de todos los ítems de V9 §16 + codehash de todos los contratos del sistema; la Safe se muestra operativa sólo tras ACTIVE propio; re-verificación en cada desbloqueo.
      Verificación: `pnpm --dir frontend/wallet vitest run src/safe` (predict/verify contra vectores) + `pnpm --dir frontend/wallet test:browser -- safe-creation`.
- [ ] **P18.T03** — Home: dirección (EIP-55, copiar, QR de recepción con advertencia "sólo red Base"), saldos leídos directo de cadena y cruzados con backend, actividad reciente, banner de rotaciones pendientes leídas on-chain.
      Verificación: `pnpm --dir frontend/wallet test:browser -- home` (copiar dirección, QR, saldos, actividad).
- [ ] **P18.T04** — Assets: USDC y USDT con balance, símbolo, decimales y contrato; si `symbol/decimals` on-chain difieren de la config → error bloqueante.
      Verificación: `pnpm --dir frontend/wallet test:browser -- assets`.
- [ ] **P18.T05** — Whitelist: lista (`destinationsOf` on-chain + labels del backend), alta (código del email, revisión de la dirección, firma U), cuenta regresiva de activación, baja.
      Verificación: `pnpm --dir frontend/wallet test:browser -- whitelist`.
- [ ] **P18.T06** — Send: token, destino (sólo ACTIVE), monto (parsing con bigint y decimales), review decodificado desde los bytes construidos localmente y comparados con los del backend, 2FA si corresponde, firma, seguimiento de estado.
      Verificación: `pnpm --dir frontend/wallet test:browser -- send` (incluye bytes del backend ≠ locales → firma bloqueada).
- [ ] **P18.T07** — Swap: cotización del backend + cotización propia (QuoterV2 `eth_call` por RPC propio), slippage ≤ 0,5 %, review de las 2 SafeTx (approve exacto + swap, allowance final 0), firma de ambas, seguimiento del grupo.
      Verificación: `pnpm --dir frontend/wallet test:browser -- swap`.
- [ ] **P18.T08** — Actividad: operaciones con estados (incluye MINED/CONFIRMED/FINALIZED), transfers entrantes/salientes, link al explorer (sin embeber terceros).
      Verificación: `pnpm --dir frontend/wallet test:browser -- activity`.
- [ ] **P18.T09** — Seguridad: rotaciones (pendientes on-chain, cancelar con firma U → relay o exportar firma; ejecutar maduras), estado de Recovery, sesiones, TOTP.
      Verificación: `pnpm --dir frontend/wallet test:browser -- security-rotations`.
- [ ] **P18.T09.a** — Reemplazar Recovery (R perdida o comprometida): iniciar enrollment de R' (mismo flujo QR/link de P18.T01 hacia Recovery), U firma la propuesta, cuenta regresiva de 48 h, U firma la ejecución.
      Verificación: `pnpm --dir frontend/wallet test:browser -- replace-recovery`.
- [ ] **P18.T09.b** — Rotación de S solicitada por la plataforma (shard, migración a HSM, compromiso): banner con motivo, revisión de la nueva dirección S' (leída on-chain del timelock tras proponer), U firma propuesta y, al madurar, ejecución.
      Verificación: `pnpm --dir frontend/wallet vitest run src/security/rotations` + test de integración contra backend y fork.
- [ ] **P18.T10** — Co-firma soberana: importar SafeTx (JSON/QR) de Recovery, decodificar y mostrar, firmar con U, exportar firma; **sin backend**.
      Verificación: `pnpm --dir frontend/wallet vitest run src/sovereign` + `pnpm --dir frontend/wallet test:browser -- sovereign-cosign`.
- [ ] **P18.T11** — Migración excepcional en Wallet (`/security/migration`): verificación on-chain de la Safe destino (owners, roles en el Guard, creada por la factory, autorización madura en `PolicyRegistry`) antes de firmar `MIGRATION_TRANSFER` con U.
      Verificación: test de integración contra el fork con una autorización de migración de prueba.

**Tests a implementar:**

- [ ] **P18.TST** — unit de `predict.ts`/`verify.ts` contra vectores; integración contra backend + fork (onboarding completo, send, swap, whitelist, rotaciones); test de que la UI no permite elegir destinos no ACTIVE; test de que un `prepare` del backend con bytes distintos a los locales bloquea la firma.
      Verificación: `pnpm --dir frontend/wallet test && pnpm --dir frontend/wallet test:browser`.

**Checks manuales:**

- [ ] **P18.MAN** — recorrido completo en el fork; legibilidad del review de operaciones.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** todas las pantallas de [F-UI] Wallet operativas contra servicios reales del entorno local.

**Security checks:**

- [ ] **P18.SEC** — ningún dato de la SafeTx se toma del backend sin re-construcción local; verificación independiente de la Safe obligatoria.
      Verificación: `pnpm --dir frontend/wallet test:browser -- security`.

**Commits:** `feat(wallet): add safe onboarding, assets, whitelist, send and swap`.

#### CHECKPOINT P18

- [ ] build pasa: `pnpm --dir frontend/wallet build`.
- [ ] tests pasan: `pnpm --dir frontend/wallet test && pnpm --dir frontend/wallet test:browser`.
- [ ] security tests pasan: `pnpm --dir frontend/wallet test:browser -- security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P20:** Wallet completa en local (P19 puede haberse completado en paralelo).

---

### P19 — Frontend Recovery

**Objetivo:** app mínima e independiente para R (V9 §5/§6/§14/§18; prompt §9).

**Archivos/componentes:** `frontend/recovery/src/{api/*,crypto/*,workers/argon2.worker.ts,drive/*,auth/*,enroll/*,external-wallet/* (lazy),recover-u/*,rotations/*,sovereign/*,chain/*}`, `src/config/chain.base.json` (copia propia).

**Dependencias:** P15, P16.

**Implementación requerida:**

- [ ] **P19.T01** — Auth de cuenta + step-up (email OTP + TOTP) → PlatformSession `ENROLLMENT`/`RECOVERY` con session key propia (Enrollment Key).
      Verificación: `pnpm --dir frontend/recovery vitest run src/auth`.
- [ ] **P19.T02** — Módulo `crypto/` **implementado y revisado por separado** del de Wallet (R-encryption-v1, Password R, sobre `R.enc`, 17 palabras); comparte sólo vectores de test (copiados, con hash).
      Verificación: `pnpm --dir frontend/recovery vitest run src/crypto` (mismos vectores que Wallet, copia propia con hash).
- [ ] **P19.T03** — Enrollment desde link/QR: Enrollment Key, crear R interna (Password R + backups: Drive Recovery / archivo / QR / palabras) **o** conectar wallet externa (chunk lazy: `injected`, `metaMask`, `coinbaseWallet` con `preference: { options: 'eoaOnly' }`, `walletConnect` con `showQrModal: false` y QR propio), proof-of-control EIP-712, envío, link/QR de regreso [F-LNK-02].
      Verificación: `pnpm --dir frontend/recovery test:browser -- enroll` (R interna y externa con el provider de test).
- [ ] **P19.T04** — Recovery de U: ver U' pendiente (y comparar con lo que muestra Wallet), desbloquear R, firmar propuesta (R+S), cuenta regresiva on-chain, firmar ejecución al madurar.
      Verificación: `pnpm --dir frontend/recovery test:browser -- recover-u`.
- [ ] **P19.T05** — Rotaciones: pendientes on-chain; cancelar con firma de R (relay del backend o envío propio con wallet externa pagando gas a `cancelWithSignature`); ejecutar maduras.
      Verificación: `pnpm --dir frontend/recovery test:browser -- rotations`.
- [ ] **P19.T06** — Modo soberano: acciones tipificadas (transferir saldo a una dirección elegida, reemplazar S, retirar/cambiar Guard o module guard, `updateRoles` del Guard, NoOp) con el formato [W-05], nonce leído on-chain, firma R, export para co-firma U, import de la firma U, combinación ordenada por signer, transmisión con wallet externa o export de calldata para cualquier relayer. Debe funcionar **con el backend apagado**.
      Verificación: `pnpm --dir frontend/recovery test:browser -- sovereign` con el backend detenido.
- [ ] **P19.T07** — Compatibilidad de conectores con CSP/Trusted Types: test E2E por conector; hosts de WalletConnect agregados a `connect-src` tras verificarlos en la doc oficial; conectores incompatibles excluidos y documentados.
      Verificación: `pnpm --dir frontend/recovery test:browser -- connectors` y registro de conectores probados en §13.
- [ ] **P19.T08** — Importar/restaurar R [F-KEY-10]: desde Drive de Recovery en un dispositivo nuevo, archivo, QR o 17 palabras; verificación contra el rol R on-chain; nueva Password R y re-cifrado si se restauró por palabras.
      Verificación: `pnpm --dir frontend/recovery vitest run src/restore` + `pnpm --dir frontend/recovery test:browser -- restore`.
- [ ] **P19.T09** — Herramienta de salida soberana `wallet/tools/sovereign-exit/`: bundle estático único, reproducible y firmado, que funciona offline (sólo usa el RPC que el usuario indique): descifra `U.enc`/`R.enc` o restaura desde 17 palabras, arma una SafeTx soberana tipada, firma con U y R, combina y emite la calldata de `execTransaction` o la transmite con la cuenta que el usuario elija. Es la única pieza que junta U y R, sólo en la máquina del usuario y fuera de los origins de la plataforma.
      Verificación: test E2E en el fork con backend y frontends apagados: transferencia soberana exitosa.
- [ ] **P19.T10** — Pantallas `/emergency` (R + S: quitar destinos, NoOp, revocar allowances) y `/migration` (R firma `MIGRATION_TRANSFER` tras verificar on-chain la Safe destino).
      Verificación: `pnpm --dir frontend/recovery vitest run src/emergency src/migration` + integración contra backend y fork.

**Tests a implementar:**

- [ ] **P19.TST** — vectores crypto; enrollment interno y externo (con wallet de prueba inyectada en Playwright mediante extensión/provider EIP-6963 de test que firma con una clave de test — sólo en E2E); recovery de U en fork con warp de 48 h; modo soberano con backend detenido.
      Verificación: `pnpm --dir frontend/recovery test && pnpm --dir frontend/recovery test:browser`.

**Checks manuales:**

- [ ] **P19.MAN** — WalletConnect real: test automatizado que conecta Recovery con una wallet headless (`@reown/walletkit`, versión fijada) a través del **relay real de Reown** con `WALLETCONNECT_PROJECT_ID`, firma el proof-of-control y una cancelación de rotación en el fork; más los conectores `injected`, `metaMask` y `coinbaseWallet` con el provider EIP-6963 de test.
      Verificación: `pnpm --dir frontend/recovery test:browser -- walletconnect.live` en verde; resultado registrado en §13.

**Acceptance criteria:** Recovery cumple su función mínima sin compartir runtime con Wallet; modo soberano operativo sin plataforma.

**Security checks:**

- [ ] **P19.SEC** — grafo de bundle (P16.T08) verde; ningún request a terceros salvo los de WalletConnect cuando se usa ese conector.
      Verificación: `pnpm --dir frontend/recovery test:browser -- security && pnpm --dir frontend/recovery vitest run test/bundle-graph.test.ts`.

**Commits:** `feat(recovery): add independent recovery frontend`, `feat(recovery): add sovereign transaction builder`.

#### CHECKPOINT P19

- [ ] build pasa: `pnpm --dir frontend/recovery build`.
- [ ] tests pasan: `pnpm --dir frontend/recovery test && pnpm --dir frontend/recovery test:browser`.
- [ ] security tests pasan: `pnpm --dir frontend/recovery test:browser -- security && pnpm --dir frontend/recovery vitest run test/bundle-graph.test.ts`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P20:** enrollment, recovery de U, cancelación y modo soberano verdes en local.

---

### P20 — Integridad de releases y pausa de cooperación de S

**Objetivo:** V9 §17 "monitores independientes … una discrepancia pausa la cooperación de S".

**Archivos/componentes:** `wallet/backend/integrity-monitor/` (proyecto propio: `src/monitor.ts`, `src/attestation.ts`), `.github/workflows/wallet-integrity-offhost.yml` (chequeo off-host programado), `backend/signer/src/policy/integrity.ts`, `wallet/config/release-keys/{wallet.pub,recovery.pub}` (públicas), runbook `docs/runbooks/integrity-mismatch.md`.

**Dependencias:** P18, P19.

**Implementación requerida:**

- [ ] **P20.T01** — Claves de release Ed25519 **distintas** para Wallet y Recovery (dev en `.secrets/`; staging/prod sólo en el GitHub Environment de cada pipeline). Públicas fijadas en el monitor.
      Verificación: `node scripts/check-release-keys.mjs` (públicas fijadas, privadas ausentes del repo y del backend).
- [ ] **P20.T02** — Integrity monitor (contenedor propio, clave de atestación propia): cada 60 s y por app/entorno descarga `/.well-known/release-manifest.json(.sig)`, verifica firma, descarga cada archivo listado y verifica SHA-256, verifica headers (CSP, HSTS, etc.) y SRI de `index.html`, detecta archivos/scripts no listados; registra `integrity_status` y emite la atestación firmada `IntegrityAttestation` de [W-03] (`{platformId, app, environment, releaseId, manifestSha256, status, observedAt, expiresAt}`) que consume el signer.
      Verificación: `pnpm --dir backend/integrity-monitor vitest run`.
- [ ] **P20.T02.a** — Chequeo **off-host**: workflow programado de GitHub Actions (cada 15 min) que hace las mismas verificaciones contra las URLs públicas con las claves públicas de release del repo y alerta por email/webhook ante discrepancia; no depende del host de producción (si el host se compromete, la alerta igual sale), no pausa al signer.
      Verificación: ejecución manual del workflow contra un `vite preview` expuesto en un runner de prueba con un archivo alterado → falla y notifica.
- [ ] **P20.T03** — Signer: con `INTEGRITY_REQUIRED=true` (staging/prod) exige atestaciones OK de ambas apps con antigüedad ≤ 5 min; ante MISMATCH rechaza cooperar de inmediato (`COOPERATION_PAUSED`); ante UNREACHABLE alerta y concede 15 min de gracia antes de pausar; alerta crítica, auditoría y banner en Wallet; el camino soberano no se afecta.
      Verificación: `pnpm --dir backend/signer vitest run test/policy/integrity.test.ts`.
- [ ] **P20.T04** — Reanudación sólo con atestación OK + acción de dos operadores registrada.
      Verificación: `pnpm --dir backend/integrity-monitor vitest run test/resume-dual-approval.test.ts`.

**Tests a implementar:**

- [ ] **P20.TST** — alterar un archivo del build servido localmente → pausa en ≤ 2 ciclos; firma de manifest inválida → pausa; restaurar → reanudación con doble aprobación; monitor caído → fail-closed.
      Verificación: `pnpm --dir backend/integrity-monitor test && pnpm --dir backend/signer vitest run test/policy/integrity.test.ts`.

**Checks manuales:**

- [ ] **P20.MAN** — simulacro de mismatch en local con el stack completo.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** A20 verde.

**Security checks:**

- [ ] **P20.SEC** — el monitor no comparte credenciales con los pipelines de frontends; las claves privadas de release no existen en el backend.
      Verificación: `bash ci/scripts/ci-security.sh`.

**Commits:** `feat(security): add release integrity monitoring and signer cooperation pause`.

#### CHECKPOINT P20

- [ ] build pasa: `pnpm --dir backend/integrity-monitor build`.
- [ ] tests pasan: `pnpm --dir backend/integrity-monitor test && pnpm --dir backend/signer vitest run test/policy/integrity.test.ts`.
- [ ] security tests pasan: `bash ci/scripts/ci-security.sh`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (runbook de integridad).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P21:** pausa por integridad demostrada en local.

---

### P21 — Entorno local integrado y seed determinístico

**Objetivo:** levantar todo con el mínimo de comandos y obtener siempre el mismo escenario (prompt §26–§27).

**Archivos/componentes:** `wallet/scripts/{dev.mjs,install-all.mjs,dev-fresh}`, `wallet/package.json` (scripts `install` hook, `dev`, `dev:fresh`, `deploy-local`, `seed-local`), `docs/runbooks/local-environment.md`.

**Dependencias:** P20.

**Implementación requerida:**

- [ ] **P21.T01** — `pnpm install` en `wallet/` ejecuta `scripts/install-all.mjs`: `pnpm install --frozen-lockfile` en cada proyecto (lockfiles separados) y `forge soldeer install` + `script/verify-deps.sh` en `contracts`; sin dependencias en la raíz.
      Verificación: `cd wallet && pnpm install` en un clon limpio instala todos los proyectos con lockfile congelado.
- [ ] **P21.T02** — `pnpm dev` (`scripts/dev.mjs`, sólo `node:child_process`): verifica preflight rápido → compose arriba → migraciones (backend y signer) → `deploy-local` (idempotente) → `seed-local` (idempotente) → signer dev, API (8080/8081), worker, watcher, indexer, gas tank, integrity monitor (modo local) → Wallet (5173) y Recovery (5174); logs con prefijo; apagado ordenado con Ctrl+C.
      Verificación: `node scripts/dev-healthcheck.mjs` (health de cada servicio, contratos desplegados y ambos frontends respondiendo).
- [ ] **P21.T03** — `pnpm dev:fresh`: `fork:reset` + reset de DBs + deploy + seed → escenario determinístico (mismas direcciones de contratos y de la Safe de prueba, mismos saldos reales de USDC/USDT del fork).
      Verificación: `pnpm dev:fresh` dos veces → mismas direcciones y saldos (`diff` de los reportes de seed).
- [ ] **P21.T04** — Seed completo (prompt §27), extendiendo la parte on-chain de P07.T07 con la off-chain: usuario de prueba con email verificado en DB, U/R generadas de forma determinística **sólo en local** desde `LOCAL_SEED` (los flujos de producto siguen generando claves con CSPRNG), sobres `U.enc`/`R.enc` de prueba cifrados con Passwords de prueba en `wallet/.secrets/seed/` (para importarlos en los frontends), registro OPAQUE del usuario, S en signer dev, Safe creada por `WalletFactory` y registrada en DB como ACTIVE tras la verificación normal, USDC y USDT fondeados con tokens reales del fork, destino de prueba whitelisteado y activado (warp de 24 h en el fork). Imprime credenciales de prueba (sólo local).
      Verificación: `node scripts/seed-check.mjs` (login por API del usuario seed, Safe ACTIVE y saldo on-chain esperado).
- [ ] **P21.T05** — Runbook local + troubleshooting (puertos ocupados, RPC archive, caché del fork, reset).
      Verificación: `node scripts/check-docs.mjs`.

**Tests a implementar:**

- [ ] **P21.TST** — `scripts/dev-healthcheck.mjs` y `scripts/seed-check.mjs`: tras `pnpm dev:fresh` todos los servicios responden, el usuario seed inicia sesión por API, su Safe está ACTIVE con el saldo esperado, y dos ejecuciones de `dev:fresh` producen los mismos valores (el spec E2E equivalente se agrega en P22).
      Verificación: `node scripts/dev-healthcheck.mjs && node scripts/seed-check.mjs`.

**Checks manuales:**

- [ ] **P21.MAN** — desde un clon limpio: `docker compose up -d && pnpm install && pnpm preflight && pnpm dev`.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** los 4 comandos levantan PostgreSQL, Valkey, fork de Base, contratos desplegados, backend, worker, signer, Wallet y Recovery.

**Security checks:**

- [ ] **P21.SEC** — el seed se niega a correr fuera de `APP_ENV=local` y fuera de Anvil.
      Verificación: `bash ci/scripts/ci-security.sh`.

**Commits:** `chore(infra): add one-command local environment and deterministic seed`.

#### CHECKPOINT P21

- [ ] build pasa: `pnpm install && pnpm dev` (todos los servicios arriba).
- [ ] tests pasan: `node scripts/dev-healthcheck.mjs && node scripts/seed-check.mjs`.
- [ ] security tests pasan: `bash ci/scripts/ci-security.sh`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (runbook local).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P22:** smoke determinístico verde 3 veces.

---

### P22 — Tests frontend y E2E Playwright

**Objetivo:** prompt §30 completo sobre el stack local real.

**Archivos/componentes:** `wallet/e2e/` (proyecto propio): `playwright.config.ts`, `fixtures/{mailpit.ts,fork.ts,users.ts,test-wallet-provider.ts}`, `specs/*.spec.ts`.

**Dependencias:** P21.

**Implementación requerida:**

- [ ] **P22.T01** — Fixtures: lectura de OTPs desde la API de Mailpit; helpers de fork **sólo de test** (`evm_increaseTime`/`evm_mine` para 24 h/48 h, fondeo con USDC/USDT reales del fork); provider EIP-6963 de test para "wallet externa" en Recovery.
      Verificación: `pnpm --dir e2e test specs/fixtures-selftest.spec.ts`.
- [ ] **P22.T02** — Specs E2E, uno por flujo (`e2e/specs/<flujo>.spec.ts`).
      Verificación: `pnpm --dir e2e test --project=chromium` (todas las subtareas en verde).
  - [ ] **P22.T02.a** — create account.
  - [ ] **P22.T02.b** — login.
  - [ ] **P22.T02.c** — logout.
  - [ ] **P22.T02.d** — forgot password (reset completo; U sigue intacta).
  - [ ] **P22.T02.e** — Safe creation (verificación propia del frontend hasta ACTIVE).
  - [ ] **P22.T02.f** — recovery enrollment con R interna.
  - [ ] **P22.T02.g** — recovery enrollment con R externa (provider de test).
  - [ ] **P22.T02.h** — copy Safe address.
  - [ ] **P22.T02.i** — receive USDC (transfer real hacia la Safe → saldo y actividad).
  - [ ] **P22.T02.j** — assets.
  - [ ] **P22.T02.k** — whitelist address (código por email en Mailpit, activación 24 h).
  - [ ] **P22.T02.l** — send USDC.
  - [ ] **P22.T02.m** — reject non-whitelisted address (UI no lo ofrece; API manipulada vía interceptación → rechazo; intento directo on-chain → revert).
  - [ ] **P22.T02.n** — swap USDC→USDT y swap USDT→USDC.
  - [ ] **P22.T02.o** — operation queue/status (estados hasta FINALIZED, cancelación por NoOp).
  - [ ] **P22.T02.p** — recover U with R y recover R with U.
  - [ ] **P22.T02.q** — cancel rotation (por U y por R).
  - [ ] **P22.T02.r** — restaurar U en dispositivo nuevo (archivo, QR y 17 palabras).
  - [ ] **P22.T02.s** — restaurar R en dispositivo nuevo (archivo, QR y 17 palabras).
- [ ] **P22.T03** — Specs de seguridad: cero requests a hosts fuera de la allowlist; cero violaciones CSP/TT; sin service workers; U/R/Passwords U-R ausentes de localStorage, sessionStorage, IndexedDB, cookies y de todos los requests; **tokens** (PlatformSession JWS, material de la session key, token CSRF, access token de Drive) ausentes de localStorage/sessionStorage/IndexedDB (sólo memoria); bloqueo por inactividad; sesión expirada.
      Verificación: `pnpm --dir e2e test specs/security`.
- [ ] **P22.T04** — Drive real: como el login de Google no se puede automatizar, el cliente Drive de cada app se prueba **contra la API real** con una cuenta de prueba autorizada una vez (`GOOGLE_DRIVE_TEST_*`): subir, leer, reemplazar y borrar `U.enc`/`R.enc` en `appDataFolder`, en cada `pnpm ci:local` y en CI (obligatorio, nunca se saltea); el spec E2E de onboarding cubre además el backup por archivo.
      Verificación: `pnpm --dir frontend/wallet test:drive-live && pnpm --dir frontend/recovery test:drive-live` en verde (sin credenciales → STOP en el preflight).
- [ ] **P22.T05** — Matriz: Chromium, Firefox y WebKit en cada `pnpm ci:local` y en CI (PR con label `e2e` y nightly).
      Verificación: `pnpm --dir e2e test --project=chromium --project=firefox --project=webkit`.
- [ ] **P22.T06** — Spec E2E `real-email.spec.ts`: crear cuenta, verificar email y recuperar password con **entrega real** (backend con el adaptador `mailgun` y el dominio sandbox hacia la casilla de `EMAIL_TEST_*`; el test lee los códigos con la Gmail API, scope `gmail.readonly`). El resto de los specs usa Mailpit para ser determinista.
      Verificación: `pnpm --dir e2e test specs/real-email.spec.ts`.

**Tests a implementar:**

- [ ] **P22.TST** — los anteriores.
      Verificación: `pnpm --dir e2e test --project=chromium`.

**Checks manuales:**

- [ ] **P22.MAN** — revisar videos/traces de Playwright de los flujos críticos.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** suite E2E verde 3 corridas seguidas sin flakiness (reintentos deshabilitados para medirlo).

**Security checks:**

- [ ] **P22.SEC** — P22.T03.
      Verificación: `pnpm --dir e2e test specs/security`.

**Commits:** `test(e2e): add end-to-end coverage for wallet and recovery flows`.

#### CHECKPOINT P22

- [ ] build pasa: `pnpm --dir e2e build` (typecheck del proyecto e2e).
- [ ] tests pasan: `pnpm --dir e2e test --project=chromium`.
- [ ] security tests pasan: `pnpm --dir e2e test specs/security`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (`e2e/README.md`).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P23:** E2E estable.

---

### P23 — Acceptance tests full-system sobre el fork

**Objetivo:** escenario automatizado de punta a punta (prompt §31) con caminos felices **y** de falla de seguridad.

**Archivos/componentes:** `wallet/e2e/acceptance/full-system.spec.ts`, `wallet/e2e/acceptance/security-failures.spec.ts`, `wallet/e2e/acceptance/report.md` (generado).

**Dependencias:** P22.

**Implementación requerida:**

- [ ] **P23.T01** — Escenario de 22 pasos en orden, sobre un deploy local **RESTRICTED** (igual que producción). Cada paso es un `test.step` con aserciones propias.
      Verificación: `pnpm --dir e2e test:acceptance` (3 corridas consecutivas en verde).
  - [ ] **P23.T01.a** — pasos 1–4: create account · create U · create R · create S.
  - [ ] **P23.T01.b** — pasos 5–6: deploy Safe · verify Safe (backend y frontend, todos los ítems de V9 §16).
  - [ ] **P23.T01.c** — pasos 7–8: fund Safe with real forked USDC · verify balance.
  - [ ] **P23.T01.d** — pasos 9–11: request whitelist · complete challenge · whitelist destination on-chain (y activación 24 h).
  - [ ] **P23.T01.e** — pasos 12–13: send USDC · verify destination balance.
  - [ ] **P23.T01.f** — pasos 14–15: attempt non-whitelisted send · prove it fails (en backend, signer y Guard).
  - [ ] **P23.T01.g** — pasos 16–19: swap USDC→USDT · verify balances · swap USDT→USDC · verify balances (allowance final 0).
  - [ ] **P23.T01.h** — paso 20: verify DB operation states (consulta directa a Postgres + `audit:verify`).
  - [ ] **P23.T01.i** — paso 21: exercise recovery flow (U perdida → U' con R, 48 h).
  - [ ] **P23.T01.j** — paso 22: exercise rotation cancellation (propuesta cancelada por U y por R).
- [ ] **P23.T02** — Caminos de falla: U sola / R sola / S sola ejecutando directo on-chain → revert; firma reusada en otra Safe/nonce → revert; DELEGATECALL asistido → revert; approve a Permit2 → revert; rotación ejecutada antes de 48 h → revert; reorg durante una operación (`anvil_reorg`) → REORGED → re-ejecución correcta; crash del worker a mitad de pipeline → recuperación; desacuerdo de RPC (proxy de fallas) → sin transición; mismatch de integridad → pausa de S; U+R soberano con backend detenido → transferencia exitosa; firmas anexadas más allá del threshold (U+R con una firma extra de S, y S+U con una extra de R) → el Guard clasifica sólo con los signers validados (A7); module, fallback o DELEGATECALL en camino asistido → revert (A8); SafeTx pendiente con nonce N invalidada por un NoOp con el mismo nonce (A13); swap con token o executor no registrados o `minOut` bajo el piso → revert (A16); el backend solo (sin firma de U) intenta un alta de whitelist → rechazo en backend, signer y on-chain (A18); pedido de co-firma de una segunda SafeTx distinta para el mismo (safe, nonce) sin reemplazo autorizado → el signer la rechaza (A19); al final, búsqueda de canarios de secretos en logs, DB y respuestas (A21).
      Verificación: `pnpm --dir e2e test acceptance/security-failures.spec.ts`.
- [ ] **P23.T03** — Reporte generado con tx hashes del fork, estados finales y tiempos.
      Verificación: `e2e/acceptance/report.md` generado y archivado (link en §13).

**Tests a implementar:**

- [ ] **P23.TST** — los anteriores.
      Verificación: `pnpm --dir e2e test:acceptance` (3 corridas).

**Checks manuales:**

- [ ] **P23.MAN** — leer el reporte y contrastar contra A1–A21.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** 3 corridas consecutivas verdes; cada assertion A1–A21 tiene al menos un paso del acceptance que la ejercita.

**Security checks:**

- [ ] **P23.SEC** — el reporte no contiene secretos.
      Verificación: `pnpm --dir e2e test acceptance/security-failures.spec.ts`.

**Commits:** `test(e2e): add full-system acceptance scenario on base fork`.

#### CHECKPOINT P23

- [ ] build pasa: `pnpm --dir e2e build`.
- [ ] tests pasan: `pnpm --dir e2e test:acceptance` (3 corridas).
- [ ] security tests pasan: `pnpm --dir e2e test acceptance/security-failures.spec.ts`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P24:** acceptance verde y reporte archivado en el Registro de ejecución.

---

### P24 — Observabilidad, audit trail y abuse prevention (cierre)

**Objetivo:** completar y verificar prompt §34–§36.

**Archivos/componentes:** `infra/monitoring/{prometheus-rules/*.yml,grafana-dashboards/*.json,alertmanager.yml}`, perfil compose `observability` (Prometheus, Alertmanager → Mailpit, Grafana) para probar alertas en local, `docs/runbooks/alerts/*.md`.

**Dependencias:** P23.

**Implementación requerida:**

- [ ] **P24.T01** — Reglas de alerta para todo [B-OBS] con umbrales y link a runbook; dashboards (API, cola, operaciones, RPC, signer, tx, saldos de S y gas tank, integridad, auditoría).
      Verificación: `promtool check rules infra/monitoring/prometheus-rules/*.yml` (vía imagen Docker fijada) y dashboards importan sin error en el perfil `observability`.
- [ ] **P24.T02** — Test de alertas en local: provocar cada condición (tx fallida/revertida, signer caído, RPC caído, operación atascada, reorg, S sin ETH con recarga fallida, gas tank bajo umbral, mismatch de integridad, desacuerdo RPC, verificación de auditoría fallida, liquidez/cotización del pool fuera de umbral) y verificar que llega la alerta a Mailpit.
      Verificación: `pnpm --dir e2e test specs/alerts` con el perfil compose `observability`.
- [ ] **P24.T03** — Completitud de auditoría: test que verifica que el acceptance run emitió cada `event_type` de [B-AUD]; `audit:verify` verde; export WORM (en local: archivo firmado).
      Verificación: `pnpm --dir e2e test specs/audit-completeness.spec.ts` y `pnpm --dir backend/app audit:verify`.
- [ ] **P24.T04** — Rate limits: test por cada fila de [B-RL] (por IP, usuario, sesión y Safe) + escenarios de abuso (credential stuffing, fuerza bruta de OTP, spam de whitelist, spam de operaciones, abuso de Swagger).
      Verificación: `pnpm --dir backend/app vitest run test/security/rate-limits-matrix.test.ts test/security/abuse.test.ts`.
- [ ] **P24.T05** — Redacción: tests de canario en todos los servicios (API, worker, signer, monitor, frontends en consola) y política de retención documentada.
      Verificación: `pnpm --dir backend/app vitest run test/observability` + specs de consola de frontends (`pnpm --dir e2e test specs/security/console-canary.spec.ts`).
- [ ] **P24.T06** — Monitoreo de dependencias externas: cambio de implementación del proxy de USDC, liquidez del pool canónico bajo umbral, desvío de cotización > 0,5 % (deshabilita swaps por policy), cambios de código en contratos fijados.
      Verificación: `pnpm --dir backend/app vitest run test/monitoring/external-deps.test.ts` contra el fork (cambio de implementación simulado con `anvil_setStorageAt` sólo en test).
- [ ] **P24.T07** — Alarmas del signer self-hosted: keystore ilegible o con MAC inválido, `credentialFingerprint` distinto al arrancar, archivo de keystore creado o borrado fuera del flujo (watcher del directorio), clave `BROKEN`, backup de keystores fallido o atrasado, ráfaga de rechazos por reglas estáticas.
      Verificación: `pnpm --dir backend/signer vitest run test/alarms.test.ts` y alerta recibida en Mailpit con el perfil `observability`.

**Tests a implementar:**

- [ ] **P24.TST** — los anteriores.
      Verificación: `pnpm --dir e2e test specs/alerts specs/audit-completeness.spec.ts`.

**Checks manuales:**

- [ ] **P24.MAN** — revisar dashboards con tráfico del acceptance.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** cada alerta exigida por el prompt §34 probada end-to-end en local.

**Security checks:**

- [ ] **P24.SEC** — nunca se loguean U, R, passwords, secretos, OTP completos ni secretos de sesión (canarios).
      Verificación: `pnpm --dir backend/app vitest run test/security/rate-limits-matrix.test.ts test/observability`.

**Commits:** `feat(observability): add alerts, dashboards and abuse controls`.

#### CHECKPOINT P24

- [ ] build pasa: `docker compose --profile observability config`.
- [ ] tests pasan: `pnpm --dir e2e test specs/alerts specs/audit-completeness.spec.ts`.
- [ ] security tests pasan: `pnpm --dir backend/app vitest run test/security/rate-limits-matrix.test.ts test/observability`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (runbooks de alertas).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P25:** todas las alertas probadas.

---

### P25 — Entornos y despliegue de staging sobre el fork

**Objetivo:** separar local/staging/producción (prompt §37), dejar listos los scripts de deploy/verificación para Base mainnet (prompt §39–§40) y **desplegar staging completo sobre el fork** con su configuración propia (Governance Safe, guardianes, deployer, policy). Nada se transmite a Base mainnet (R-09).

**Archivos/componentes:** `docs/ENVIRONMENTS.md`, `contracts/script/DeployBase.s.sol`, `contracts/script/verify-base.sh`, `contracts/deployments/schema.json`, `contracts/deployments/fork/staging.json` (los `base-mainnet*.json` se crean en el despliegue final), `config/policy/{staging,production}/*`.

**Dependencias:** P24; GitHub Actions activo (gate de P02); claves de ensayo de staging en `~/.config/mtw/` (fuera del repo).

**Implementación requerida:**

- [ ] **P25.T01** — Matriz de entornos (local / staging / production) en `docs/ENVIRONMENTS.md`: por entorno, proyecto de Docker Compose y directorio de secrets propios, DB y volúmenes, Valkey, clientes OAuth (proyectos Google distintos), shards del signer con keystores y credenciales de desbloqueo propios, secretos de sesión/CSRF/OPAQUE/pepper/field key/audit key, dominio de Mailgun, claves RPC, dominios, Governance Safe, guardianes, claves de release y de policy. **Nada se comparte entre staging y producción**; si conviven en un mismo host lo hacen como proyectos Compose separados (decisión de despliegue, no del planner).
      Verificación: `node scripts/check-docs.mjs` y revisión de un agente revisor independiente registrada en §13.
- [ ] **P25.T02** — `DeployBase.s.sol` [C-SCR-04]: keystore cifrado o hardware wallet, `--broadcast` explícito, `PolicyRegistry` en RESTRICTED con el set V1 [C-POL-04], registro de tokens y executor; escribe el JSON de deployment con, por contrato: address, `proxy: false` e `implementation: null` (ningún contrato propio usa proxy; se deja explícito), codehash, constructor args, compiler y settings, commit, deployer, tx hash, bloque, URL de verificación.
      Verificación: `forge script script/DeployBase.s.sol --fork-url $LOCAL_RPC_URL` (sin `--broadcast` a mainnet) genera el JSON válido contra `deployments/schema.json`.
- [ ] **P25.T03** — Ensayo con el mismo script usando una clave descartable o `anvil_impersonateAccount` + `VerifyDeployment.s.sol`. Las claves usadas en el fork (incluidas las de ensayo de staging/producción de `~/.config/mtw/keys/`) **nunca se reutilizan en Base mainnet**: el fork conserva chainId 8453 y una tx firmada en el fork sería válida en mainnet.
      Verificación: `forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL` OK tras el ensayo.
- [ ] **P25.T04** — `verify-base.sh`: `forge verify-contract --chain 8453 --watch` con `ETHERSCAN_API_KEY` (API V2) para cada contrato, incluido `RotationTimelock` (creado por el constructor del `SecurityGuard`: se verifica con `--constructor-args` = dirección del Guard); registra la URL de verificación de cada uno en el JSON; fallback a Sourcify si Etherscan falla.
      Verificación: `verify-base.sh --dry-run` genera el payload de cada contrato y `forge verify-bytecode --rpc-url $LOCAL_RPC_URL` confirma que coincide con lo desplegado en el fork (la verificación pública en BaseScan es parte del despliegue final).
- [ ] **P25.T05** — Governance Safe de staging (2-de-3) creada en el fork con los owners `GOVERNANCE_SAFE_OWNERS` y los guardianes `POLICY_GUARDIANS` de `~/.config/mtw/staging.env` (claves de ensayo generadas por el agente).
      Verificación: owners, threshold y guardianes leídos on-chain en el fork y registrados en §13.
- [ ] **P25.T06** — Deploy de **staging** sobre el fork con `DeployBase.s.sol` y el deployer de staging (fondeado con `anvil_setBalance`) → `VerifyDeployment.s.sol` → `deployments/fork/staging.json` → registro en §13.
      Verificación: `forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL` OK contra `deployments/fork/staging.json`.
- [ ] **P25.T07** — Snapshots de policy de staging y production (`config/policy/{staging,production}/`) con las direcciones desplegadas en el fork, firmados con la clave de policy de cada entorno (generada en `~/.config/mtw/secrets/<entorno>/`, fuera del repo).
      Verificación: `pnpm --dir backend/signer policy:verify config/policy/staging/policy-snapshot.json`.
- [ ] **P25.T08** — `system-contracts.staging.json` (y luego `production` en P30) generados desde los deployments para los builds de los frontends [F-SEC-08].
      Verificación: el build de staging de ambas apps embebe el archivo y su hash figura en el manifest.

**Tests a implementar:**

- [ ] **P25.TST** — test del JSON de deployment contra `schema.json`; test de que staging/producción tienen `mode == RESTRICTED` y exactamente el set V1.
      Verificación: `forge script script/DeployBase.s.sol --fork-url $LOCAL_RPC_URL && forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL`.

**Checks manuales:**

- [ ] **P25.MAN** — revisar cada transacción de deploy en el fork (`cast receipt` / `cast run`) contra `deployments/fork/staging.json`.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** staging desplegado y verificado sobre el fork con su configuración propia; scripts listos para Base mainnet.

**Security checks:**

- [ ] **P25.SEC** — ninguna private key en env (sólo keystores cifrados fuera del repo); claves de ensayo marcadas como no reutilizables en mainnet; `RESTRICTED` verificado; el deployer no conserva permisos.
      Verificación: test de configuración RESTRICTED + `bash ci/scripts/ci-security.sh`.

**Commits:** `feat(contracts): add deployment scripts and deploy staging on the Base fork`.

#### CHECKPOINT P25

- [ ] build pasa: `forge build`.
- [ ] tests pasan: `forge script script/DeployBase.s.sol --fork-url $LOCAL_RPC_URL && forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL`.
- [ ] security tests pasan: test de configuración RESTRICTED + `bash ci/scripts/ci-security.sh`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (`ENVIRONMENTS.md`).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P26:** staging desplegado y verificado sobre el fork.

---

### P26 — PRODUCTION READINESS (preparación para la VPS, sin desplegar)

**Objetivo:** dejar el producto listo para desplegarse **más adelante y a mano** en una VPS Linux estándar (target: Hostinger) — artefactos, configuración, scripts, runbooks y un ensayo completo en local — **sin acceder a la VPS ni configurar reverse proxy, DNS o TLS reales** (prompt §38, ADR-022, ADR-030, ADR-031). Ningún componente depende de un proveedor cloud.

**Archivos/componentes:** `infra/docker/{backend.Dockerfile,signer.Dockerfile,integrity-monitor.Dockerfile,web.Dockerfile,postgres.Dockerfile}`, `infra/production/{docker-compose.production.yml,docker-compose.wallet-web.yml,docker-compose.recovery-web.yml,.env.production.example,.env.wallet-web.example,.env.recovery-web.example,Caddyfile.wallet,Caddyfile.recovery,pgbackrest.conf.example,valkey.conf,alertmanager.yml.example,README.md}`, `scripts/deploy/{init-secrets.sh,deploy.sh,migrate.sh,healthcheck.sh,verify-images.sh}`, `scripts/backup/{pg-backup.sh,pg-restore.sh,signer-backup.sh,signer-restore.sh,audit-export.sh,config-backup.sh}`, `docs/DEPLOYMENT_VPS.md`, `docs/runbooks/{deploy.md,rollback.md,incident-response.md,key-rotation.md,backup-restore.md}`, `.github/workflows/wallet-release-artifacts.yml`.

**Dependencias:** P25.

**Implementación requerida:**

- [ ] **P26.T01** — **Dockerfiles** multi-stage con imagen base fijada por digest, usuario no-root con UID fijo por servicio, filesystem de sólo lectura y healthcheck: `backend` (api, worker, watcher, indexer y gas-tank comparten imagen con distinto comando), `signer`, `integrity-monitor`, `web` (Caddy 2.11.x sirviendo el bundle estático de una app con los headers de su `build/headers.json`; una imagen por app, sin TLS interno) y `postgres` (postgres 18.6 + pgBackRest 2.59.x).
      Verificación: `bash ci/scripts/build-images.sh` construye todas las imágenes y `node scripts/check-dockerfiles.mjs` confirma no-root, base por digest y healthcheck.
- [ ] **P26.T02** — Topología de §5.5 en tres archivos: `infra/production/docker-compose.production.yml` (host del backend: redes `edge`, `backend` y `signer`, estas dos `internal: true`; la red `backend` agrega una red de salida dedicada sólo para los servicios que llaman a RPC, email o al monitor), `infra/production/docker-compose.wallet-web.yml` y `infra/production/docker-compose.recovery-web.yml` (un contenedor estático cada uno, para servidores distintos); en todos: volúmenes nombrados, healthchecks, `restart: unless-stopped`, límites de recursos, `read_only`, `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, logging `local` con rotación, secrets por servicio (ADR-030) e imágenes **por digest** desde el `.env.production` de cada servidor; sólo la API y cada contenedor estático publican puertos, con binds configurables (`*_BIND`) para el reverse proxy de su servidor. **No incluye Nginx, TLS ni configuración de DNS.**
      Verificación: `docker compose config -q` de los tres archivos con su `.env.*.example` y `node scripts/check-compose-hardening.mjs` (sin `environment:` con secretos, signer sin `ports:`, redes internas correctas, cada compose de frontend con un único servicio estático).
- [ ] **P26.T02.a** — **Artefactos de release** en CI (GitHub Actions, aprobado): build reproducible de imágenes, SBOM (syft), escaneo Trivy, firma con `cosign` keyless (OIDC de GitHub, sin secretos guardados), push a GHCR por digest y `release/images.lock` con los digests; los frontends incluyen su manifest firmado con su clave de release. Sólo publica desde commits con todos los required checks en verde y **ningún job despliega a la VPS**.
      Verificación: corrida del workflow en el branch genera `images.lock`, SBOMs y firmas verificables con `cosign verify`; un commit con CI en rojo no publica.
- [ ] **P26.T03** — `infra/production/.env.production.example`: sólo variables **no secretas** (dominios, URLs públicas, binds, `TRUSTED_PROXY_CIDRS`, digests de imágenes, shards y parámetros) y la lista de archivos de secrets que cada servicio espera (`*_FILE`); todos los servicios leen secretos sólo por `*_FILE` en producción (P08.T02).
      Verificación: `node scripts/check-env-production.mjs` (cada variable del compose está documentada y ninguna es secreta).
- [ ] **P26.T04** — **Contrato con el reverse proxy de cada servidor** (sólo documentación en `DEPLOYMENT_VPS.md`; no se configura nada): hosts y rutas por servicio y servidor, terminación TLS en el proxy, reenvío de `X-Forwarded-For`/`X-Forwarded-Proto`, límites de body y timeouts, que **no** reescriba los headers de seguridad que emiten nuestros servicios, y cómo validarlo con `scripts/deploy/healthcheck.sh`.
      Verificación: `node scripts/check-docs.mjs` y revisión de la sección por un agente revisor independiente (registro en §13).
- [ ] **P26.T05** — **Migraciones**: `scripts/deploy/migrate.sh` ejecuta un contenedor efímero con el rol `mtw_migrator` (expand/contract) y verifica `db:status`.
      Verificación: en el ensayo local (P26.T16.b) `bash scripts/deploy/migrate.sh` aplica migraciones sobre una DB vacía y es idempotente en una segunda corrida.
- [ ] **P26.T06** — **PostgreSQL y Valkey self-hosted**: volúmenes persistentes; usuarios separados (superusuario sólo para bootstrap; `mtw_migrator`, `mtw_app`, `mtw_readonly`; roles por shard en `signer-postgres`); Valkey con AOF + RDB, `maxmemory-policy noeviction`, usuario ACL con los comandos que necesita BullMQ y usuario `default` deshabilitado; healthchecks; documentado que Postgres es la fuente de verdad y que el outbox re-encola si se pierde Valkey.
      Verificación: tests de compose del ensayo local (conexión con cada rol sólo a lo permitido; Valkey rechaza al usuario `default`; reinicio de Valkey sin pérdida de operaciones).
- [ ] **P26.T07** — **Backups** (ADR-031): `pgbackrest.conf.example` (full semanal, diferencial diario, WAL continuo, retención, repositorio cifrado; repo2 off-host que se define al desplegar), `signer-backup.sh` (keystores + DB del signer → `age`, sin la credencial), `audit-export.sh` (export diario firmado + `age`), `config-backup.sh` (compose, `.env.production` sin secretos, snapshots de policy, claves públicas); `docs/runbooks/backup-restore.md` con la copia off-host cifrada obligatoria.
      Verificación: cada script corre en el ensayo local y produce artefactos cifrados que sólo se abren con la clave privada de backup de prueba.
- [ ] **P26.T08** — **Restore test** en local: restaurar Postgres con PITR a un instante dado en un contenedor nuevo, `pnpm --dir backend/app audit:verify` y reconciliación contra el fork; restaurar un shard del signer y correr `restore-verify`; medir RTO/RPO.
      Verificación: reporte del restore (RTO/RPO medidos) registrado en §13.
- [ ] **P26.T09** — **Inyección de secretos** (ADR-030): `scripts/deploy/init-secrets.sh` genera en el host destino, al desplegar, todos los secretos generables (sesión, CSRF, emisor de PlatformSession, OPAQUE server setup, field key, OTP, pepper, audit, claves de atestación del signer y del monitor, CA y certificados mTLS, credencial de desbloqueo de cada shard, passwords de roles de DB y de Valkey) en `/etc/mtw/<entorno>/secrets/` y `/etc/mtw/<entorno>/signer-unlock/` (root, 0400), sin tocar el repo ni imágenes y sin sobrescribir lo existente.
      Verificación: en el ensayo local el script genera todo en `wallet/.secrets/prod-rehearsal/`, una segunda corrida no cambia nada y `node scripts/check-compose-secrets.mjs` confirma que ningún secreto llega por `environment:` ni está en una imagen.
- [ ] **P26.T10** — **Requisitos de DNS y TLS** documentados (sin configurar nada): hosts `wallet.` y `recovery.` en servidores distintos y sus hosts `api.` apuntando al host del backend; dominios registrables y cuentas de DNS distintos para Wallet y Recovery, o la aceptación escrita de RR-11 si se usan subdominios de un mismo dominio (CF-11); registros necesarios, CAA, 2FA en las cuentas de DNS, TLS en el reverse proxy de cada servidor y HSTS emitido por nuestros servicios.
      Verificación: `node scripts/check-docs.mjs` (sección presente en `DEPLOYMENT_VPS.md`).
- [ ] **P26.T11** — **Headers de seguridad** verificados en el ensayo local de producción (respuestas de `wallet-web`, `recovery-web` y API: CSP, Trusted Types, HSTS, COOP/COEP/CORP, Referrer-Policy, Permissions-Policy, nosniff).
      Verificación: `pnpm --dir e2e test specs/security/headers.spec.ts --config=prod-rehearsal`.
- [ ] **P26.T12** — **Monitoreo self-hosted**: perfil `observability` en el compose de producción (Prometheus, Alertmanager con email por el SMTP del dominio en Mailgun y webhook si se configura `ALERT_WEBHOOK_URL`, y Grafana) con las reglas y dashboards de P24.
      Verificación: en el ensayo local una alerta provocada llega al receptor de prueba (Mailpit).
- [ ] **P26.T13** — **Retención de logs**: driver `local` con rotación (tamaño y cantidad de archivos por servicio), logs de aplicación 90 días por defecto (configurable), exports de auditoría con retención de 7 años en la copia off-host (valor por defecto ajustable).
      Verificación: `node scripts/check-compose-hardening.mjs` verifica la configuración de logging de cada servicio.
- [ ] **P26.T14** — **Rotación de claves** (runbook + ensayo local): emisor de PlatformSession (kid con ventana dual), CSRF/sesión, pepper, field key, audit chain key, OPAQUE server setup (re-registro con `KEY_RESTORE`), Mailgun, RPC, claves de release (overlap en el monitor), clave de policy, S por Safe (timelock + firma del usuario), credencial de desbloqueo de shard (re-cifrado de keystores), gas tank, certificados mTLS.
      Verificación: cada rotación ejecutada en el ensayo local, registrada en §13.
- [ ] **P26.T15** — **Rollback**: volver al `images.lock` anterior (por digest), migraciones compatibles hacia atrás, frontends con la imagen anterior, contratos inmutables (nueva factory sólo para wallets nuevas).
      Verificación: ensayo local de deploy → rollback → deploy con `scripts/deploy/deploy.sh`, registrado en §13.
- [ ] **P26.T16** — **Procedimientos de incidente**: kill-switch de cooperación de S (comando firmado por dos operadores) y playbooks: **root del host del backend comprometido** (asumir comprometidas las S de sus shards y los secretos de Compose: activar el kill-switch, detener servicios, preservar evidencia, restablecer desde artefactos firmados y rotar S de todas las Safes vía timelock), **root del servidor de un frontend comprometido** (asumir JS malicioso en ese origin: pausar la cooperación de S, avisar a los usuarios que no desbloqueen esa clave, restablecer desde el manifest firmado), filtración de keystores del signer, compromiso del backend, proveedor RPC, blacklist de Circle sobre una Safe, incidente del bridge de USDT, caída de Google o Mailgun.
      Verificación: simulacro del kill-switch y del playbook de host comprometido en el ensayo local, registrado en §13.
- [ ] **P26.T16.a** — **Scripts de despliegue para uso manual posterior** y `docs/DEPLOYMENT_VPS.md` paso a paso (requisitos de cada servidor Linux —host del backend y servidores de Wallet y de Recovery—, usuarios y permisos, instalación de Docker, directorios de secretos, primer arranque, alta de shards, backups off-host, contrato con el reverse proxy de cada servidor, verificación): `deploy.sh` (verifica firmas `cosign` y digests de `images.lock`, migra, reinicia en orden y corre healthchecks), `healthcheck.sh`, `verify-images.sh`. **No se ejecutan contra ningún servidor de producción en ninguna fase de este planner.**
      Verificación: los scripts corren de punta a punta en el ensayo local (P26.T16.b) y `node scripts/check-docs.mjs` valida la guía.
- [ ] **P26.T16.b** — **Ensayo local del layout de producción**: levantar los tres compose (`docker-compose.production.yml`, `docker-compose.wallet-web.yml`, `docker-compose.recovery-web.yml`) en la máquina de desarrollo con secretos generados por `init-secrets.sh` en `wallet/.secrets/prod-rehearsal/`, imágenes de `images.lock` y RPC apuntando al fork de Base; correr el subconjunto de acceptance de P23 y los scripts de backup/restore.
      Verificación: `pnpm --dir e2e test:acceptance --config=prod-rehearsal` en verde.
- [ ] **P26.T17** — **Gates de producción** (se re-verifican en P30):
      Verificación: todas las subtareas `P26.T17.a–j` marcadas con evidencia enlazada.
  - [ ] **P26.T17.a** — `CODEOWNERS` por trust domain y branch protection con revisión del equipo del dominio, "include administrators" y commits firmados activos.
  - [ ] **P26.T17.b** — evaluación documentada de separar Wallet, Recovery y backend en repositorios propios (decisión registrada; no bloquea la implementación).
  - [ ] **P26.T17.c** — CI con required checks y artefactos de release firmados (sin deploy desde CI).
  - [ ] **P26.T17.d** — Node 26 LTS fijado en todos los proyectos e imágenes.
  - [ ] **P26.T17.e** — `PolicyRegistry` en RESTRICTED con exactamente el set V1 en los deploys de staging y producción sobre el fork.
  - [ ] **P26.T17.f** — integrity monitor fail-closed y chequeo off-host activos.
  - [ ] **P26.T17.g** — backups y restore ensayados (Postgres PITR, keystores del signer, auditoría) y custodia offline de las credenciales de desbloqueo documentada.
  - [ ] **P26.T17.h** — ensayo local del layout de producción en verde (P26.T16.b).
  - [ ] **P26.T17.i** — `DEPLOYMENT_VPS.md` y runbooks completos.
  - [ ] **P26.T17.j** — riesgos residuales del host del backend (CF-10, RR-01) y de la separación de hosting y DNS de los frontends (CF-11: RR-16 y RR-11) documentados en `THREAT_MODEL.md` y entregados a P27.

**Tests a implementar:**

- [ ] **P26.TST** — `docker compose ... config -q`, `check-compose-hardening`, `check-compose-secrets`, `check-env-production`, headers y acceptance del ensayo local, restore test.
      Verificación: `pnpm --dir e2e test:acceptance --config=prod-rehearsal` + restore test (P26.T08).

**Checks manuales:**

- [ ] **P26.MAN** — un agente revisor independiente recorre `DEPLOYMENT_VPS.md`, los permisos de los directorios de secretos y la separación de redes del compose.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** todo lo listado en prompt §38 queda preparado o ensayado en local; ningún componente depende de un proveedor cloud; ningún paso requiere acceso a la VPS.

**Security checks:**

- [ ] **P26.SEC** — imágenes sin High/Critical (Trivy); contenedores no-root y de sólo lectura; secretos sólo por archivos; credenciales de desbloqueo separadas de los keystores; signer sin puertos publicados y en red interna.
      Verificación: Trivy sin High/Critical + `node scripts/check-compose-hardening.mjs && node scripts/check-compose-secrets.mjs && bash ci/scripts/ci-security.sh`.

**Commits:** `feat(infra): add self-hosted production layout`, `docs(wallet): add vps deployment guide`.

#### CHECKPOINT P26

- [ ] build pasa: `bash ci/scripts/build-images.sh` y `docker compose config -q` de los tres compose de `infra/production/` con sus `.env.*.example`.
- [ ] tests pasan: `pnpm --dir e2e test:acceptance --config=prod-rehearsal` + restore test (P26.T08).
- [ ] security tests pasan: Trivy sin High/Critical + `node scripts/check-compose-hardening.mjs && node scripts/check-compose-secrets.mjs && bash ci/scripts/ci-security.sh`.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (`DEPLOYMENT_VPS.md` y runbooks).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P27:** gates de P26.T17 cumplidos (los que dependen de la auditoría se cierran en P28/P30).

---

### P27 — SECURITY AUDIT

**Objetivo:** auditoría adversarial completa (prompt §41) → `wallet/docs/SECURITY_AUDIT.md`.

**Archivos/componentes:** `wallet/docs/SECURITY_AUDIT.md`, `wallet/docs/THREAT_MODEL.md` (versión final), `contracts/test/adversarial/audit/*.t.sol`, `wallet/e2e/acceptance/attacks/*.spec.ts`, resultados de herramientas en `wallet/docs/security/audit-artifacts/`.

**Dependencias:** P26.

**Implementación requerida:**

- [ ] **P27.T01** — Re-ejecutar todas las herramientas (forge test/coverage/invariants, Slither, Semgrep, OSV, gitleaks, Trivy, zizmor) y adjuntar resultados.
      Verificación: artefactos de herramientas archivados en `docs/security/audit-artifacts/`.
- [ ] **P27.T02** — Revisión manual por clase de ataque; para cada clase: intentos concretos (tests nuevos en `contracts/test/adversarial/audit/` o `e2e/acceptance/attacks/`), evidencia y conclusión en `SECURITY_AUDIT.md`.
      Verificación: cada subtarea tiene sección propia en `SECURITY_AUDIT.md` con tests enlazados en verde.
  - [ ] **P27.T02.a** — drain y takeover.
  - [ ] **P27.T02.b** — bypass de S y bypass del Guard.
  - [ ] **P27.T02.c** — bypass de whitelist.
  - [ ] **P27.T02.d** — bypass del timelock de rotación.
  - [ ] **P27.T02.e** — replay y carreras de nonce.
  - [ ] **P27.T02.f** — confusión de firmas (tipos de firma, EIP-1271/7702, low-s, orden).
  - [ ] **P27.T02.g** — calldata de swap maliciosa y abuso de allowances.
  - [ ] **P27.T02.h** — compromiso del backend (incluye alteración de DB y de la cola).
  - [ ] **P27.T02.i** — compromiso del frontend U.
  - [ ] **P27.T02.j** — compromiso del frontend R.
  - [ ] **P27.T02.k** — compromiso del signer (un shard: keystores + credencial de desbloqueo; y root del host del backend, CF-10) y del servidor de un frontend.
  - [ ] **P27.T02.l** — manipulación de RPC.
  - [ ] **P27.T02.m** — reorgs.
- [ ] **P27.T03** — Cada finding con el formato del prompt: `ID`, `Severity` (Critical/High/Medium/Low/Informational), `Title`, `Component`, `Description`, `Attack prerequisites`, `Step-by-step exploitation`, `Impact`, `Evidence` (test, tx en fork, logs), `Recommended fix`, `Recommendation` (MUST FIX / SHOULD FIX / ACCEPTABLE RISK).
      Verificación: `node scripts/check-audit-format.mjs` (todos los campos obligatorios por finding).
- [ ] **P27.T04** — Filtro obligatorio: cada finding se contrasta contra el threat model y contra los comportamientos deliberados de §2.3; no se incluyen findings genéricos.
      Verificación: revisión cruzada de cada finding contra §2.3 y el threat model, registrada en `SECURITY_AUDIT.md`.

**Tests a implementar:**

- [ ] **P27.TST** — un test de reproducción por finding (o justificación de por qué no es reproducible).
      Verificación: `pnpm ci:local && pnpm --dir e2e test:acceptance`.

**Checks manuales:**

- [ ] **P27.MAN** — revisión independiente del documento por un agente revisor (contexto nuevo); el owner lo recibe en el paquete de go-live.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** documento completo y trazable a evidencia.

**Security checks:**

- [ ] **P27.SEC** — el propio documento no contiene secretos ni datos de usuarios.
      Verificación: re-ejecución de todas las herramientas (P27.T01).

**Commits:** `docs(security): add adversarial security audit`.

#### CHECKPOINT P27

- [ ] build pasa: `pnpm ci:local`.
- [ ] tests pasan: `pnpm ci:local && pnpm --dir e2e test:acceptance`.
- [ ] security tests pasan: re-ejecución de todas las herramientas (P27.T01).
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-audit-format.mjs && node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P28:** auditoría publicada en el branch.

---

### P28 — SECURITY REMEDIATION (gate)

**Objetivo:** prompt §42: corregir, re-testear, re-auditar y documentar riesgos residuales antes de declarar production-ready.

**Archivos/componentes:** código afectado por cada finding (contracts, backend, signer, frontends, infra), tests de regresión nuevos, `wallet/docs/SECURITY_AUDIT.md` (estado de cada finding y `#residual-risks`).

**Dependencias:** P27.

**Implementación requerida:**

- [ ] **P28.T01** — Corregir todo MUST FIX; cada fix con test de regresión que reproducía el finding.
      Verificación: cada fix con su test de regresión en verde (`pnpm ci:local`).
- [ ] **P28.T02** — Retest completo (CI + acceptance P23) y **re-ejecutar la auditoría** (P27.T01–T02) sobre los cambios.
      Verificación: `pnpm ci:local` + `pnpm --dir e2e test:acceptance` + re-ejecución de P27.T01 sin nuevos Critical/High.
- [ ] **P28.T03** — Documentar riesgos residuales en `SECURITY_AUDIT.md#residual-risks` (incluye la decisión registrada sobre CF-01, el host del backend de producción (CF-10), la separación de hosting y DNS de los frontends (CF-11, RR-16 y RR-11), la dependencia del USDT bridged y del bridge de Base, Circle, la liquidez de Uniswap y la deprecación del flujo OAuth elegido).
      Verificación: `SECURITY_AUDIT.md#residual-risks` completo y revisado por un agente revisor independiente.
- [ ] **P28.T04** — Gate automático: **no production-ready** mientras exista un Critical o High abierto. Durante la ejecución no hay excepciones: todo Critical/High se remedia; si alguno no se puede remediar es un STOP real.
      Verificación: 0 Critical/High abiertos.

**Tests a implementar:**

- [ ] **P28.TST** — un test de regresión por finding corregido (debe fallar antes del fix y pasar después); re-ejecución completa de P07, P13, P22 y P23.
      Verificación: `pnpm ci:local && pnpm --dir e2e test:acceptance`.

**Checks manuales:**

- [ ] **P28.MAN** — un agente revisor independiente re-verifica la lista final de findings y riesgos residuales; la firma del owner sobre los riesgos residuales es un paso del despliegue final (`go-live.md`).
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** 0 Critical/High abiertos (o decisión documentada); re-auditoría sin nuevos Critical/High.

**Security checks:**

- [ ] **P28.SEC** — re-ejecución de todas las herramientas de P27.T01 sobre el código corregido; verificación de que ningún fix relajó CSP/TT, policy RESTRICTED, reglas del Guard o del signer.
      Verificación: re-auditoría (P27.T01–T02) sin nuevos Critical/High.

**Commits:** `fix(security): remediate audit findings`, `docs(security): document residual risks`.

#### CHECKPOINT P28

- [ ] build pasa: `pnpm ci:local`.
- [ ] tests pasan: `pnpm ci:local && pnpm --dir e2e test:acceptance`.
- [ ] security tests pasan: re-auditoría (P27.T01–T02) sin nuevos Critical/High.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P29:** gate cumplido.

---

### P29 — Documentación final, trazabilidad y release candidate

**Objetivo:** prompt §43–§44 y cierre: documentación final, trazabilidad completa con evidencia y release candidate.

**Archivos/componentes:** `wallet/README.md`, `wallet/docs/HOW_IT_WORKS.md`, `wallet/docs/openapi/v1.json`, `wallet/tools/sovereign-exit/README.md`, §12 y §13 de este planner, release notes.

**Dependencias:** P28.

**Implementación requerida:**

- [ ] **P29.T01** — `wallet/README.md` con: qué es el sistema, arquitectura, requisitos, setup local, env, Base fork, database, contracts, backend, frontend Wallet, frontend Recovery, tests, build, production deploy, troubleshooting; enlaces a `/docs` (Swagger) con cómo autenticarse y probar la API (cookie + CSRF + `dev:session` para endpoints críticos).
      Verificación: un clon limpio sigue el README hasta `pnpm dev` sin pasos extra (registro en §13).
- [ ] **P29.T02** — `wallet/docs/HOW_IT_WORKS.md` (corto, lenguaje simple): qué es U, qué es R, qué es S, cómo se forma la Safe, cómo se firma una operación, qué hace S, cómo funciona la whitelist, cómo funciona send, cómo funciona swap, cómo funciona recovery, por qué sigue siendo self-custodial.
      Verificación: `node scripts/check-docs.mjs` y lectura por alguien ajeno al desarrollo (registro en §13).
- [ ] **P29.T03** — OpenAPI generado desde código actualizado y versionado (`docs/openapi/v1.json`) con test de que coincide con el runtime.
      Verificación: `pnpm --dir backend/app vitest run test/api/openapi-snapshot.test.ts`.
- [ ] **P29.T04** — Guía de salida soberana (`tools/sovereign-exit/README.md`): cómo operar U+R sin la plataforma (Recovery modo soberano, o Safe{Wallet}/herramientas estándar con claves exportadas desde los backups) y cómo descifrar los sobres offline.
      Verificación: `node scripts/check-docs.mjs` y ensayo del procedimiento con `tools/sovereign-exit` en el fork.
- [ ] **P29.T05** — Revisión final de §12 (todas las filas con evidencia: fase, tarea, test) y del Registro de ejecución.
      Verificación: `node scripts/check-docs.mjs` (toda fila de §12 con evidencia).
- [ ] **P29.T06** — Release candidate: tag `wallet-v1.0.0-rc.1` y release notes; el push del tag está aprobado por el owner (2026-10-17) y se hace cuando todos los gates están verdes.
      Verificación: tag pusheado (`git ls-remote --tags origin wallet-v1.0.0-rc.1`) y release notes publicadas.

**Tests a implementar:**

- [ ] **P29.TST** — test de que `docs/openapi/v1.json` coincide con la spec generada en runtime; test de links internos de la documentación (sin anclas rotas); ejecución de los comandos del README desde un clon limpio (`docker compose up -d && pnpm install && pnpm preflight && pnpm dev`).
      Verificación: `pnpm --dir backend/app vitest run test/api/openapi-snapshot.test.ts`.

**Checks manuales:**

- [ ] **P29.MAN** — un agente revisor independiente, sin contexto del desarrollo, sigue el README y `HOW_IT_WORKS.md` desde un clon limpio en un contenedor nuevo y levanta el entorno sin ayuda.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** documentación completa; trazabilidad 100 % con evidencia.

**Security checks:**

- [ ] **P29.SEC** — la documentación no contiene secretos, direcciones de claves de producción ni datos de usuarios; gitleaks sobre la historia completa del branch.
      Verificación: `gitleaks git --redact` sobre la historia completa del branch.

**Commits:** `docs(wallet): add final documentation and how it works`.

#### CHECKPOINT P29

- [ ] build pasa: `pnpm ci:local`.
- [ ] tests pasan: `pnpm --dir backend/app vitest run test/api/openapi-snapshot.test.ts`.
- [ ] security tests pasan: `gitleaks git --redact` sobre la historia completa del branch.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs`.
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P30:** release candidate con todos los gates verdes y el tag pusheado.

---

### P30 — PRODUCTION READINESS: GATE FINAL, PRODUCCIÓN SOBRE EL FORK Y PAQUETE DE GO-LIVE

**Objetivo:** cerrar el planner con la fase de PRODUCTION READINESS (prompt §38, CF-09): re-verificar **todos** los gates después de auditoría, remediación y documentación, desplegar y probar **producción completa sobre el fork** y dejar listo el paquete del despliegue final (`docs/runbooks/go-live.md`). El despliegue real en Base mainnet y en la VPS es manual y queda fuera del planner (R-09, R-14).

**Archivos/componentes:** `contracts/deployments/fork/production.json`, `infra/production/*`, `release/images.lock`, `config/policy/production/*`, `docs/runbooks/go-live.md`, §13 de este planner (evidencia).

**Dependencias:** P29 (y P26–P28 completos).

**Implementación requerida:**

- [ ] **P30.T01** — Re-verificar los gates de P26.T17.a–j, el gate de P28.T04 (sin Critical/High abiertos) y que CI esté verde en el commit candidato.
      Verificación: checklist de `docs/runbooks/go-live.md` completo con links a evidencia; `gh run list --branch <rama-de-release>` muestra todos los required checks en verde.
- [ ] **P30.T02** — Deploy de contratos de **producción** sobre el fork con `DeployBase.s.sol`, el deployer y la Governance Safe 2-de-3 de ensayo de `~/.config/mtw/production.env` (creada en el fork), `VerifyDeployment.s.sol` y `forge verify-bytecode` → `deployments/fork/production.json` completo (address, implementation `null`/proxy `false`, compiler, settings, commit, codehash).
      Verificación: `forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL` OK contra `deployments/fork/production.json`.
- [ ] **P30.T03** — `PolicyRegistry` de producción en RESTRICTED con exactamente el set V1, Governance Safe y guardianes de ensayo configurados; snapshot de policy de producción firmado con su clave de policy (fuera del repo).
      Verificación: test de configuración de P25 ejecutado contra el deploy de producción en el fork (`mode == RESTRICTED`, permisos exactos).
- [ ] **P30.T04** — Ensayo de producción completo en local: los tres compose de `infra/production/` contra el fork, con `system-contracts.production.json` generado desde `deployments/fork/production.json`, imágenes de release por digest de `images.lock` firmadas con cosign y frontends construidos con dominios de ensayo (`*.mtw.test` resueltos localmente); headers, integridad (monitor local y el script del chequeo off-host contra el ensayo), alertas a Mailpit y backups/restore.
      Verificación: tests de headers, integridad, alertas y restore en verde contra el ensayo; evidencia en §13.
- [ ] **P30.T05** — Smoke test de producción sobre el ensayo, automatizado con Playwright y la API (mismos pasos que el smoke real de `go-live.md`): onboarding con Drive real (cliente Drive contra la API real con el mecanismo de P22.T04, porque la pantalla de consentimiento de Google no se puede automatizar) y email real, recepción, whitelist (24 h con warp), send, swap ida y vuelta contra el pool real del fork, cancelación de rotación y ejecución soberana U+R.
      Verificación: `pnpm --dir e2e test --project=production-rehearsal` en verde; tx hashes del fork en §13.
- [ ] **P30.T06** — `docs/runbooks/go-live.md` completo con el despliegue final paso a paso: configuración de los servicios de staging/producción para los dominios reales (§13.1), aprobación escrita del owner, claves nuevas para Base mainnet (hardware wallets recomendadas; **nunca** las de ensayo del fork), deploy y verificación pública en BaseScan con `verify-base.sh` y `ETHERSCAN_API_KEY`, Governance Safe y guardianes reales, re-firma offline del snapshot de policy, build de los frontends con los dominios reales, despliegue del backend en la VPS y de cada frontend en su servidor según `DEPLOYMENT_VPS.md` (cuentas de hosting y de DNS distintas para Wallet y Recovery, o la aceptación escrita del owner de RR-16/RR-11 por CF-11), fondeo del gas tank, smoke test real (incluido un celular real y la verificación de que los emails llegan a la bandeja de entrada, no a spam, con el dominio propio y SPF, DKIM y DMARC), apertura controlada con monitoreo de 7 días y criterio de rollback, y firma del owner sobre los riesgos residuales.
      Verificación: `node scripts/check-docs.mjs` (`go-live.md`) y revisión de un agente revisor independiente registrada en §13.

**Tests a implementar:**

- [ ] **P30.TST** — tests de configuración de producción (policy, roles, codehash de contratos propios y externos) contra el deploy del fork y smoke de P30.T05.
      Verificación: tests de configuración de producción + smoke P30.T05.

**Checks manuales:**

- [ ] **P30.MAN** — un agente revisor independiente recorre `go-live.md` contra el ensayo de P30.T04–T05 y confirma que cada paso es ejecutable tal como está escrito.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** producción desplegada y probada completa sobre el fork, todos los gates cumplidos y el paquete de go-live listo; sólo queda el despliegue final, fuera del planner.

**Security checks:**

- [ ] **P30.SEC** — `VerifyDeployment` contra el deploy del fork; integrity monitor en verde; ninguna clave en env; RESTRICTED verificado; kill-switch de cooperación probado en el ensayo con una Safe de prueba.
      Verificación: integrity monitor en verde + kill-switch probado en el ensayo.

**Commits:** `chore(release): record production rehearsal on the fork`, `docs(wallet): add go-live runbook`.

#### CHECKPOINT P30

- [ ] build pasa: `forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL`.
- [ ] tests pasan: tests de configuración de producción + smoke P30.T05.
- [ ] security tests pasan: integrity monitor en verde + kill-switch probado en el ensayo.
- [ ] integración anterior sigue funcionando: `pnpm ci:local`.
- [ ] documentación actualizada: `node scripts/check-docs.mjs` (`go-live.md`).
- [ ] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [ ] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición de cierre:** todas las casillas de P00–P30 marcadas; lo único pendiente es el despliegue final de `go-live.md`, fuera del planner (R-09, R-14).

---

## 12. REQUIREMENTS TRACEABILITY

Mapa de cada requisito importante del prompt (`wallet/prompts/promptV1.md`, secciones §1–§47 y nota final) y de la V9 contra la parte del planner que lo especifica y la fase/tarea que lo implementa y verifica. En P29.T05 cada fila debe tener evidencia (test o documento).

| ID | Requisito | Origen | Especificación | Implementación / verificación |
|---|---|---|---|---|
| RQ-01 | Trabajar en `feat/walletWeb/cmarchese`; crear si no existe | §1 | §0.1 R-01, §1 | Preparación (branch creado) · RES-1 |
| RQ-02 | Commits profesionales, sin Claude/Anthropic/AI/Co-Authored-By | §1, §46 | §0.1 R-07, §0.5 | todas las fases (sección "Commits") |
| RQ-03 | No modificar trabajo no relacionado; todo dentro de `wallet/`; `documentacion/` sólo lectura | §1, nota final | §0.1 R-02, §1, CF-06 | CHECKPOINT P00 (diff fuera de `wallet/` vacío) |
| RQ-04 | Planner con fases, tareas concretas, checkboxes y campos obligatorios por fase | §2, §45 | §0.2, §11 | todas las fases |
| RQ-05 | Reanudable desde el último punto con chequeo de los últimos ítems | nota final | §0.3 RES-1…7, §0.2 (toda tarea con `Verificación:`), §13 | P01.T06.a (`check-docs.mjs` exige `Verificación:` en cada tarea) |
| RQ-06 | V9 leída y autoritativa | §3 | §2.1, §3–§9 | — |
| RQ-07 | Safe 2-de-3 U/R/S; flujos U+S, R+S, U+R; S nunca origina intención | §3, V9 §1 | §5.1, §6.4, ADR-003/004 | P05, P07 (A1–A6) |
| RQ-08 | Tres trust domains independientes; Wallet y Recovery apps separadas, builds separados, sin runtime compartido con U/R | §3, §4, V9 §2/§17 | §5.1–§5.2, ADR-001/010/011, CF-01 | P16 (T02, T08), P19.T02, P26.T17 |
| RQ-09 | Guard inmutable; clasificación sólo con signers validados por Safe | §3, V9 §9, A7 | [C-PAR], [C-GRD-03] | P04.T02, P05.T02, P07.T01 |
| RQ-10 | Camino asistido: CALL, gas params 0, gasToken/refundReceiver 0, sin DELEGATECALL; U+R no bloqueado por políticas | §3, V9 §9/§10 | [C-GRD-03] pasos 3–5, ADR-004 | P07.T01.b, P07.T01.d, P07.T02 (invariante), P05.T06 |
| RQ-11 | modules = none, DenyAllModuleGuard, fallback = 0; U+R puede cambiarlos | §3, V9 §10 | [C-MGD], [C-BST], [C-GRD-03] paso 6 | P04.T06, P05.T06 (cambios soberanos + fail-closed), P07.T01.c |
| RQ-12 | WalletFactory inmutable con configuración fijada (release, singleton, proxy factory, codehash, bootstrap, threshold, guard, module guard, timelock, registry, fallback 0, payment 0, executor S) | §3, V9 §16 | [C-FAC], §3.2 | P05.T04 |
| RQ-13 | Deploy + init atómicos; frontend calcula/verifica la Safe y comprueba on-chain antes de ACTIVE | §3, V9 §16, A11 | [C-FAC-05], [C-GRD-01] (sólo Safes de la factory), [F-SEC-08], [B-SIG-07] | P12.T03–T07, P16.T09, P18.T01–T02 |
| RQ-14 | Rotaciones asistidas propose → 48 h → execute; U o R cancelan individualmente; U+R soberano | §3, V9 §14 | [C-RTL], [C-GRD-11/12], ADR-007, [B-SIG-02] (S sólo hacia claves propias, `KeyAcceptance`) | P05.T01, P11.T03, P15, P18.T09, P19.T05 |
| RQ-15 | Backend y Signer validan independientemente; PolicyRegistry; BOOTSTRAP sólo dev; **gate de producción RESTRICTED/default DENY** | §3, V9 §11 | [C-POL], [B-POL], ADR-005 | P04.T04, P11.T03, P13.T10, P07.T09 (suites en RESTRICTED), P23.T01 (acceptance en RESTRICTED), P26.T17.e, P30.T04 |
| RQ-16 | Sólo operaciones explícitamente soportadas; sin ejecución genérica | §3 | [B-POL-03], [C-GRD-13] | P11.T03, P14, P07.T01 |
| RQ-17 | Salida de valor sólo a destinos whitelisteados, enforcement final on-chain, falla aunque el frontend la construya | §3, §10, §11, A9 | [C-WHL], [C-GRD-06] | P04.T05, P07.T01.a, P14.TST.a (tres capas), P23.T01.f |
| RQ-18 | Autoridades económicas indirectas (approve, increaseAllowance, Permit2, setApprovalForAll, operators) tratadas como salida; sin approvals persistentes genéricos | §3, V9 §12, A10 | [C-DEC-03], [C-GRD-07/08], ADR-015 | P06, P07.T01 |
| RQ-19 | Frontend: sin third-party JS, sin analytics/GTM, sin service workers, CSP estricta, Trusted Types, deps fijadas, builds reproducibles, release manifests | §3, V9 §17 | [F-SEC], ADR-023 | P16, P20, P22.T03 |
| RQ-20 | Áreas `contracts/`, `backend/`, `frontend/wallet`, `frontend/recovery` separadas | §4 | §5.2 | P01.T03 |
| RQ-21 | Stack inspeccionado y justificado; versiones verificadas en fuentes oficiales y fijadas exactas | §5 | §1, §3.6, ADR-009/011/027/028 | P01.T01–T02 |
| RQ-22 | Fork de Base con `BASE_RPC_URL`, `FORK_BLOCK_NUMBER` fijo, `CHAIN_ID` | §6 | §3.1, `.env.example` | P00.T02–T03, P03 |
| RQ-23 | Scripts `start-fork`, `stop-fork`, `reset-fork`, `deploy-local`, `seed-local` | §6 | §5.2 | P00.T03, P07.T07 |
| RQ-24 | Contratos reales del fork (USDC, USDT, Uniswap, Safe); sin tokens falsos; impersonación sólo en tests | §6, §27 | §3.2–§3.4, §10 regla 1 | P03.T03, P07.T07, P21.T04 |
| RQ-25 | Auth: create, login, logout, forgot, reset, session management/expiry/revocation | §7 | [B-AUTH] | P09, P17.T03, P22.T02 |
| RQ-26 | Cuenta independiente de U/R; password de login ≠ Password U; reset no descifra U | §7, V9 §3 | CF-02, ADR-008, [B-AUTH-07] | P09.T04 (test), P17.T03 |
| RQ-27 | Wallet: Safe address, copiar, balances, historial/estado; recibir USDC en la Safe | §7 | [F-UI], [B-FIN-03] indexer | P18.T03, P18.T08, P13.T07, P22.T02 |
| RQ-28 | Assets USDC/USDT con balance, símbolo, decimales, contrato leídos del fork | §7 | [F-UI] `/assets` | P18.T04 |
| RQ-29 | U secp256k1 por CSPRNG; Password U independiente; Argon2id + AES-256-GCM; descifrada sólo para firmar | §8, V9 §4 | [F-KEY-01..05] | P17.T04–T06 |
| RQ-30 | U nunca al backend ni en claro en DB/logs/localStorage/analytics/observabilidad | §8 | [F-KEY-07], [B-OBS] | P17 security checks, P22.T03, P24.T05 |
| RQ-31 | Drive appDataFolder directo desde frontend, backup cifrado, export manual, backup humano | §8, V9 §4/§5 | [F-KEY-06], [F-DRV], ADR-012 | P17.T02, P17.T05, P19.T03 |
| RQ-32 | Recovery app con R independiente (password y storage propios) o wallet externa (wagmi, WalletConnect, injected, MetaMask, Coinbase) | §9, V9 §5 | [F-CON], [F-KEY-09] | P19.T02–T03, P19.T07 |
| RQ-33 | R para recuperar/cambiar U, cancelar rotaciones y operar soberanamente con U; no cotidiana | §9 | [C-GRD-11], [F-UI] Recovery | P19.T04–T06 |
| RQ-34 | Onboarding integrado Wallet → Activate Recovery → QR/link → Recovery → crear/importar R → enrollment → volver a Wallet | §9, V9 §6 | §5.4, [F-LNK], [F-KEY-10] | P12.T02–T03, P18.T01, P19.T03, P19.T08 (importar R) |
| RQ-35 | `DestinationWhitelist` con `isWhitelisted(safe, destination)` | §10 | [C-WHL-03] | P04.T05 |
| RQ-36 | Proceso de whitelist con challenge ligado a userId/Safe/chainId/destination/action/nonce/expiresAt; single-use, expirable, auditable, idempotente; backend solo no puede falsificar | §10, V9 §12 | [B-DB] security_challenges, ADR-006, A18 | P14.T01–T02 |
| RQ-37 | Send con token/destino/monto/review/confirm; destinos desde whitelist; backend reconstruye SafeTxHash y valida policy/whitelist/balance/nonce; signer revalida; Guard final | §11 | [B-Q-02], [B-POL-05], [B-SIG], [C-GRD-06] | P13.T10, P14.T03, P18.T06, P11.T03 |
| RQ-38 | Swap sólo USDC↔USDT en Base con contratos oficiales verificados (address + codehash documentados) | §12 | §3.4, `EXTERNAL_CONTRACTS.md` | P03, P06 |
| RQ-39 | Sin calldata arbitraria de Uniswap; análisis y elección del diseño de menor riesgo (SwapExecutor) | §12 | ADR-015, [C-SWP], CF-04 | P06.T01, ADR-015 escrito en P06 |
| RQ-40 | Approve exacto → swap → allowance 0; Permit2/autorización persistente en threat model; resultado siempre a la Safe | §12 | [C-GRD-09], [C-SWP-02/03], A15/A16 | P06.T03, P14.T05 |
| RQ-41 | Tabla `wallet_operations` con los campos pedidos; nunca claves privadas | §13 | [B-DB] | P08.T03 |
| RQ-42 | Estados explícitos, máquina de estados y auditoría de transiciones | §13 | [B-SM] | P13.T01 |
| RQ-43 | U → backend → DB → cola → worker S con los 12 pasos; firma S nunca antes de completar checks | §14 | [B-Q-02], [B-SIG] | P13.T04, P11.T03 |
| RQ-44 | Análisis de batching con justificación | §14 | ADR-019, CF-05 | P13.T09 |
| RQ-45 | Nonce: evitar doble ejecución, carreras, nonce duplicado, fuera de orden; locking en DB; cancelación por mismo nonce | §15 | [B-NONCE], ADR-020, estado `CANCEL_REQUESTED` | P13.T02, P13.T08, P13.TST.b–c, P13.TST.i |
| RQ-46 | SUBMITTED/MINED/CONFIRMED, política de confirmaciones para Base, reorg/receipt desaparecido/hash cambiado/replaced/dropped/RPC inconsistente, reconciliación | §16 | [B-FIN], ADR-018 | P13.T06–T07 |
| RQ-47 | RPC primario/secundario con health checks; decisiones sensibles no basadas en respuestas inconsistentes | §17 | [B-RPC], ADR-017 | P08.T05 |
| RQ-48 | S por Safe; nunca en claro en DB/.env/logs/código; dev signer; signer de producción; `SignerProvider`; arquitectura Backend → Policy → Signer Service → aislado; migración a HSM | §18, V9 §7 | [B-SIG-04], [B-SIG-08], [B-SIG-09], ADR-014 (Clef sin mantenimiento; Web3Signer evaluado; `SelfHostedSoftwareSignerProvider`) | P11 (T01, T06–T08, T10), P15.T09, P24.T07 |
| RQ-49 | API `/api/v1` con endpoints de auth, users, wallet, balances, whitelist, send, swap, operations, recovery, rotations, sessions, health; request/response/error schemas, auth, authz, rate limits, idempotencia | §19 | [B-API], [B-API-SCH], [B-AUTHZ], [B-RL] | P08–P15 (tests IDOR por grupo de [B-AUTHZ]) |
| RQ-50 | Swagger en `/docs`, todos los endpoints documentados, prueba en dev, sin admin sensible expuesto en prod | §20, §44 | §7.11 | P08.T09, P10.T07 |
| RQ-51 | Tablas de §21, migraciones, constraints, FKs, índices únicos, límites transaccionales, backup/restore | §21 | [B-DB] | P08.T03–T04, P26.T07–T08 |
| RQ-52 | Auth production-grade (hashing fuerte, cookies HttpOnly/Secure/SameSite, rotación, CSRF, logout, reset single-use, OTP expiry, brute force, rate limit, lock) y sin tokens en localStorage | §22 | [B-AUTH], [F-SES] | P09 (P09.TST.a–f), P16.T03 (lint), P22.T03 (storage sin tokens) |
| RQ-53 | Proveedor de email real con credenciales documentadas; emails sensibles muestran acción, address, red y expiración | §23 | [B-MAIL], ADR-016 | P09.T07, `SETUP_EXTERNAL_SERVICES.md` |
| RQ-54 | `.env.example` completo sin secretos, `.env` local con placeholders, gitignored; `SETUP_EXTERNAL_SERVICES.md` por variable | §24 | — | Preparación (archivos creados), P00.T07 |
| RQ-55 | PHASE 0 PREFLIGHT con `scripts/preflight`, checks listados, STOP con detalle y `PREFLIGHT PASSED` | §25 | P00 (PF-01…PF-33) | P00 |
| RQ-56 | Entorno local con mínimo de comandos (Postgres, Redis, fork, contratos, backend, worker, Wallet, Recovery) | §26 | §5.3 | P21.T01–T02 |
| RQ-57 | Seed determinístico reproducible con tokens reales | §27 | [C-SCR-03] | P07.T07, P21.T03–T04 |
| RQ-58 | Tests de contratos unit/integration/fuzz/invariant/fork + lista de ataques; cobertura alta; Slither | §28 | §10 | P04–P07 |
| RQ-59 | Tests backend (unit, integration, DB, queue, API, security) con la lista de escenarios | §29 | §10 | P08–P15 (en especial P13 tests) |
| RQ-60 | Tests frontend unit/integration/E2E con los flujos listados | §30 | §10 | P17–P19, P22 |
| RQ-61 | Acceptance full-system de 22 pasos con happy y failure paths | §31 | — | P23 |
| RQ-62 | Security tooling (forge test/coverage/fuzz/invariant, Slither, dependency audit, secret scanning, SAST, lint, typecheck) | §32 | §10 | P02.T02 (`ci-contracts.sh` con Slither y umbrales; `ci-security.sh`), P07.T03–T04, P27.T01 |
| RQ-63 | CI con todos los jobs; ningún deploy production si CI falla | §33 | CF-06 (aprobado), R-13 | P02, P26.T02.a (artefactos sólo desde commits en verde; sin deploy desde CI), P26.T17.c, P30.T01 |
| RQ-64 | Observabilidad (logs estructurados, métricas, alertas, health, cola, RPC, tx fallidas, signer, operaciones atascadas, reorgs, ETH de S) y redacción | §34 | [B-OBS] | P08.T07, P24 |
| RQ-65 | Audit trail append-oriented de eventos de seguridad | §35 | [B-AUD] | P08.T12, P24.T03 |
| RQ-66 | Rate limiting y abuso por IP/usuario/sesión/Safe | §36 | [B-RL] | P08.T11, P24.T04 |
| RQ-67 | Entornos local/staging/production sin reutilizar DB, OAuth, signer keys, session secrets, email, RPC keys | §37 | ADR-024 | P25.T01 |
| RQ-68 | PRODUCTION READINESS con todos los ítems de §38, como fase final | §38 | ADR-022, ADR-030, ADR-031, CF-09 | P26 (preparación para la VPS y ensayo local) y **P30** (gate final, producción completa sobre el fork y paquete de go-live; despliegue real manual fuera del planner) |
| RQ-69 | Scripts de deploy/verify mainnet que registran addresses, bytecode hashes, compiler, commit; `deployments/base-mainnet.json`; sin deploy mainnet sin aprobación | §39 | [C-SCR-01/04] | P25.T02–T06 (staging sobre el fork), P30.T02–T03 (producción sobre el fork), P30.T06 (`go-live.md`: deploy real con aprobación), R-09 |
| RQ-70 | Verificación en explorer de todo contrato con address, implementation, compiler, commit, codehash, URL | §40 | §3.5 (Etherscan V2) | P25.T02 (campos `proxy`/`implementation`), P25.T04 (incluye `RotationTimelock`), P30.T03 |
| RQ-71 | `SECURITY_AUDIT.md` adversarial con formato y filtros pedidos | §41 | §2.3 | P27 |
| RQ-72 | SECURITY REMEDIATION: sin Critical/High abiertos salvo decisión documentada; retest; re-audit; riesgos residuales | §42 | — | P28 |
| RQ-73 | `README.md` final y `docs/HOW_IT_WORKS.md` corto | §43 | — | P29.T01–T02 |
| RQ-74 | OpenAPI generado desde código; README enlaza `/docs` y explica autenticación | §44 | §7.11 | P08.T09, P29.T01, P29.T03 |
| RQ-75 | Checkpoint por fase con la lista estándar y comandos; no avanzar si falla algo crítico | §45 | §11 (checklist estándar) | todos los CHECKPOINT (con comando por ítem) |
| RQ-76 | Commits lógicos por fase y push periódico | §46 | §0.5 | todas las fases |
| RQ-77 | Arquitectura concreta sin TBD; secrets enumerados; revisión final; trazabilidad | §47 | §4, `SETUP_EXTERNAL_SERVICES.md`, §12 | Preparación |
| RQ-78 | V9: PlatformSession 15 min con session key efímera para requests críticos | V9 §3 | [B-PSES] | P10 |
| RQ-79 | V9: backup humano (5 palabras de wordlist pública 65.536; clave en 16+1 palabras) | V9 §4 | [F-KEY-02], [F-KEY-06], §3.5 wordlist | P01.T08, P17.T04 |
| RQ-80 | V9: RecoveryEnrollment firmado con Enrollment Key; U firma exactamente la incorporación; R externa con proof-of-control | V9 §6 | [B-DB] recovery_metadata, [F-LNK] | P12.T02–T03, P19.T03 |
| RQ-81 | V9: signer shards, una S por Safe, S sólo con ETH operativo | V9 §7 | [B-SIG-05], P11.T08–T09 | P11 |
| RQ-82 | V9: firmas fuera de una PlatformSession válida o de un flujo habilitado se ignoran | V9 §8 | [B-PSES-06], [B-SIG-02] | P10.T06, P11.T03 |
| RQ-83 | V9: 2FA transaccional ligado a Safe/SafeTxHash/acción/token/monto/destino/nonce | V9 §13 | [B-DB] `security_challenges` (`HIGH_VALUE_TX`), `POST /operations/{id}/two-factor`, [B-POL-02] | P14.T03, P13.T10 |
| RQ-84 | V9: credencial comprometida que veta su rotación → migración manual con doble aprobación | V9 §14 | ADR-026 | P15.T06 |
| RQ-85 | V9: nonce/cancelación por NoOp con el mismo nonce | V9 §15, A13 | [C-GRD-05], [B-NONCE-06] | P13.T08 |
| RQ-86 | V9: monitores comparan deploy con manifest y pausan la cooperación de S | V9 §17, A20 | ADR-023 | P20 |
| RQ-87 | V9: U+R opera sin plataforma; cualquier relayer puede transmitir | V9 §18, A6 | [F-UI] `/sovereign`, [F-KEY-06] (backup independiente obligatorio), [C-GRD-03] paso 3 (soberano nunca revierte), [W-05] | P05.T06, P07.T01.q, P19.T06, P19.T09 (`tools/sovereign-exit`), P23.T02, P29.T04 |
| RQ-88 | Restauración de U y R en un dispositivo nuevo desde backup cifrado, QR o backup humano (lado restore de prompt §8 y "importar R" de §9) | §8, §9, V9 §4/§5 | [F-KEY-10], [B-PSES-03] (`KEY_RESTORE`) | P17.T09, P19.T08, P22.T02.r–s |
| RQ-89 | Verificación de la configuración on-chain de la Safe antes de cada co-firma (sin Guard no hay cooperación) | V9 §9/§10, A8/A9 | [B-Q-02] paso 7b, [B-FIN-03] | P13.T11, P13.TST.k, P11.T03 |
| RQ-90 | Vía de upgrade del Guard para Safes existentes | V9 §16 (Guard inmutable) + continuidad operativa | [C-GRD-17], [C-POL-06], ADR-029 | P05.T06, P07.T01.r, P15.T08 |
| RQ-91 | Formatos de intercambio compartidos entre apps independientes | V9 §6/§8/§17 | §7.15 [W-01…W-07] | P07.T05 (vectores), P11.T11, P12, P18, P19 |
| RQ-92 | Separación de los tres dominios (proyectos, CODEOWNERS, claves de release fuera del host, contenedores y redes separadas) | V9 §2/§17 | CF-01, CF-10, ADR-022 | P02.T01, P26.T02, P26.T17.a, P26.T17.b, P26.T17.j |
| RQ-93 | Producción self-hosted en VPS Linux, sin dependencias de proveedores cloud; preparar artefactos y documentación sin desplegar | instrucción del owner (2026-10-16) | ADR-022, §5.5, R-09 | P26 (T01–T16.b), P30.T04, P30.T06 |
| RQ-94 | Inyección segura de secretos self-hosted; credenciales de desbloqueo del signer separadas de los keystores | instrucción del owner | ADR-030, [B-SIG-08] | P08.T02, P26.T09, P11.T06 |
| RQ-95 | Backups agnósticos (PostgreSQL, keystores cifrados del signer, auditoría, configuración) con copia off-host cifrada | instrucción del owner, §38 | ADR-031, [B-DB-BK] | P26.T07, P26.T08, P11.T10 |
| RQ-96 | Toolchain reproducible con detección y auto-remediación antes de STOP | instrucción del owner | ADR-032, P00 (PF-01…PF-08) | P00.T01.a, P00.T05, P01.T01 |
| RQ-97 | USDT: representación canónica verificada automáticamente (fuentes oficiales + on-chain) | instrucción del owner | §3.3 | P03.T03, P03.T05 |
| RQ-98 | Producto final sin pendientes: ejecución de punta a punta sin frenos y tests obligatorios contra servicios reales (Drive, entrega de email por Mailgun, WalletConnect, RPC, fork de Base) | instrucción del owner (2026-10-17) | R-14, ADR-016, ADR-024 | P00.T08 (PF-30–PF-32), P09.TST.g–h, P19.MAN, P22.T04, P22.T06, P25, P30 |

## 13. Registro de ejecución

Agregar una fila por sesión de trabajo, por cada CHECKPOINT y ante cualquier bloqueo. Nunca pegar secretos.

| Fecha | Fase / tarea | Estado | Commit | Notas |
|---|---|---|---|---|
| 2026-10-16 | Preparación (prompt §47) | Completado | commit de preparación (`git log -1 -- wallet/docs/PLANNER_WALLET_WEB.md`) | Branch `feat/walletWeb/cmarchese` creado desde `main` (`4ed7bf4`). V9 leída completa. Verificación oficial de Safe 1.5.0, Uniswap, USDC/USDT, Base, librerías y servicios (§3). Creados: este planner, `SETUP_EXTERNAL_SERVICES.md`, `.env.example`, `.env` (local, gitignored), `wallet/.gitignore`. Sin implementación de producto. |
| 2026-10-16 | Corrección del planner (instrucción del owner) | Completado | commit `docs(wallet): adapt planner to self-hosted VPS architecture` | Producción self-hosted en VPS (sin dependencias cloud); signer `SelfHostedSoftwareSignerProvider` tras evaluar Clef y Web3Signer; secretos por Docker Compose secrets; backups con pgBackRest + age; toolchain local con auto-remediación; USDT canónico verificado; CI en raíz aprobado; blockers reducidos a acciones humanas reales (§13.1). |
| 2026-10-17 | Ajuste del planner (instrucción del owner) | Completado | commit `docs(wallet): run the whole planner on the Base fork with real services` | Ejecución de punta a punta sin frenos (R-14): staging y producción desplegados y probados sobre el fork (P25/P30); `Pxx.MAN` ejecutados por el agente o por un agente revisor independiente; tests obligatorios contra servicios reales (API de Mailgun con el dominio sandbox, entrega real de email leída con la Gmail API, API de Drive, relay de WalletConnect); claves de ensayo generadas fuera del repo; fuera del planner sólo queda el despliegue final (§13.1). |
| 2026-10-17 | Proveedor de email (instrucción del owner) | Completado | commit `docs(wallet): switch email provider to Mailgun` | Proveedor de email: Mailgun (cuenta del owner), en reemplazo del definido antes; credenciales del dominio sandbox provistas y validadas sin mostrarlas (dominio `active`, región US). |
| 2026-10-17 | Lectura del email de tests (instrucción del owner) | Completado | commit `docs(wallet): read test emails through the Gmail API` | Los códigos de la entrega real se leen con la Gmail API (OAuth 2.0, `gmail.readonly`, cliente `drive-tests`) en lugar de IMAP con contraseña de aplicación; variables `EMAIL_TEST_GOOGLE_*`; el envío sigue por Mailgun. |
| 2026-10-17 | Verificación real del mecanismo de email (antes de P00) | Completado | commit `docs(wallet): search spam in real-email tests and require DMARC at go-live` | Envío por Mailgun (sandbox) a `EMAIL_TEST_ADDRESS` recibido en 7 s y código leído con la Gmail API; llegó a spam (dominio sandbox compartido): los tests buscan con `includeSpamTrash=true` y el go-live exige bandeja de entrada con SPF, DKIM y DMARC. Credenciales de Drive validadas (`drive.appdata`, `appDataFolder` 200). |
| 2026-10-17 | P00 — PREFLIGHT | Completado | `4ffc0c4` `chore(infra): add local compose stack and fork scripts`, `a010e61` `feat(infra): add preflight checks` | `PREFLIGHT PASSED` con `docker compose up -d && pnpm preflight` (32 checks evaluados; PF-26 y PF-29 omitidos hasta P22/P10; PF-23 en WARN: RAM 7,7 GB < 8 GB). Toolchain en `wallet/.tools` con checksums verificados (Node 26.12.0, pnpm 12.14.0, Foundry 1.8.5, gitleaks 8.30.1, Slither 0.11.6). Servicios reales validados sin mostrar valores: RPC primario (Alchemy, archive, 16 codehashes en 52700000) y secundario (QuickNode), relay de Reown, clientes OAuth de Wallet/Recovery, Etherscan V2, Drive (`drive.appdata`), Gmail (`gmail.readonly`) y Mailgun (dominio sandbox activo, Events API). Cambios respecto del planner: PF-01 exige git ≥ 2.34 (el host tiene 2.34.1 y ninguna función usada requiere 2.40); Slither por venv con pip instalado desde su wheel verificado (la distribución no trae ensurepip) y, sin Python ≥ 3.10, por la imagen fijada; gitleaks por binario (la imagen queda como alternativa); el volumen de Anvil se monta en `/home/foundry` (la imagen corre con UID 1000); `POSTGRES_HOST_PORT=55433` en el `.env` local porque 55432 lo usa un contenedor de otro proyecto (PF-09 lo detectó; no se tocó); PF-25 acepta Soldeer (`soldeer.lock`, ver P03). P00.MAN (2026-10-17, agente): preflight con `WALLETCONNECT_PROJECT_ID` borrada → STOP con la variable, cómo obtenerla y el ancla de SETUP; se agregó un texto 'cómo obtenerla' específico por variable. P00.SEC: `gitleaks git --redact` sin hallazgos y `secrets-local` se niega con `APP_ENV=staging` (exit 3). |
| 2026-10-17 | Correcciones del planner (P01, revisión independiente) | Completado | commit `docs(wallet): add architecture decision records and threat model` | Inconsistencias corregidas al redactar ADRs y threat model: piso de slippage de la fila ADR-015 a 0,5 % (`MAX_SWAP_SLIPPAGE_BPS = 50`, igual que [C-GRD-09]/[C-SWP-02]/ADR-025); opType `GUARD_UPGRADE` (sólo U) incorporado a [C-POL-02], [C-POL-04], [B-POL-03] y `operation_type`; [C-POL-06] con tarea explícita (P04.T04); verificación de P13.TST.k; spike de Google (P17.T02) y smoke con Drive real (P30.T05) alineados con P22.T04; restos de proveedores cloud (secret manager) reemplazados por Docker Compose secrets; ADR-005 con permisos por `(opType, rol)` y hardware wallets recomendadas; versiones de `jose`, `@reown/walletkit` y `@walletconnect/core` en §3.6 y `@tanstack/react-query` como peer de wagmi; A11 → P05; RQ-55 → PF-33; P20.T02 con la `IntegrityAttestation` completa de [W-03]. Decisión del owner (2026-10-17) incorporada: Wallet y Recovery en servidores distintos del backend y entre sí (CF-07, CF-10 reescritos, nuevo CF-11 sobre separación de hosting y DNS con gate en el go-live, ADR-022 y §5.5 con tres servidores y tres compose, §9.3, P26.T02/T04/T10/T16/T16.a/T16.b/T17.j, P27.T02.k, P28.T03, P30.T04/T06, H-02, H-06). P23.T02 suma pasos de falla para A7, A8, A13, A16, A18, A19 y A21 (§9.2 actualizado). P03.T02, §5.2 y P21.T01 con Soldeer en lugar de submódulos: `.gitmodules` tendría que vivir en la raíz del repositorio (R-02); `soldeer.lock` fija versión y checksum (Safe por commit) y `script/verify-deps.sh` compara cada `.sol` con las fuentes oficiales. |
| 2026-10-17 | P01 — Fundaciones del repositorio y toolchain | Completado | commits `docs(wallet): add architecture decision records and threat model` y `chore(wallet): pin toolchain versions and add wordlist v1` | 32 ADRs, `THREAT_MODEL.md` v1, `docs/VERSIONS.md` (sin rangos; `versions-doc.test.mjs` lo contrasta con `versions.json`), estructura de §5.2 con README por carpeta, `.editorconfig`, `.gitattributes`, `.gitleaks.toml` (reglas por defecto + propias; direcciones EVM públicas en allowlist) y hook pre-commit instalado por `bootstrap hook` (probado: bloquea un secreto de prueba y deja pasar lo limpio), wordlist MTW-WORDLIST-V1 verificada (65.536 palabras, SHA-256 `c2bf4e5b…`, licencia MIT), política de supply chain de pnpm en `pnpm-workspace.yaml` (pnpm 12 ya no lee esos settings de `.npmrc`). P01.MAN y P01.T07 (2026-10-17, agente revisor independiente): primera revisión **no aprobado** (3 altos: GUARD_UPGRADE ausente en ADR-005 y ADR-025, topología de host único en ADR-022; 5 medios; 7 bajos); segunda revisión **aprobado con observaciones** (1 medio, 6 bajos), todas corregidas; CF-01 no bloqueante y CF-06 aprobado confirmados. Push protection de GitHub bloqueó un push por fixtures con formato de credencial: los tests arman esos valores en tiempo de ejecución. |

### 13.1 Fuera del planner: despliegue final y servicios

Para ejecutar el planner de punta a punta sólo hace falta lo de `wallet/.env` (H-01, completo). Todo lo demás es el despliegue final, manual, guiado por `docs/runbooks/go-live.md` (P30.T06):

| ID | Acción | Cuándo | Estado |
|---|---|---|---|
| H-01 | Credenciales de los tests contra servicios reales: `GOOGLE_DRIVE_TEST_CLIENT_ID`, `GOOGLE_DRIVE_TEST_CLIENT_SECRET`, `GOOGLE_DRIVE_TEST_REFRESH_TOKEN`, `EMAIL_TEST_ADDRESS`, `EMAIL_TEST_GOOGLE_CLIENT_ID`, `EMAIL_TEST_GOOGLE_CLIENT_SECRET` y `EMAIL_TEST_GOOGLE_REFRESH_TOKEN` (pasos en `SETUP_EXTERNAL_SERVICES.md`) | antes de P00 | Completado (2026-10-17, validado sin mostrar valores) |
| H-02 | Dominios de Wallet y Recovery. Decisión del owner (2026-10-17): subdominios que apuntan a servidores distintos (ADR-010). Gate de CF-11: dominios registrables con cuentas de DNS distintas para Wallet y Recovery, o la aceptación escrita del owner de RR-11 (con una sola cuenta de DNS, quien la controle puede redirigir ambas apps); sin cambios de código en ninguno de los dos casos | despliegue final | Pendiente |
| H-03 | Servicios de staging/producción para esos dominios: clientes Google OAuth (publicación con verificación de marca), proyectos Reown, apps de Alchemy y endpoints de QuickNode por componente, Mailgun (dominio de envío propio por entorno verificado con SPF/DKIM) y `ALERT_EMAIL` | despliegue final | Pendiente |
| H-04 | Claves reales para Base mainnet (deployer, owners de la Governance Safe —hardware wallets recomendadas— y guardianes independientes); nunca las de ensayo del fork | despliegue final | Pendiente |
| H-05 | Aprobación escrita del owner y ETH real para el deploy y el gas tank | despliegue final | Pendiente |
| H-06 | Servidores: VPS del backend y servidores de Wallet y de Recovery (distintos entre sí, en cuentas de hosting distintas, CF-11), DNS, reverse proxy y TLS de cada uno, custodia offline de las credenciales de desbloqueo del signer (dos custodios) y destino off-host de los backups | despliegue final | Pendiente |

Ya resuelto: credenciales de local provistas el 2026-10-17 (`BASE_RPC_URL`, `BASE_RPC_URL_SECONDARY`, `WALLETCONNECT_PROJECT_ID`, `GOOGLE_CLIENT_ID_WALLET`, `GOOGLE_CLIENT_ID_RECOVERY`, `ETHERSCAN_API_KEY` y Mailgun con dominio sandbox); CI usa la misma `BASE_RPC_URL` como secret; claves de ensayo de staging/producción generadas por el agente en `~/.config/mtw/` (fuera del repo); push del tag de release aprobado (2026-10-17); archivos de CI en la raíz aprobados (2026-10-16); representación de USDT verificada (§3.3); separación física de repositorios (no bloqueante, P26.T17.b); toolchain con auto-remediación (P00); sin dependencias cloud.
