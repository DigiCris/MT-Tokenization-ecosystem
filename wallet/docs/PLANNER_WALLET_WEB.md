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
| CF-12 | La tabla [B-API] ubicaba `POST /recovery/u-replacement` en el listener de Recovery; [W-07] asigna el scope `U_REPLACEMENT` a Wallet y §5.4 genera U′ en Wallet antes de que R firme en Recovery. | La ruta vive en Wallet (scope `U_REPLACEMENT`, step-up sólo en Wallet): registra U′ (OPAQUE PENDING + KeyAcceptance) y deja el borrador de la rotación; R la propone y la ejecuta desde Recovery con `POST /wallets/{id}/rotations` y `POST /rotations/{id}/execute/prepare` (P15.T04). |

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
| ADR-033 | Secreto `k` del pedido en el enlace de regreso de Recovery: 128 bits que genera la Wallet por pedido, sólo en los fragmentos de ida y vuelta y en la memoria de la pestaña del pedido; la Wallet confirma R por enlace sólo con `k` (comparación en tiempo constante) y la R del backend; si no, aborta e informa (`POST /recovery/enrollments/{id}/reject`). Despliegue: Recovery antes que Wallet. | Un backend comprometido conoce `eid` y R′ y podía falsificar el regreso (ESC-20; P17.MAN, segunda revisión, N2/N10). Descartadas: firmar con la Enrollment Key (su clave pública la sirve el backend), derivar `k` del nonce (lo genera el backend) y sessionStorage en Wallet (restringido por [F-KEY-07]; en Recovery, sólo durante el viaje de OAuth de Drive). Despliegue: backend (migración 0010) y Recovery antes que Wallet. |

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
| `recovery_metadata` | id, wallet_id FK, enrollment_id, r_address, r_type (INTERNAL/EXTERNAL), connector_id null, enrollment_key_jwk, enrollment_payload jsonb, enrollment_key_signature, r_proof_signature, u_incorporation_signature, status (REQUESTED/SUBMITTED/CONFIRMED/EXPIRED/REJECTED), rejection_reason null, rejected_at null (migración 0009, ADR-033), rejection_reported_at null, rejection_email (SENT/HELD/SUMMARIZED/NONE), rejection_emailed_at null (migración 0010), expires_at, created_at | UNIQUE(enrollment_id) |
| `signer_keys` | id, wallet_id FK, shard_id, key_ref, address, provider (development/selfhosted/hardware), status (ACTIVE/PENDING/RETIRED), created_at | UNIQUE(address); UNIQUE(wallet_id) WHERE status='ACTIVE' |
| `security_challenges` | id uuid, user_id, wallet_id null, type (EMAIL_VERIFY/PASSWORD_RESET/LOGIN_UNLOCK/STEP_UP/WHITELIST_ADD/ROTATION/HIGH_VALUE_TX/MIGRATION), binding jsonb (safe, chainId, destination, action, nonce, safeTxHash, token, amount), code_hash bytea, attempts, max_attempts, expires_at, consumed_at, created_ip_prefix, created_at | idx(user_id, type, created_at); CHECK(attempts <= max_attempts) |
| `whitelist_requests` | id, wallet_id, user_id, destination, label, status (PENDING_CHALLENGE/CHALLENGE_PASSED/AWAITING_SIGNATURE/SUBMITTED/ACTIVATING/ACTIVE/EXPIRED/CANCELLED/FAILED), challenge_id FK, operation_id FK null, created_at, updated_at | UNIQUE(wallet_id, destination) WHERE status NOT IN ('EXPIRED','CANCELLED','FAILED','ACTIVE') |
| `whitelisted_destinations` | id, wallet_id, destination, label, status (ACTIVATING/ACTIVE/REMOVED), activates_at, added_tx_hash, removed_tx_hash, created_at | UNIQUE(wallet_id, destination) WHERE status IN ('ACTIVATING','ACTIVE') |
| `whitelist_events` (P14) | id, chain_id, safe_address, destination, kind (ADDED/REMOVED), activates_at, tx_hash, log_index, block_number, block_hash, status (MINED/CONFIRMED/FINALIZED/REORGED), applied_at, created_at, updated_at | UNIQUE(chain_id, tx_hash, log_index); FK (chain_id, safe_address) → wallets; eventos de `DestinationWhitelist` indexados con finalidad y reorgs, aplicados una vez a `whitelisted_destinations` |
| `wallet_operations` | id uuid, user_id, wallet_id, safe_address, chain_id, safe_nonce numeric, operation_type (SEND/SWAP_APPROVE/SWAP/WHITELIST_ADD/WHITELIST_REMOVE/ROTATION_PROPOSE/ROTATION_EXECUTE/NOOP_CANCEL/MIGRATION_TRANSFER/APPROVE_REVOKE/GUARD_UPGRADE), group_id null, safe_tx_hash bytea, target, value numeric, calldata bytea, canonical_intent jsonb, owner_signature bytea (= "u_signature" del prompt; firma de U **o** R), owner_role (U/R), s_signature bytea null, platform_session_id, submission_envelope jsonb, policy_snapshot_version, two_factor_challenge_id null, status, failure_reason, last_error_code, retry_count, next_attempt_at, lease_version, created_at, updated_at, submitted_at, mined_at, executed_at, confirmed_at, finalized_at, tx_hash, block_number, block_hash | UNIQUE(safe_tx_hash) WHERE status NOT IN ('EXPIRED','CANCELLED','FAILED_FINAL') (P13: una SafeTx vencida, cancelada o fallida se puede volver a preparar); UNIQUE(chain_id, safe_address, safe_nonce) WHERE status IN ('USER_SIGNED','QUEUED','VALIDATING','READY','SUBMITTED','MINED','FAILED_RETRYABLE','REORGED','CONFIRMED','FINALIZED') ; CHECK(value >= 0) |
| `chain_transactions` | id, chain_id, operation_id FK null, purpose (EXEC/DEPLOY/TOPUP/CANCEL_RELAY), from_address, account_nonce, tx_hash, raw_tx bytea, max_fee_per_gas, max_priority_fee_per_gas, gas_limit, status (BROADCAST/MINED/CONFIRMED/FINALIZED/REPLACED/DROPPED/REORGED/FAILED), replaced_by_id, block_number, block_hash, receipt_status, gas_used, effective_gas_price, created_at, updated_at | UNIQUE(tx_hash); UNIQUE(chain_id, from_address, account_nonce, tx_hash) |
| `rotation_requests` | id, wallet_id, role (U/R/S), old_key, new_key, proposal_id bytea null, initiated_by (U/R), status (DRAFT/AWAITING_SIGNATURE/PROPOSING/PENDING_TIMELOCK/READY_TO_EXECUTE/EXECUTING/EXECUTED/CANCELLED/FAILED), propose_operation_id, execute_operation_id, executable_at, cancelled_by (U/R/SAFE), cancel_tx_hash, created_at, updated_at | UNIQUE(wallet_id, role) WHERE status IN ('PROPOSING','PENDING_TIMELOCK','READY_TO_EXECUTE','EXECUTING') |
| `rotation_events` | id, chain_id, safe_address, timelock, proposal_id, kind (PROPOSED/CANCELLED/EXECUTED), rotation_kind null, old_value null, new_value null, executable_at null, actor null, tx_hash, log_index, block_number, block_hash, status (MINED/CONFIRMED/FINALIZED/REORGED), applied_at null, apply_attempts, apply_error null, quarantined_at null, retry_at null (cuarentena por evento, migración 0010), created_at, updated_at | UNIQUE(chain_id, tx_hash, log_index) |
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
REORGED ──(la misma tx de S re-incluida en otro bloque)──▶ MINED
USER_SIGNED|QUEUED|READY|SUBMITTED|FAILED_RETRYABLE|FAILED_FINAL ──(usuario pide cancelar)──▶ CANCEL_REQUESTED ──(se mina la NoOp)──▶ CANCELLED
CANCEL_REQUESTED ──(se mina la original primero)──▶ MINED (sigue el camino normal; la NoOp queda FAILED_FINAL "demasiado tarde")
QUEUED ──(NoOp que perdió la carrera / firma de más de 24 h esperando un nonce menor)──▶ FAILED_FINAL
USER_SIGNED ──(la otra mitad de su par approve/swap venció o se canceló sin firmarse; S nunca la co-firmó)──▶ FAILED_FINAL
```

Las transiciones `REORGED → MINED` y `QUEUED → FAILED_FINAL` se agregaron al ejecutar P13 (registro en §13): la primera
evita re-ejecutar lo que la cadena canónica ya contiene; la segunda cierra la NoOp que perdió la carrera de
[B-NONCE-06] y las firmas vencidas de [B-PSES-06] sin pasar por el worker. `USER_SIGNED → FAILED_FINAL` se agregó en
P14: el par de un swap se encola recién con las dos firmas de U, y la mitad firmada de un par que no se completó se
cierra sin NoOp (sin la co-firma de S no puede ejecutarse) y libera su nonce.

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
| swap | `GET /wallets/{id}/swap/quote`, `POST /wallets/{id}/swap/prepare`; grupo del swap (P14): `GET /operation-groups/{id}`, `POST /operation-groups/{id}/requote`, `POST /operation-groups/{id}/revoke-approval` | cuenta / crítico | Wallet |
| operations | `GET /wallets/{id}/operations`, `GET /operations/{id}`, `POST /operations/{id}/signatures`, `POST /operations/{id}/cancel`, `POST /operations/{id}/two-factor` | cuenta / crítico | Wallet (y Recovery para firmas R) |
| recovery | `POST /wallets/{id}/recovery/enrollments`, `GET /recovery/enrollments/{id}`, `POST /recovery/enrollments/{id}/enrollment-key`, `POST /recovery/enrollments/{id}/submit`, `POST /recovery/enrollments/{id}/reject` (la Wallet aborta un pedido que no pudo confirmar; PlatformSession del pedido; idempotente; REJECTED con el motivo, auditoría, aviso, email y alerta; 409 si el pedido terminó o si es un reemplazo de R con la rotación hacia R′ en curso, con auditoría `RECOVERY_ENROLLMENT_REJECTION_REFUSED` y alerta; la propuesta de la rotación revalida el pedido con lock; ADR-033), `POST /recovery/enrollments/{id}/incorporate` (firma U), `POST /recovery/u-replacement` | crítico | Recovery (enrollment-key/submit) / Wallet (create/reject/incorporate/u-replacement, ver CF-12) |
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

- `PreparedOperation` (respuesta de todo `prepare`): `{operationId, groupId?, walletId, safe, chainId, operationType, safeTx: {to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce}, safeTxHash, typedData, decoded: {token?, amount?, destination?, tokenIn?, tokenOut?, minAmountOut?, deadline?, role?, oldKey?, newKey?}, requiresTwoFactor, twoFactorThreshold, expiresAt}` (`twoFactorThreshold`: umbral de 2FA de la policy vigente en unidades de 6 decimales cuando la operación lo exige, `null` si no; agregado en la corrección de P18.MAN para que el texto del segundo factor no fije el monto).
- `SubmitSignatureRequest`: `{ownerSignature, ownerRole: 'U'|'R', submissionEnvelope: {operationId, safeTxHash, sessionId, submittedAt}, submissionEnvelopeSignature, twoFactorChallengeId?}`.
- `OperationStatus`: `{id, status, operationType, safeNonce, safeTxHash, txHash?, blockNumber?, blockHash?, confirmations: {safe: bool, finalized: bool}, failureReason?, lastErrorCode?, decoded, history: [{status, at}]}` (`decoded`: la intención guardada al preparar, con la forma de `PreparedOperation.decoded`; agregado en la corrección de P18.MAN para que la actividad diga qué era una operación sin transfers).
- `WhitelistRequest` / `WhitelistEntry`: `{id, destination, label, status, activatesAt?, challengeExpiresAt?}`.
- `RotationRequest`: `{id, role, oldKey, newKey, status, proposalId?, executableAt?, cancelledBy?}`.
- `RecoveryEnrollmentStatus` (`GET /recovery/enrollments/{id}`): `{id, walletId, purpose, status, expiresAt, enrollmentKeyRegistered, recoveryKey, rType, submittedAt, confirmedAt, rejectionReason}` (`rejectionReason`: `SUPERSEDED`, `MANUAL_COMPARISON_FAILED`, `RETURN_LINK_KEY_MISMATCH` o `RETURN_LINK_UNVERIFIED`, ADR-033).
- `DeploymentInfo`: `{walletId, status, U, R, S, saltNonce, factory, singleton, bootstrap, guard, moduleGuard, timelock, policyRegistry, whitelist, swapExecutor, expectedSafe, deployTxHash?}`.
- `Problem` (RFC 9457): `{type, title, status, code, detail, requestId, errors?[]}`.

Endpoints adicionales: `POST /security/csp-report` (ambos listeners; sin auth, rate limit estricto, cuerpo acotado), `POST /wallets/{id}/user-key/restore` (scope `KEY_RESTORE`, [B-PSES-03]). La API mTLS del signer tiene su propia spec OpenAPI interna (`backend/signer/openapi.json`), nunca publicada.

Swagger: `/docs` (Swagger UI) y `/docs/openapi.json` en ambos listeners. En **local/staging** "Try it out" habilitado: cookie de sesión + CSRF desde el mismo origen del API; para endpoints críticos un `requestInterceptor` (sólo builds no-producción) firma con una session key que el desarrollador obtiene mediante el flujo real (`pnpm --dir backend/app dev:session`, que hace login + OPAQUE con un usuario de prueba — **sin endpoints backdoor**). En **producción**: sólo spec de la API pública, "Try it out" deshabilitado; la API interna de operadores nunca se publica en `/docs`.

### 7.12 Email [B-MAIL]

- **[B-MAIL-01]** `EmailProvider` con adaptadores `mailgun` (staging/producción y tests reales; API HTTP con `fetch` nativo y autenticación Basic) y `smtp` (local/CI → Mailpit). Envío vía outbox (`email_outbox` lógico en `outbox_events`) con reintentos.
- **[B-MAIL-02] Plantillas sensibles** (whitelist, rotaciones, recovery, step-up, reset): muestran **acción**, **dirección completa** (checksum EIP-55 como en las apps: `0x ` y los 10 grupos de 4), **montos** en es-AR con su token (p. ej. `1.000,00 USDC`), **red** ("Base mainnet — chainId 8453"; en local "Base fork local — chainId 8453"), **Safe**, **expiración** (hora local del usuario y UTC), IP/dispositivo de origen y qué hacer si no fue el usuario. Nunca incluyen links que ejecuten acciones; el código se ingresa en la app.
- **[B-MAIL-03]** Notificaciones: nuevo login, reset de password, whitelist solicitada/activada/removida, rotación propuesta/cancelada/ejecutada, recovery iniciado, operación de alto valor ejecutada, pausa de cooperación por integridad, posible sustitución de la dirección de R (pedido de Recovery rechazado por la Wallet, ADR-033; un email por usuario por hora y el resto en el resumen `recovery-enrollment-rejections-summary`; sin email ni alerta el aviso tardío de un pedido reemplazado hace más de 15 min).

### 7.13 Audit log [B-AUD]

Escritura serializada: cada inserción toma `pg_advisory_xact_lock(<clave de auditoría>)` y lee la cabeza de la cadena dentro de la misma transacción (un solo escritor lógico; throughput suficiente para V1). Eventos mínimos: `AUTH_LOGIN_SUCCEEDED/FAILED`, `AUTH_LOGOUT`, `AUTH_PASSWORD_RESET_REQUESTED/COMPLETED`, `SESSION_REVOKED`, `PLATFORM_SESSION_ISSUED`, `TOTP_ENABLED/DISABLED`, `WHITELIST_REQUESTED`, `WHITELIST_CHALLENGE_PASSED/FAILED`, `WHITELIST_CONFIRMED_ONCHAIN`, `WHITELIST_REMOVED`, `OPERATION_PROPOSED`, `OPERATION_SIGNATURE_RECEIVED` (rol U/R), `OPERATION_<ESTADO>`, `S_SIGNATURE_ISSUED`, `S_EXECUTION_SUBMITTED`, `ROTATION_PROPOSED/CANCELLED/EXECUTED`, `RECOVERY_ENROLLMENT_*`, `RECOVERY_U_REPLACEMENT_STARTED`, `MIGRATION_CASE_*`, `POLICY_SNAPSHOT_ACTIVATED`, `INTEGRITY_MISMATCH`, `COOPERATION_PAUSED/RESUMED`, `OPERATOR_ACTION_*`, `RPC_DISAGREEMENT`, `REORG_DETECTED`. Cadena HMAC verificable (`pnpm --dir backend/app audit:verify`); export diario firmado y cifrado con `age` hacia la copia off-host (el hash de cada export queda anclado como evento de auditoría).

### 7.14 Observabilidad [B-OBS]

- Logs estructurados (pino, JSON) con `requestId`/`operationId`; **redacción** obligatoria por paths (`password`, `passwordU`, `passwordR`, `otp`, `code`, `token`, `authorization`, `cookie`, `set-cookie`, `x-platform-session`, `x-session-signature`, `privateKey`, `secret`, `mnemonic`, `seed`, `registrationRecord`) + serializer que trunca IP y enmascara email; tests de canario: valores secretos sembrados nunca aparecen en logs capturados.
- Métricas Prometheus (prom-client, puerto interno): HTTP, auth failures, rate-limit hits, cola (waiting/active/delayed/failed), lag del outbox, operaciones por estado, operaciones atascadas (edad > umbral), RPC (latencia, errores, head lag, desacuerdos, salud por proveedor), signer (latencia, rechazos por motivo, salud por shard), tx (submitted/mined/confirmed/reverted/reorged), saldo ETH de cada S (gauge agregado + lista de S bajo umbral), saldo del gas tank, estado de integridad, verificación de cadena de auditoría.
- Alertas (P24/P26): tx fallidas/revertidas, operaciones atascadas > 10 min, reorg detectado, desacuerdo RPC sostenido (> 3 en 5 min), proveedor RPC caído, signer caído o con rechazos anómalos, S con ETH bajo `GAS_TOPUP_MIN_WEI` y recarga fallida, gas tank bajo 0,05 ETH (el tope diario de recargas), mismatch de integridad (crítica), lag del outbox > 60 s, verificación de auditoría fallida (crítica), picos de login fallido, liquidez activa del pool canónico < 50 % de la observada en `FORK_BLOCK_NUMBER` o reservas USDC+USDT < US$ 100k, cotización USDC/USDT desviada > 0,5 % de 1:1 (además deshabilita swaps por policy), cambio de implementación del proxy de USDC, alarmas del signer (keystore ilegible o con MAC inválido, fingerprint de credencial distinto al arrancar, archivo de keystore creado o borrado fuera del flujo, clave `BROKEN`, backup de keystores fallido o atrasado), evento del timelock en cuarentena (`ROTATION_EVENT_QUARANTINED`, `mtw_rotation_events_quarantined` > 0), rotación ejecutada hacia una R′ rechazada (`RECOVERY_REJECTED_KEY_EXECUTED`) y posible sustitución de R (`mtw_recovery_enrollment_rejections_total{alerted="true"}`).
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
- **[F-KEY-07] Prohibido**: U/R en texto plano en localStorage, sessionStorage, IndexedDB, cookies, logs, analytics u observabilidad. Sólo sobres cifrados pueden cachearse en IndexedDB (opcional "recordar en este dispositivo"). El secreto `k` del pedido de R (ADR-033) tampoco va a Web Storage, salvo en la app Recovery durante el viaje de OAuth de Drive: el estado del viaje (`src/drive/oauth-state.ts`) lleva la ruta de regreso de `/enroll` con `k`; se borra al volver, vence a los 10 min y se descarta si el viaje se abandona.
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

- **[F-LNK-01]** Wallet → Recovery: `https://recovery.<RECOVERY_DOMAIN>/enroll#eid=<enrollmentId>&n=<nonce>&k=<k>` (fragmento, no llega a servidores) + QR equivalente. `k` = 16 bytes del CSPRNG en base64url, nuevo por pedido; vive sólo en la memoria de la pestaña del pedido y nunca va a un servidor ni a logs (ADR-033). Recovery no lo usa ni lo manda a su backend: lo devuelve en el enlace de regreso.
- **[F-LNK-02]** Recovery → Wallet: `https://wallet.<WALLET_DOMAIN>/onboarding/confirm-recovery#eid=<id>&r=<R>&k=<k>` + QR. La pestaña que lo abre pasa `eid`, `r` y `k` a la pestaña del pedido (BroadcastChannel), que compara `k` en tiempo constante: sin `k` o con otro → abortar (`RETURN_LINK_UNVERIFIED`); con `k`, sólo confirma si el backend informa ese mismo pedido SUBMITTED con esa R, y cualquier otra respuesta aborta (`RETURN_LINK_KEY_MISMATCH`; sólo un error de red deja reintentar). La pestaña del enlace muestra el resultado real. Una pestaña sin el pedido no confirma nada y lo explica enseguida; sin `k`, informa el aborto con una sesión del propósito del pedido. La comparación manual relee el pedido antes de aceptarse. La app no muestra texto del backend (en Wallet ni en Recovery). Sin enlace (otro dispositivo), comparación manual de la dirección completa antes de que U firme: los 10 grupos copiados de la app Recovery, la Wallet no muestra la R del backend hasta que coincide, 3 intentos y después `MANUAL_COMPARISON_FAILED`. Todo aborto se informa con `POST /recovery/enrollments/{id}/reject`; si no llega, queda en una cola en memoria que se reenvía con la próxima sesión, y al cerrar o recargar la pestaña después de una comparación fallida sale con `fetch` keepalive firmado de antemano (el aborto local sigue igual).
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
| PF-07 | gitleaks y age == versiones fijadas: si falta o difiere → bootstrap (o imagen Docker fijada) y re-verifica (age desde P11: backups cifrados, ADR-031) | todos |
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

- [x] **P02.T01** — Crear `.github/workflows/wallet-contracts.yml`, `wallet-backend.yml`, `wallet-signer.yml`, `wallet-frontend-wallet.yml`, `wallet-frontend-recovery.yml`, `wallet-security.yml`, `wallet-e2e.yml`, `wallet-repro-build.yml` (disparadores finos con `paths: ['wallet/<área>/**']`) y `.github/CODEOWNERS` con un equipo revisor por trust domain (contracts, backend/signer, frontend-wallet, frontend-recovery, infra). **Aprobado por el owner el 2026-10-16: no volver a preguntar.**
      Verificación: archivos presentes y `docker run --rm -v "$PWD:/src" <imagen zizmor fijada> /src/.github/workflows` sin hallazgos High.
- [x] **P02.T02** — Scripts `wallet/ci/scripts/ci-<área>.sh` que ejecutan, si el proyecto existe (si no, imprimen `SKIP: proyecto no creado aún (fase Pxx)`): instalación con lockfile congelado, lint, typecheck, unit, integración, cobertura y build del área. `ci-contracts.sh`: `forge build --sizes`, `forge test --profile ci` (unit, integración, fork, fuzz, invariants), `forge coverage` con umbrales (≥ 95 % líneas, ≥ 90 % ramas en `src/`; falla si no se cumplen) y **Slither** (`slither . --config-file slither.config.json --fail-medium`). `ci-security.sh`: gitleaks (historia completa del branch), OSV-Scanner sobre todos los lockfiles, `pnpm audit --prod` por proyecto, Semgrep (reglas TS + Solidity), zizmor sobre workflows. Herramientas vía imágenes Docker fijadas por digest.
      Verificación: `pnpm ci:local` corre todos los scripts y termina en verde.
- [x] **P02.T03** — Workflows: acciones fijadas por **SHA de commit**, `permissions: contents: read` por defecto, sin `pull_request_target`, `concurrency` por ref, caché de Foundry RPC por `FORK_BLOCK_NUMBER`, secretos por **GitHub Environment** separado por área (el workflow de Recovery no puede leer secretos de Wallet y viceversa), runners efímeros. `wallet-e2e.yml` en PR con label `e2e` y nightly. `wallet-repro-build.yml` compila cada frontend dos veces en jobs distintos y compara manifests. Jobs cubiertos: lint, typecheck, tests, fork tests, fuzz/invariants, Slither, security scans, builds y builds reproducibles. **Ningún workflow despliega** (los artefactos de release se agregan en P26.T02.a, también sin deploy).
      Verificación: un PR de prueba dispara sólo los workflows del área tocada.
- [x] **P02.T04** — `wallet/docs/CI.md`: matriz de jobs, secretos por Environment y required checks. El agente aplica con `gh api` la branch protection de la rama principal (required checks, revisión de CODEOWNERS, "include administrators", commits firmados; el `gh` del entorno tiene permisos de administrador, verificado el 2026-10-17), carga con `gh secret set` los secrets que usa CI (`BASE_RPC_URL` —la misma URL de local—, `GOOGLE_DRIVE_TEST_*`, `EMAIL_TEST_*` y `EMAIL_PROVIDER_*`) y crea los Environments sin reviewer obligatorio, restringidos a tags `wallet-v*` protegidos por un ruleset, para que la ejecución no frene.
      Verificación: `node scripts/check-docs.mjs` (incluye `docs/CI.md`).

**Tests a implementar:**

- [x] **P02.TST** — el propio pipeline; zizmor sin hallazgos High.
      Verificación: `pnpm ci:local`.

**Checks manuales:**

- [x] **P02.MAN** — verificar con `gh api` que los Environments tienen secretos separados, que `production` sólo acepta tags `wallet-v*` protegidos y que existen los secrets de CI (`BASE_RPC_URL`, `GOOGLE_DRIVE_TEST_*`, `EMAIL_TEST_*`, `EMAIL_PROVIDER_*`).
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** `pnpm ci:local` verde y workflows verdes en el branch.

**Security checks:**

- [x] **P02.SEC** — acciones fijadas por SHA; mínimos permisos; sin secretos en logs de CI (máscaras).
      Verificación: `bash ci/scripts/ci-security.sh`.

**Commits:** `ci(wallet): add per-domain ci scripts and workflows`.

#### CHECKPOINT P02

- [x] build pasa: `pnpm ci:local`.
- [x] tests pasan: `pnpm ci:local`.
- [x] security tests pasan: `bash ci/scripts/ci-security.sh`.
- [x] integración anterior sigue funcionando: `pnpm preflight`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P03:** `pnpm ci:local` verde y workflows de GitHub Actions corriendo en el branch.

---

### P03 — Base fork y contratos externos verificados

**Objetivo:** fijar y verificar on-chain (en el bloque del fork) todas las dependencias externas: Safe, Uniswap, USDC, USDT; dejar el proyecto Foundry con dependencias fijadas.

**Archivos/componentes:** `wallet/config/chains/base-mainnet.json`, `wallet/contracts/foundry.toml`, `remappings.txt`, `lib/` (o Soldeer), `wallet/contracts/test/fork/ExternalContracts.t.sol`, `wallet/scripts/verify-external`, `wallet/docs/EXTERNAL_CONTRACTS.md`.

**Dependencias:** P01.

**Implementación requerida:**

- [x] **P03.T01** — Re-verificar y completar `config/chains/base-mainnet.json` (creado en P00.T03.a): `chainId`, `forkBlockNumber`, `confirmations` (ADR-018), explorer, y para cada contrato externo de §3.2–§3.4: `address`, `codehash`, `source` (URL), `verifiedAt`, `notes` (proxy/implementation para tokens).
      Verificación: JSON Schema propio (`config/chains/schema.json`) valida el archivo.
- [x] **P03.T02** — Inicializar `wallet/contracts` (Foundry): solc exacto (§3.6), `evm_version` compatible con Base (verificar en P03.T03 que el bytecode corre en el fork), `optimizer` habilitado (runs 200, `via_ir` sólo si se justifica), perfiles `default`, `ci` (fuzz 10.000 runs, invariants profundidad 50), `fork`. Dependencias con **Soldeer** fijadas en `soldeer.lock` (versión exacta y checksum del registry; Safe por commit git): `forge-std` 1.17.0, `@openzeppelin-contracts` 5.6.1, `@uniswap-v3-core` 1.0.1 (sólo tests) y `safe-smart-account` 1.5.0 (`dc437e8`). No se usan submódulos porque `.gitmodules` tendría que vivir en la raíz del repositorio (R-02; cambio registrado en §13). `script/verify-deps.sh` compara cada `.sol` instalado con el commit del tag oficial (GitHub por SHA) o con el tarball de npm (integridad sha512) y exige el commit exacto de Safe.
      Verificación: `forge build` OK; `bash script/verify-deps.sh` → `DEPENDENCIAS VERIFICADAS`; PF-25 valida `soldeer.lock`.
- [x] **P03.T03** — `test/fork/ExternalContracts.t.sol` (fork en `FORK_BLOCK_NUMBER`): cada dirección tiene código y `extcodehash` == config; Safe singleton `VERSION()` == versión fijada; `SafeProxyFactory.proxyCreationCode()` hash esperado; USDC/USDT `name/symbol/decimals` (6); pool Uniswap: `factory.getPool(USDC, USDT, fee) == pool`, `token0/token1/fee` correctos, liquidez > 0.
      Verificación: `forge test --match-path test/fork/ExternalContracts.t.sol --fork-url $BASE_RPC_URL --fork-block-number $FORK_BLOCK_NUMBER`.
- [x] **P03.T04** — `scripts/verify-external` (cast): recorre `base-mainnet.json` y verifica codehash en un bloque dado (default `FORK_BLOCK_NUMBER`; `--block latest` para monitoreo en producción). Integrarlo como PF-15.
      Verificación: `bash scripts/verify-external --block $FORK_BLOCK_NUMBER` → todos OK; alterar un codehash en una copia temporal del JSON → FAIL.
- [x] **P03.T05** — `docs/EXTERNAL_CONTRACTS.md`: tabla completa + supuestos de confianza por token (emisor, upgradeability, pausa/blacklist) y por Uniswap/Safe; política ante cambio de implementación de un proxy de token (alerta + revisión, no bloqueo automático de retiros).
      Verificación: `node scripts/check-docs.mjs` y cada dirección de `EXTERNAL_CONTRACTS.md` coincide con `config/chains/base-mainnet.json` (test `node scripts/check-external-docs.mjs`).
- [x] **P03.T06** — Documentar en `docs/runbooks/fork.md` cómo cambiar `FORK_BLOCK_NUMBER` (re-verificar codehash, liquidez y tests; commit dedicado). Incluir la advertencia del upgrade **Denim** de Base (bloques de 200 ms, mainnet previsto para noviembre de 2026): antes de mover el fork a un bloque posterior a Denim, verificar compatibilidad de la versión de Anvil fijada y ajustar `--block-time` y los parámetros de confirmación locales.
      Verificación: `node scripts/check-docs.mjs` (runbook presente y enlazado).

**Tests a implementar:**

- [x] **P03.TST** — P03.T03.
      Verificación: `forge test --match-path test/fork/ExternalContracts.t.sol --fork-url $LOCAL_RPC_URL`.

**Checks manuales:**

- [x] **P03.MAN** — contrastar cada dirección contra la fuente oficial citada.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** fork reproducible y todas las dependencias externas verificadas por codehash en el bloque fijado.

**Security checks:**

- [x] **P03.SEC** — ninguna dirección se acepta sin fuente oficial + verificación on-chain; ningún token falso desplegado.
      Verificación: `bash scripts/verify-external --block $FORK_BLOCK_NUMBER`.

**Commits:** `feat(contracts): pin external base dependencies and fork verification`.

#### CHECKPOINT P03

- [x] build pasa: `forge build` (en `contracts/`).
- [x] tests pasan: `forge test --match-path test/fork/ExternalContracts.t.sol --fork-url $LOCAL_RPC_URL`.
- [x] security tests pasan: `bash scripts/verify-external --block $FORK_BLOCK_NUMBER`.
- [x] integración anterior sigue funcionando: `pnpm preflight && pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P04:** codehash de todas las dependencias externas verificados en el bloque fijado.

---

### P04 — Contratos I: librerías, PolicyRegistry, DestinationWhitelist, DenyAllModuleGuard

**Objetivo:** piezas on-chain sin dependencias del Guard, con tests unitarios completos.

**Archivos/componentes:** `contracts/src/libraries/{SafeSignatureParser.sol,CallDecoder.sol,Roles.sol,OpTypes.sol}`, `contracts/src/interfaces/{ISafe.sol,ITransactionGuard.sol,IModuleGuard.sol,ISecurityGuard.sol,IPolicyRegistry.sol,IDestinationWhitelist.sol,IRotationTimelock.sol,ISwapExecutor.sol,IUniswapV3PoolMinimal.sol}`, `contracts/src/{PolicyRegistry.sol,DestinationWhitelist.sol,DenyAllModuleGuard.sol}`, `contracts/test/unit/*`.

**Dependencias:** P03.

**Implementación requerida:**

- [x] **P04.T01** — Interfaces mínimas tomadas de Safe v1.5.0 (firmas exactas de §3.2: `ITransactionGuard`, `IModuleGuard`, `getStorageAt`, `getOwners`, `getThreshold`, `nonce`, `getTransactionHash`, `getModulesPaginated`, `setGuard`, `setModuleGuard`, `swapOwner`) y de Uniswap v3 (pool `swap`, `token0/token1/fee`, callback). Interfaces propias de §6.
      Verificación: test que compara selectores de las interfaces con los de la Safe real del fork (`bytes4(keccak256(...))` vs código desplegado).
- [x] **P04.T02** — `SafeSignatureParser` [C-PAR-01] + test diferencial [C-PAR-02] contra la Safe real (fork).
      Verificación: `forge test --match-contract SafeSignatureParser --fork-url $LOCAL_RPC_URL` (incluye el diferencial con ≥ 10.000 runs en perfil `ci`).
- [x] **P04.T03** — `CallDecoder` [C-DEC-01..03] con tests de longitud exacta (bytes extra, truncados, selector parcial) y **test parametrizado** que recorre cada selector de autoridad de [C-DEC-03] (`increaseAllowance`, `decreaseAllowance`, `permit` EIP-2612 y DAI, `setApprovalForAll`, `transferFrom`, `authorizeOperator`, `send`, `transferWithAuthorization`, `receiveWithAuthorization`, `transferAndCall`, `approveAndCall`, `safeTransferFrom` ×2, `safeBatchTransferFrom`, cualquier llamada a Permit2) verificando su clasificación como autoridad económica.
      Verificación: `forge test --match-contract CallDecoderTest`.
- [x] **P04.T04** — `PolicyRegistry` [C-POL-01..06]: modos, registros, timelock 24 h, guardianes, revocación inmediata, sucesores de Guard y module guard ([C-POL-06]), eventos.
      Verificación: `forge test --match-contract PolicyRegistryTest`.
- [x] **P04.T05** — `DestinationWhitelist` [C-WHL-01..03].
      Verificación: `forge test --match-contract DestinationWhitelistTest`.
- [x] **P04.T06** — `DenyAllModuleGuard` [C-MGD] + test en fork: `setModuleGuard(DenyAll)` aceptado por Safe 1.5.0 (ERC-165) y cualquier `execTransactionFromModule` revierte.
      Verificación: `forge test --match-contract DenyAllModuleGuardTest --fork-url $LOCAL_RPC_URL`.

**Tests a implementar:**

- [x] **P04.TST** — unit + fuzz de cada contrato; PolicyRegistry: transición BOOTSTRAP→RESTRICTED irreversible, alta antes de 24 h no activa, cancelación por guardián, revocación inmediata, guardián no puede cancelar su propia baja, admin distinto rechazado; Whitelist: activación a las 24 h exactas (`vm.warp`), aislamiento entre Safes, `dest == msg.sender` rechazado.
      Verificación: `forge test`.

**Checks manuales:**

- [x] **P04.MAN** — revisión de NatSpec y eventos.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** `forge test --match-path 'test/unit/*'` verde; cobertura de estos contratos ≥ 95 % líneas.

**Security checks:**

- [x] **P04.SEC** — `slither src/PolicyRegistry.sol src/DestinationWhitelist.sol src/DenyAllModuleGuard.sol src/libraries` sin High/Medium sin triage.
      Verificación: `slither . --config-file slither.config.json --fail-medium` (en `contracts/`).

**Commits:** `feat(contracts): add policy registry, destination whitelist and deny-all module guard`.

#### CHECKPOINT P04

- [x] build pasa: `forge build --sizes`.
- [x] tests pasan: `forge test`.
- [x] security tests pasan: `slither . --config-file slither.config.json --fail-medium` (en `contracts/`).
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P05:** test diferencial del parser verde con ≥ 10.000 runs.

---

### P05 — Contratos II: SecurityGuard, RotationTimelock, SafeBootstrap, WalletFactory

**Objetivo:** núcleo de seguridad integrado con la Safe v1.5.0 real del fork.

**Archivos/componentes:** `contracts/src/{SecurityGuard.sol,RotationTimelock.sol,SafeBootstrap.sol,WalletFactory.sol}` (y `AssistedPolicyEngine.sol` si [C-GRD-16] lo exige), `contracts/test/integration/*`.

**Dependencias:** P04.

**Implementación requerida:**

- [x] **P05.T01** — `RotationTimelock` [C-RTL-01..05].
      Verificación: `forge test --match-contract RotationTimelockTest`.
- [x] **P05.T02** — `SecurityGuard` [C-GRD-01..17] con contexto apilado por Safe en transient storage, inmutable `WALLET_FACTORY` predicho y registro sólo para Safes de la factory.
      Verificación: `forge build --sizes` — si el runtime > 24.576 bytes aplicar [C-GRD-16] y documentar en ADR-003.
- [x] **P05.T03** — `SafeBootstrap` [C-BST-01..02].
      Verificación: `forge test --match-contract SafeBootstrapTest --fork-url $LOCAL_RPC_URL`.
- [x] **P05.T04** — `WalletFactory` [C-FAC-01..06] usando `createProxyWithNonceL2` de la factory real.
      Verificación: `forge test --match-contract WalletFactoryTest --fork-url $LOCAL_RPC_URL`.
- [x] **P05.T05** — `script/DeployCore.s.sol` [C-SCR-01] (con predicción y verificación de la dirección de `WalletFactory`, §6.1) y `VerifyDeployment.s.sol` [C-SCR-02] ejecutables contra el fork.
      Verificación: `bash scripts/deploy-core local` (fondeo con `FundForkAccounts.s.sol`, `forge script script/DeployCore.s.sol --rpc-url $LOCAL_RPC_URL --broadcast` y `forge script script/VerifyDeployment.s.sol --rpc-url $LOCAL_RPC_URL`) → OK; en CI, `ci/scripts/deploy-ephemeral.sh` (red `ci`) en cada corrida del job de contratos.
- [x] **P05.T06** — Tests de integración en fork: creación de Safe y verificación completa; NoOp; transfer a destino whitelisteado activo (OK) y no whitelisteado (revert); approve a executor (OK) / a Permit2 / a otro (revert); propuesta y ejecución de rotación con `vm.warp(48h)`; cancelación por firma de U y por firma de R; camino soberano U+R: retirar Guard, cambiar S, transferir a cualquier dirección (OK sin backend); `msg.sender ≠ S` en asistido (revert); firma S tipo `v=1` (revert en asistido). Cambios soberanos de configuración: U+R ejecutan `enableModule`, `setFallbackHandler`, `setModuleGuard(otro)` y `setModuleGuard(0)` (OK) y luego se verifica que el camino asistido queda deshabilitado (fail-closed, [C-GRD-03] paso 6) hasta que U+R restauran la configuración. **El camino soberano nunca revierte**: `setGuard(0)`, MultiSend vía DELEGATECALL, `execTransaction` anidado y cualquier otra tx U+R pasan. Registro: una Safe creada directo con SafeProxyFactory + SafeBootstrap (sin la factory) o un contrato que imita a una Safe no puede registrarse. Upgrade del Guard [C-GRD-17]: sin sucesor registrado, antes de 48 h o con la propuesta cancelada → revert; completo → OK.
      Verificación: `forge test --match-path 'test/integration/*' --fork-url $LOCAL_RPC_URL`.

**Tests a implementar:**

- [x] **P05.TST** — los de P05.T06 + unit de cada contrato.
      Verificación: `forge test --fork-url $LOCAL_RPC_URL`.

**Checks manuales:**

- [x] **P05.MAN** — inspeccionar con `cast` una Safe creada: owners, threshold, slots de guard/module guard/fallback, `rolesOf`.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** A1, A2, A3, A6, A7, A8, A11, A12, A13, A17 con test explícito verde.

**Security checks:**

- [x] **P05.SEC** — Slither sobre `src/`; revisión manual de cada llamada externa en el Guard.
      Verificación: `slither . --config-file slither.config.json --fail-medium` (en `contracts/`) + `forge test --match-path 'test/integration/*' --fork-url $LOCAL_RPC_URL`.

**Commits:** `feat(contracts): add security guard, rotation timelock and wallet factory`, `feat(wallet): add deterministic safe deployment`.

#### CHECKPOINT P05

- [x] build pasa: `forge build --sizes` (Guard < 24.576 bytes o [C-GRD-16] aplicado).
- [x] tests pasan: `forge test --fork-url $LOCAL_RPC_URL`.
- [x] security tests pasan: `slither . --config-file slither.config.json --fail-medium` (en `contracts/`) + `forge test --match-path 'test/integration/*' --fork-url $LOCAL_RPC_URL`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P06:** Safe creada por la factory alcanza todas las verificaciones de [C-FAC-05] en el fork.

---

### P06 — Contratos III: SwapExecutorV3

**Objetivo:** swaps USDC↔USDT contra el pool real del fork con el diseño de menor riesgo (ADR-015).

**Archivos/componentes:** `contracts/src/SwapExecutorV3.sol`, `contracts/test/fork/Swap*.t.sol`, `docs/adr/ADR-015-*.md` (análisis completo de alternativas: router, UniversalRouter+Permit2, v4, MultiSend).

**Dependencias:** P05.

**Implementación requerida:**

- [x] **P06.T01** — `SwapExecutorV3` [C-SWP-01..05].
      Verificación: `forge test --match-contract SwapExecutorV3Test --fork-url $LOCAL_RPC_URL`.
- [x] **P06.T02** — Registro del executor y de USDC/USDT en `PolicyRegistry`; integración con [C-GRD-07]/[C-GRD-09].
      Verificación: `forge test --match-contract SwapGuardIntegrationTest --fork-url $LOCAL_RPC_URL`.
- [x] **P06.T03** — Tests en fork: USDC→USDT y USDT→USDC reales (saldos verificados, executor sin fondos, allowance final 0); fill parcial (monto que excede liquidez) → revert y el callback **nunca** paga un monto distinto del delta pedido por el pool; `minOut` bajo el piso → revert; deadline vencido → revert; token arbitrario → revert; callback llamado por un no-pool → revert; reentrancia → revert; recipient distinto de la Safe imposible por construcción; approve residual sin swap no utilizable por terceros (un atacante que llama `swap` paga con **su** allowance, no la de la Safe).
      Verificación: `forge test --match-path 'test/fork/Swap*.t.sol' --fork-url $LOCAL_RPC_URL`.
- [x] **P06.T04** — Script de cotización de referencia (QuoterV2 `eth_call`) usado por los tests para validar `minOut`.
      Verificación: `forge test --match-contract QuoteReferenceTest --fork-url $LOCAL_RPC_URL`.

**Tests a implementar:**

- [x] **P06.TST** — P06.T03 + fuzz de montos (1 unidad … 10.000 tokens) y slippage.
      Verificación: `forge test --fork-url $LOCAL_RPC_URL`.

**Checks manuales:**

- [x] **P06.MAN** — comparar resultado del swap en fork con la cotización QuoterV2 al mismo bloque.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** A15 y A16 verdes; ADR-015 con el análisis escrito.

**Security checks:**

- [x] **P06.SEC** — Slither; verificación de que no existe ninguna ruta de `transferFrom` con payer ≠ `msg.sender`.
      Verificación: `slither . --config-file slither.config.json --fail-medium` (en `contracts/`) + `forge test --match-path 'test/fork/Swap*.t.sol' --fork-url $LOCAL_RPC_URL`.

**Commits:** `feat(swap): add restricted usdc usdt swap executor`.

#### CHECKPOINT P06

- [x] build pasa: `forge build --sizes`.
- [x] tests pasan: `forge test --fork-url $LOCAL_RPC_URL`.
- [x] security tests pasan: `slither . --config-file slither.config.json --fail-medium` (en `contracts/`) + `forge test --match-path 'test/fork/Swap*.t.sol' --fork-url $LOCAL_RPC_URL`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P07:** swaps reales en fork en ambos sentidos con post-condiciones del Guard verificadas.

---

### P07 — Contratos IV: suite adversarial, fuzz/invariants, cobertura, Slither, deploy/seed local

**Objetivo:** demostrar las invariantes de seguridad y dejar `deploy-local`/`seed-local` reproducibles; exportar ABIs y vectores.

**Archivos/componentes:** `contracts/test/adversarial/*.t.sol`, `contracts/test/invariant/{handlers/*,WalletInvariants.t.sol}`, `contracts/test/vectors/*.json` + generador, `contracts/script/{DeployLocal.s.sol,SeedLocal.s.sol,ExportAbis.s.sol}`, `wallet/scripts/{deploy-local,seed-local}`, `contracts/slither.config.json`, `contracts/deployments/local.json` (gitignored).

**Dependencias:** P06.

**Implementación requerida:**

- [x] **P07.T01** — Suite adversarial `test/adversarial/` (un test por ataque, prompt §28; cada subtarea = un contrato de test que **demuestra que el ataque falla**). Corre en los dos modos de policy (P07.T09).
      Verificación: `forge test --match-path 'test/adversarial/*' --fork-url $LOCAL_RPC_URL` (todas las subtareas en verde).
  - [x] **P07.T01.a** — send a destino no whitelisteado (y a destino pendiente de activación, y a destino de otra Safe).
  - [x] **P07.T01.b** — DELEGATECALL en camino asistido.
  - [x] **P07.T01.c** — ejecución por módulo (con y sin módulo habilitado soberanamente) y llamada al fallback.
  - [x] **P07.T01.d** — parámetros de gas/refund: `safeTxGas`, `baseGas`, `gasPrice` ≠ 0, `gasToken` ≠ 0, `refundReceiver` ≠ 0 (vector de drenaje por refund) y `value` ≠ 0 en camino asistido.
  - [x] **P07.T01.e** — executor incorrecto (`msg.sender ≠ S`) y combinación de signers incorrecta.
  - [x] **P07.T01.f** — U sola, R sola, S sola (threshold y clasificación).
  - [x] **P07.T01.g** — firmas malformadas: longitud, `v` inválido, orden, duplicadas, tipos `v=0/1/>30` en asistido, bytes anexados para engañar la clasificación.
  - [x] **P07.T01.h** — replay en otro nonce, otra Safe y otra cadena; nonce incorrecto.
  - [x] **P07.T01.i** — bypass de rotación y de timelock (ejecutar antes de 48 h, con old ≠ rol, propuesta cancelada, R proponiendo rol R).
  - [x] **P07.T01.j** — swap de token arbitrario, recipient arbitrario, calldata maliciosa (longitud/encoding), minOut bajo el piso.
  - [x] **P07.T01.k** — allowance persistente: approve a Permit2, router, otro spender; cada selector de autoridad de [C-DEC-03].
  - [x] **P07.T01.l** — inicialización de factory: Safe sin bootstrap, re-setup, front-run de `createWallet`, initializer alterado.
  - [x] **P07.T01.m** — implementación de Safe incorrecta (otro singleton/versión/proxy factory).
  - [x] **P07.T01.n** — cambios administrativos asistidos: `addOwnerWithThreshold`, `removeOwner`, `changeThreshold`, `setGuard`, `setModuleGuard`, `enableModule`, `setFallbackHandler`, `approveHash`, `execTransaction` anidado.
  - [x] **P07.T01.o** — migración no autorizada y R+S intentando operar como U+S (send, swap, whitelist add).
  - [x] **P07.T01.p** — suplantación de registro: contrato que imita las vistas de una Safe, Safe creada sin la factory, re-registro de una Safe ya registrada.
  - [x] **P07.T01.q** — el Guard nunca bloquea el camino soberano: `setGuard(0)`, `setModuleGuard(0)`, MultiSend vía DELEGATECALL, `execTransaction` anidado, transferencias a cualquier destino.
  - [x] **P07.T01.r** — upgrade del Guard: sucesor no registrado, propuesta inmadura o cancelada, `setGuard` hacia un contrato arbitrario en camino asistido.
- [x] **P07.T02** — Invariant tests con handlers (actores U, R, S, atacante, relayer; operaciones aleatorias asistidas y soberanas, warps de tiempo): A1–A17 como invariantes (`invariant_*`), p. ej. "ningún saldo sale de la Safe hacia un destino no whitelisteado por camino asistido", "allowance a terceros siempre 0", "roles del Guard == owners tras cualquier secuencia asistida", "ninguna tx asistida exitosa tuvo gas params, gasToken, refundReceiver o value ≠ 0", "toda tx U+R con firmas válidas se ejecuta (el Guard nunca la revierte)".
      Verificación: `forge test --profile ci --match-path 'test/invariant/*'`.
- [x] **P07.T03** — Cobertura: `forge coverage --report lcov --report summary` ≥ 95 % líneas y ≥ 90 % ramas en `src/`.
      Verificación: `forge coverage --report summary` cumple ≥ 95 % líneas y ≥ 90 % ramas en `src/` (el script de CI falla si no).
- [x] **P07.T04** — Slither 0.11.6 con `slither.config.json` (excluye `lib/` y `test/`); cada hallazgo resuelto o justificado en `docs/security/slither-triage.md` (no `disable` sin justificación).
      Verificación: `slither . --config-file slither.config.json --fail-medium` y `docs/security/slither-triage.md` sin hallazgos abiertos.
- [x] **P07.T05** — Vectores cruzados `test/vectors/*.json` (SafeTxHash por tipo de operación, calldata, firmas EIP-712 de ejemplo con claves de test, direcciones CREATE2 predichas, typed data de `CancelRotation`) + `pnpm`-agnóstico: script `contracts/script/export-vectors.sh`.
      Verificación: `bash script/export-vectors.sh && git diff --exit-code test/vectors` (regenerar no produce cambios).
- [x] **P07.T06** — Export de ABIs (`contracts/script/export-abis.sh`) a `contracts/out-abi/*.json`; cada consumidor (backend, signer, wallet, recovery) los copia a su propio directorio en su fase con check de igualdad en CI.
      Verificación: `bash script/export-abis.sh && git diff --exit-code out-abi`.
- [x] **P07.T07** — Agregar `deploy-local` y `seed-local` a los scripts de `wallet/package.json`; `scripts/deploy-local` (corre `DeployLocal.s.sol` contra Anvil, escribe `deployments/local.json`, idempotente: si ya hay deploy para este estado del fork lo verifica) y `scripts/seed-local` [C-SCR-03] determinístico; `pnpm fork:reset && pnpm deploy-local && pnpm seed-local` produce siempre las mismas direcciones y saldos.
      Verificación: `pnpm fork:reset && pnpm deploy-local && pnpm seed-local` dos veces → mismas direcciones y saldos (`diff` de `deployments/local.json`).
- [x] **P07.T08** — `docs/security/invariants.md`: mapa assertion → test.
      Verificación: `node scripts/check-docs.mjs` y cada A1–A17 tiene al menos un test listado.
- [x] **P07.T09** — Perfiles de policy: `deploy-local --policy-mode restricted` (default, igual que producción, set V1 de [C-POL-04]) y `--policy-mode bootstrap` (desarrollo de contratos). CI corre P07.T01–T02 en **ambos** modos; en RESTRICTED se verifica además que operaciones desconocidas y tokens no soportados revierten ([C-GRD-03] paso 7, [C-GRD-06]).
      Verificación: `POLICY_MODE=restricted forge test --profile ci` y `POLICY_MODE=bootstrap forge test --profile ci`.

**Tests a implementar:**

- [x] **P07.TST** — P07.T01–T02.
      Verificación: `POLICY_MODE=restricted forge test --profile ci && POLICY_MODE=bootstrap forge test --profile ci`.

**Checks manuales:**

- [x] **P07.MAN** — revisión independiente del triage de Slither por un agente revisor (contexto nuevo); cada objeción se resuelve o se documenta con su justificación.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** todos los ataques del prompt §28 con test que **falla el ataque**; invariantes verdes en perfil `ci`; cobertura en umbral; seed reproducible.

**Security checks:**

- [x] **P07.SEC** — Slither + Semgrep (reglas Solidity) sin hallazgos abiertos.
      Verificación: `slither . --config-file slither.config.json --fail-medium` (en `contracts/`) + `bash ci/scripts/ci-security.sh` (Semgrep Solidity) + suite adversarial.

**Commits:** `test(security): add wallet invariants and adversarial tests`, `chore(contracts): add deterministic local deploy and seed`.

#### CHECKPOINT P07

- [x] build pasa: `forge build --sizes`.
- [x] tests pasan: `POLICY_MODE=restricted forge test --profile ci && POLICY_MODE=bootstrap forge test --profile ci`.
- [x] security tests pasan: `slither . --config-file slither.config.json --fail-medium` (en `contracts/`) + `bash ci/scripts/ci-security.sh` (Semgrep Solidity) + suite adversarial.
- [x] integración anterior sigue funcionando: `pnpm preflight && pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P08:** contratos congelados para V1 (cambios posteriores requieren re-ejecutar P07 completo).

---

### P08 — Backend I: fundaciones

**Objetivo:** proyecto `wallet/backend/app` con configuración validada, Postgres + migraciones, Valkey/BullMQ, cliente RPC de quórum, logging con redacción, métricas, health, OpenAPI/Swagger, errores RFC 9457, idempotencia, rate limiting y audit log append-only.

**Archivos/componentes:** `backend/app/package.json` + `pnpm-lock.yaml`, `tsconfig.json`, `src/config/env.ts` (Zod), `src/db/{kysely.ts,migrations/*,repositories/*}`, `src/queue/{queues.ts,outbox-dispatcher.ts}`, `src/chain/{rpc-quorum.ts,abis/*,safe-tx.ts,decoders/*}`, `src/observability/{logger.ts,redaction.ts,metrics.ts}`, `src/api/{server.ts,plugins/*,errors.ts,openapi.ts}`, `src/audit/audit-writer.ts`, `test/**`.

**Dependencias:** P07 (ABIs, vectores y deploy local).

**Implementación requerida:**

- [x] **P08.T01** — Crear el proyecto con versiones exactas (§3.6): Fastify 5, Zod 4, `fastify-type-provider-zod`, `@fastify/swagger`, `@fastify/swagger-ui`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, Kysely + `pg`, BullMQ + `ioredis`, viem, pino, prom-client, `jose`, `@node-rs/argon2`, `@serenity-kit/opaque`, `otpauth`, `nodemailer`; dev: TypeScript 6.0.x, Vitest, Testcontainers, ESLint + typescript-eslint, Prettier. Settings de supply chain de P01.T05.
      Verificación: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint`.
- [x] **P08.T02** — `src/config/env.ts`: schema Zod por `APP_ENV` (local/staging/production); toda variable secreta acepta también `<VAR>_FILE` (lectura del secret de Docker Compose en `/run/secrets/…`, ADR-030) y en staging/prod **exige** la forma `_FILE`; falla si detecta valores de ejemplo o secretos con baja entropía; nunca imprime valores. (El mismo patrón se replica, implementado por separado, en `backend/signer` y `backend/integrity-monitor`.)
      Verificación: tests de configuración (faltante, formato inválido, valor de ejemplo en prod → error).
- [x] **P08.T03** — Migraciones iniciales con **todas** las tablas de [B-DB] (constraints, FKs, índices únicos parciales, CHECKs, trigger append-only de `audit_events`, roles y GRANTs). `pnpm db:migrate`, `pnpm db:status`, `pnpm db:backup`, `pnpm db:restore`.
      Verificación: test de integración que aplica migraciones sobre Postgres 18 (Testcontainers) y verifica: UPDATE/DELETE en `audit_events` falla; índice parcial impide dos operaciones activas con el mismo nonce; `wallet_keys_metadata` impide claves duplicadas.
- [x] **P08.T04** — Repositorios con límites transaccionales explícitos (`withTransaction(fn)` con `SERIALIZABLE` donde se asignan nonces o se transicionan estados; reintento ante `40001`).
      Verificación: `pnpm --dir backend/app vitest run test/integration/repositories.test.ts` (incluye reintento ante `40001`).
- [x] **P08.T05** — `RpcQuorumClient` [B-RPC] con health checks, lecturas en bloque común, comparación y reintentos; métricas por proveedor.
      Verificación: tests con dos Anvil (mismo fork) y con el proxy de inyección de fallas (timeouts, respuesta divergente, chainId incorrecto).
- [x] **P08.T06** — Codificación SafeTx/EIP-712 y decoders de calldata tipificados (`src/chain/safe-tx.ts`, `src/chain/decoders/*`) validados contra `contracts/test/vectors/*.json` (copia local en `backend/app/test/vectors/`, CI verifica igualdad con la fuente).
      Verificación: `pnpm --dir backend/app vitest run test/chain/safe-tx-vectors.test.ts`.
- [x] **P08.T07** — Logger pino con redacción [B-OBS] + tests de canario; métricas base; `/health`, `/health/live`, `/health/ready` (DB, Valkey, RPC, migraciones al día).
      Verificación: `pnpm --dir backend/app vitest run test/observability` (canarios de logs) y `curl -s localhost:8080/api/v1/health/ready`.
- [x] **P08.T08** — Servidor Fastify con dos listeners (Wallet 8080 / Recovery 8081) y `client` derivado del listener; helmet; CORS estricto por listener (sólo el origin de su frontend, `credentials: true`); límites de body; errores RFC 9457; `requestId`.
      Verificación: `pnpm --dir backend/app vitest run test/api/server-cors.test.ts`.
- [x] **P08.T09** — OpenAPI 3.1 generado desde schemas Zod; Swagger UI en `/docs` con comportamiento por entorno (§7.11); test que falla si una ruta no tiene schema de request/response/errores documentado.
      Verificación: `pnpm --dir backend/app vitest run test/api/openapi-coverage.test.ts` y `curl -s localhost:8080/docs/openapi.json | head -c 200`.
- [x] **P08.T10** — Idempotencia (`Idempotency-Key`, tabla `idempotency_keys`, hash del request, respuesta repetida; conflicto si mismo key con distinto body → 422).
      Verificación: `pnpm --dir backend/app vitest run test/api/idempotency.test.ts`.
- [x] **P08.T11** — Rate limiting [B-RL] con store Valkey y claves por IP/usuario/sesión/Safe.
      Verificación: `pnpm --dir backend/app vitest run test/api/rate-limit.test.ts`.
- [x] **P08.T12** — Audit writer: cadena HMAC [B-AUD], `pnpm audit:verify`; outbox dispatcher [B-Q-01] con BullMQ (`jobId` = id de agregado).
      Verificación: `pnpm --dir backend/app vitest run test/audit test/queue/outbox.test.ts` y `pnpm --dir backend/app audit:verify`.

**Tests a implementar:**

- [x] **P08.TST** — unit (config, decoders, SafeTx hash vs vectores, redacción), integración (migraciones, repositorios, outbox, RPC quórum, rate limit, idempotencia, audit chain), API (health, docs, errores).
      Verificación: `pnpm --dir backend/app test`.

**Checks manuales:**

- [x] **P08.MAN** — abrir `http://localhost:8080/docs` y `:8081/docs`; verificar que la spec lista sólo lo correspondiente a cada listener.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** backend arranca contra compose + fork; migraciones idempotentes; outbox resiliente a flush de Valkey; audit verificable.

**Security checks:**

- [x] **P08.SEC** — canarios de logs; `audit_events` inmodificable por `mtw_app`; CORS rechaza otros origins; ninguna ruta sin schema.
      Verificación: `pnpm --dir backend/app test:security && bash ci/scripts/ci-security.sh`.

**Commits:** `feat(backend): add service foundations, schema and observability`.

#### CHECKPOINT P08

- [x] build pasa: `pnpm --dir backend/app build`.
- [x] tests pasan: `pnpm --dir backend/app test`.
- [x] security tests pasan: `pnpm --dir backend/app test:security && bash ci/scripts/ci-security.sh`.
- [x] integración anterior sigue funcionando: `pnpm ci:local` (incluye contratos).
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P09:** fundaciones verdes en CI.

---

### P09 — Backend II: cuenta, autenticación y email

**Objetivo:** cuenta centralizada production-grade [B-AUTH] + proveedor de email real [B-MAIL].

**Archivos/componentes:** `src/auth/{password.ts,sessions.ts,csrf.ts,totp.ts,otp.ts,risk.ts}`, `src/api/routes/v1/{auth,sessions,users}.ts`, `src/email/{provider.ts,mailgun.ts,smtp.ts,templates/*}`.

**Dependencias:** P08.

**Implementación requerida:**

- [x] **P09.T01** — Registro + verificación de email [B-AUTH-01/02] (OTP 8 dígitos hash HMAC con `OTP_HMAC_KEY`, comparación en tiempo constante).
      Verificación: `pnpm --dir backend/app vitest run test/auth/register-verify.test.ts`.
- [x] **P09.T02** — Login/logout/sesiones/rotación/expiración/revocación [B-AUTH-03/04/06]; listado de sesiones con dispositivo y última actividad.
      Verificación: `pnpm --dir backend/app vitest run test/auth/sessions.test.ts`.
- [x] **P09.T03** — CSRF [B-AUTH-05] y verificación de `Origin`.
      Verificación: `pnpm --dir backend/app vitest run test/security/csrf.test.ts`.
- [x] **P09.T04** — Forgot/reset password [B-AUTH-07]; test explícito: reset no modifica `opaque_records` ni metadatos de claves.
      Verificación: `pnpm --dir backend/app vitest run test/auth/reset-password.test.ts` (incluye el caso "reset no toca OPAQUE ni metadatos de claves").
- [x] **P09.T05** — Brute force, lockout blando y señales de riesgo [B-AUTH-08].
      Verificación: `pnpm --dir backend/app vitest run test/security/bruteforce-totp.test.ts`.
- [x] **P09.T06** — TOTP + códigos de recuperación [B-AUTH-09].
      Verificación: `pnpm --dir backend/app vitest run test/auth/totp.test.ts`.
- [x] **P09.T07** — `EmailProvider` (Mailgun + SMTP/Mailpit) con outbox y reintentos; plantillas [B-MAIL-02/03] con tests de snapshot que verifican presencia de acción, dirección completa, red y expiración.
      Verificación: `pnpm --dir backend/app vitest run test/email` (snapshots de plantillas) y email visible en Mailpit (`http://localhost:8025`).
      Verificación adicional (si `EMAIL_PROVIDER_API_KEY` presente): envío real con token de servidor de staging a una casilla de prueba.

**Tests a implementar:**

- [x] **P09.TST.a** — credenciales inválidas y enumeración de usuarios (respuesta y tiempo uniformes).
      Verificación: `pnpm --dir backend/app vitest run test/security/auth-login.test.ts`.
- [x] **P09.TST.b** — sesión expirada (idle y absoluta), sesión revocada, logout invalida sesión y PlatformSessions.
      Verificación: `pnpm --dir backend/app vitest run test/security/sessions.test.ts`.
- [x] **P09.TST.c** — CSRF ausente/incorrecto, `Origin` extraño, `Content-Type` no JSON.
      Verificación: `pnpm --dir backend/app vitest run test/security/csrf.test.ts`.
- [x] **P09.TST.d** — OTP expirado, OTP reusado, OTP con > 5 intentos, token de reset reusado o reemplazado.
      Verificación: `pnpm --dir backend/app vitest run test/security/otp-reset.test.ts`.
- [x] **P09.TST.e** — lockout blando, rate limits de login/forgot, TOTP replay y códigos de recuperación de un solo uso.
      Verificación: `pnpm --dir backend/app vitest run test/security/bruteforce-totp.test.ts`.
- [x] **P09.TST.f** — atributos de cookies (`__Host-`, HttpOnly, Secure, SameSite=Strict, Path=/) y que la API nunca devuelve tokens de sesión en el body.
      Verificación: `pnpm --dir backend/app vitest run test/security/cookies.test.ts`.
- [x] **P09.TST.g** — adaptador `mailgun` contra la **API real de Mailgun** con el dominio sandbox: cada plantilla se envía a la casilla autorizada `EMAIL_TEST_ADDRESS` y el test confirma el evento `delivered` en la Events API.
      Verificación: `pnpm --dir backend/app vitest run test/email/mailgun.live.test.ts`.
- [x] **P09.TST.h** — entrega real de punta a punta: la verificación de email, los OTP y el reset de password salen por Mailgun (dominio sandbox, remitente `no-reply@<EMAIL_PROVIDER_DOMAIN>`) hacia la casilla real `EMAIL_TEST_ADDRESS`, y el test lee cada código con la **Gmail API** (OAuth 2.0, scope `gmail.readonly`: `users.messages.list` con una consulta que incluye un identificador único del envío e `includeSpamTrash=true` —el dominio sandbox compartido suele caer en spam—, y `users.messages.get`) y completa el flujo; sin mocks y sin tokens en logs.
      Verificación: `pnpm --dir backend/app vitest run test/email/real-delivery.live.test.ts`.

**Checks manuales:**

- [x] **P09.MAN** — recorrer el flujo en Mailpit (`http://localhost:8025`) y revisar textos de emails.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** todos los flujos de cuenta del prompt §7 funcionan contra API real; tests de seguridad verdes.

**Security checks:**

- [x] **P09.SEC** — no se guardan tokens en localStorage (no aplica en backend, pero la API no devuelve tokens de sesión en el body); hashes con pepper; tiempos uniformes.
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(auth): add account and session management`, `feat(backend): add transactional email provider`.

#### CHECKPOINT P09

- [x] build pasa: `pnpm --dir backend/app build`.
- [x] tests pasan: `pnpm --dir backend/app test`.
- [x] security tests pasan: `pnpm --dir backend/app test:security`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs` + OpenAPI de auth en `/docs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P10:** suite de seguridad de autenticación verde.

---

### P10 — Backend III: PlatformSession

**Objetivo:** [B-PSES] completo: OPAQUE con AuthSecret_U, step-up, tokens EdDSA, session keys y requests críticos firmados.

**Archivos/componentes:** `src/platform-session/{opaque.ts,step-up.ts,token.ts,request-signature.ts,plugin.ts}`, rutas `/platform-sessions/*`, script `opaque:setup`, `dev:session`.

**Dependencias:** P09.

**Implementación requerida:**

- [x] **P10.T01** — `pnpm --dir backend/app opaque:setup` genera `OPAQUE_SERVER_SETUP` (sólo local; en staging/prod se genera una vez con `scripts/deploy/init-secrets.sh` y se monta como Docker Compose secret, ADR-030). PF-29 pasa a obligatorio.
      Verificación: PF-29 en verde (`pnpm preflight`).
- [x] **P10.T02** — Registro OPAQUE ligado a `wallet_id` + `key_version` (estado PENDING hasta que U se confirma on-chain como owner; ACTIVE después).
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/opaque-registration.test.ts`.
- [x] **P10.T03** — Login OPAQUE (estado de servidor en Valkey con TTL 60 s, un solo uso) + binding de `sessionPublicKey` [B-PSES-02] → PlatformSession `OPERATIONS`.
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/opaque-login.test.ts`.
- [x] **P10.T04** — Step-up [B-PSES-03] → scopes restringidos.
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/step-up.test.ts`.
- [x] **P10.T05** — Token JWS EdDSA [B-PSES-04] + plugin Fastify que valida token, revocación, sesión de cuenta padre, scope por ruta.
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/token-scopes.test.ts`.
- [x] **P10.T06** — Firma de requests críticos y anti-replay [B-PSES-05]; verificación de envelope de envío [B-PSES-06] (librería reutilizada por el worker; el signer tiene su propia implementación en P11).
      Verificación: `pnpm --dir backend/app vitest run test/platform-session/request-signature.test.ts`.
- [x] **P10.T07** — `dev:session` (sólo `APP_ENV=local`): realiza login de cuenta + OPAQUE de un usuario de prueba con su Password U y emite el material para Swagger; no existe endpoint equivalente.
      Verificación: `APP_ENV=local pnpm --dir backend/app dev:session` emite material y con `APP_ENV=staging` se niega; check manual en Swagger.

**Tests a implementar:**

- [x] **P10.TST** — OPAQUE ida y vuelta; password U incorrecta → falla sin filtrar información; token expirado/revocado; scope incorrecto (step-up intentando operar); firma de request inválida, timestamp fuera de ventana, nonce repetido; logout revoca PlatformSessions; reset de password revoca PlatformSessions.
      Verificación: `pnpm --dir backend/app test`.

**Checks manuales:**

- [x] **P10.MAN** — Swagger "Try it out" de un endpoint crítico con el material de `dev:session`.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** ninguna ruta crítica acepta requests sin PlatformSession válida y firma correcta.

**Security checks:**

- [x] **P10.SEC** — el servidor nunca recibe Password U ni AuthSecret_U (inspección de payloads en tests); `OPAQUE_SERVER_SETUP` sólo desde env/Docker Compose secret (`*_FILE`).
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(auth): add opaque-based platform sessions and signed critical requests`.

#### CHECKPOINT P10

- [x] build pasa: `pnpm --dir backend/app build`.
- [x] tests pasan: `pnpm --dir backend/app test`.
- [x] security tests pasan: `pnpm --dir backend/app test:security`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P11:** PlatformSession end-to-end verde.

---

### P11 — Signer S

**Objetivo:** signer **self-hosted** independiente por shard [B-SIG] con `SignerProvider` (development, selfhosted, hardware futuro), ciclo de vida completo de keystores [B-SIG-08], sharding [B-SIG-09], política propia basada en snapshot firmado, estado propio, mTLS y gas tank/relayer.

**Archivos/componentes:** `wallet/backend/signer/` (proyecto propio): `src/server.ts` (HTTPS mTLS), `src/policy/*` (implementación **independiente**), `src/chain/*` (RPC propio de quórum, SafeTx), `src/state/*` (PostgreSQL propio del signer, migraciones propias), `src/providers/{SignerProvider.ts,SelfHostedSoftwareSignerProvider.ts,DevelopmentSignerProvider.ts,HardwareSignerProvider.ts}`, `src/keystore/{v3.ts,derive-password.ts,atomic-write.ts,fingerprint.ts}`, `scripts/{create-shard.ts,restore-verify.ts,rotate-unlock-credential.ts,shard-migrate.ts}`; `wallet/config/policy/<env>/policy-snapshot.json(.sig)`; en `backend/app`: `src/signer-client/*`, `src/gas/*`.

**Dependencias:** P10.

**Implementación requerida:**

- [x] **P11.T01** — Interfaz `SignerProvider` [B-SIG-04] y `DevelopmentSignerProvider` = `SelfHostedSoftwareSignerProvider` con guardas: **se niega a arrancar** si `APP_ENV != local` o si el RPC no es un fork Anvil (`anvil_nodeInfo.forkConfig` presente); keystores en `wallet/.secrets/signer/dev-1/keystore/` y credencial en `wallet/.secrets/signer/dev-1/unlock.key` (generada por `secrets:local`, fuera del directorio de keystores). Nunca escribe claves en DB, `.env`, logs, código ni respuestas de API.
      Verificación: `pnpm --dir backend/signer vitest run test/providers/development.test.ts` (incluye negativa fuera de Anvil).
- [x] **P11.T02** — Servidor mTLS [B-SIG-01]; `POST /v1/sign-safe-tx` [B-SIG-02], `POST /v1/keys` (crear S para un wallet), `GET /v1/health`. Cliente mTLS en `backend/app/src/signer-client`.
      Verificación: `pnpm --dir backend/signer vitest run test/server-mtls.test.ts`.
- [x] **P11.T03** — Política independiente del signer: decodificación desde bytes de SafeTx, tabla de operaciones por rol y scope [B-POL-03]/[W-07], límites y ledger 24 h, verificación de PlatformSession token (clave pública del emisor fijada) con validez al momento del envío y antigüedad ≤ 24 h [B-PSES-06], envelope de envío, atestación de challenge (whitelist/2FA), lectura on-chain con su RPC (nonce, roles del Guard, **configuración de la Safe — paso 7b de [B-Q-02]**, whitelist activa, saldo, rotaciones), simulación `eth_call`, regla "una SafeTx activa por (safe, nonce)" [B-SIG-03], rotación de S sólo hacia claves propias, `KeyAcceptance` para U'/R', emparejamiento approve/swap, pausa por integridad (atestación vigente requerida cuando `INTEGRITY_REQUIRED=true`).
      Verificación: `pnpm --dir backend/signer vitest run test/policy` (tabla completa de rechazos) y vectores compartidos.
- [x] **P11.T04** — Snapshot de policy firmado [B-POL-01]: `config/policy/local/policy-snapshot.json` (los de staging/production se generan en P25.T07, cuando existen sus direcciones); herramienta `pnpm --dir backend/signer policy:sign` (sólo con clave local de dev; en staging/producción, durante la ejecución, firma con la clave de policy de cada entorno generada en `~/.config/mtw/secrets/<entorno>/` (fuera del repo); en el despliegue final se re-firma offline) y `policy:verify`; anti-rollback.
      Verificación: `pnpm --dir backend/signer policy:verify config/policy/local/policy-snapshot.json` y test de anti-rollback.
- [x] **P11.T05** — Reglas estáticas restrictivas [B-SIG-06] evaluadas antes de cualquier I/O: typed data `SafeTx` con `chainId == 8453`, `operation == 0`, gas params en cero, `to`/selector dentro de la allowlist del sistema; tx a firmar por la clave S con `to == Safe asociada`, selector `execTransaction`, `value == 0`, tope de gas/fees; para la cuenta gas tank sólo transferencias de ETH a S registradas (≤ tope), `WalletFactory.createWallet` y `RotationTimelock.cancelWithSignature`. Tabla de casos de rechazo en tests.
      Verificación: `pnpm --dir backend/signer vitest run test/policy/static-rules.test.ts`.
- [x] **P11.T06** — `SelfHostedSoftwareSignerProvider` [B-SIG-08] (producción/staging): create, load, unlock y restart con keystores Ethereum V3 (scrypt de `@noble/hashes`, AES-128-CTR de `node:crypto`, MAC keccak), contraseñas derivadas por HKDF de la credencial del shard leída de `SIGNER_UNLOCK_CREDENTIAL_FILE` (secret de Compose), escritura atómica, `credentialFingerprint`, firma con `@noble/curves` (low-s, RFC 6979) y cálculo de `v`. Interoperabilidad: tests que descifran los keystores generados con `cast wallet decrypt-keystore` del Foundry fijado y que verifican vectores oficiales del formato V3.
      Verificación: `pnpm --dir backend/signer vitest run test/providers/selfhosted.test.ts test/keystore` (incluye interop con `cast`).
- [x] **P11.T07** — `HardwareSignerProvider` (futuro opcional, HSM físico propio vía PKCS#11/YubiHSM): interfaz, suite de contrato común (la misma que corren los otros providers) y runbook `docs/runbooks/signer-hardware-migration.md` (migración Safe por Safe rotando S por el timelock); **no se implementa contra hardware en V1**. Documentar en ADR-014 la evaluación de Clef y Web3Signer (§3.5).
      Verificación: `pnpm --dir backend/signer vitest run test/providers/contract-suite.test.ts` (corre contra Development y SelfHosted) y runbook presente (`node scripts/check-docs.mjs`).
- [x] **P11.T08** — Sharding [B-SIG-09]: asignación de wallet a shard por hash estable de `walletId` sobre los shards activos al crearla, **guardada** (no se recalcula); registro en `signer_keys`; un shard `dev-1` en local; el software y los tests soportan N shards (dos shards locales en los tests de integración), aunque en producción inicialmente compartan host físico.
      Verificación: `pnpm --dir backend/app vitest run test/signer-client/sharding.test.ts` y `pnpm --dir backend/signer vitest run test/multi-shard.test.ts`.
- [x] **P11.T09** — Gas tank/relayer [B-SIG-05]: job de recarga (mín./objetivo/tope diario), retransmisión de cancelaciones firmadas, deploy de Safes; métricas de saldos.
      Verificación: `pnpm --dir backend/app vitest run test/gas/gas-tank.test.ts` contra el fork.
- [x] **P11.T10** — Procedimientos del ciclo de vida [B-SIG-08] como scripts + runbooks (`docs/runbooks/signer-lifecycle.md`), cada uno con test que lo ejecuta en local: backup cifrado con `age` (sin la credencial), restore + `restore-verify`, rotación de la credencial del shard (re-cifrado de todos los keystores), keystore corrupto o faltante (`BROKEN` + restore), migración de wallets entre shards (dos fases), y custodia offline de la credencial de desbloqueo (dos copias selladas, custodios distintos).
      Verificación: `pnpm --dir backend/signer vitest run test/lifecycle` (cada procedimiento ejecutado de punta a punta sobre un shard de prueba).
- [x] **P11.T11** — `SignerKeyAttestation` [B-SIG-07]/[W-03]: clave de atestación Ed25519 del signer por entorno (pública exportada para los frontends), emitida en `POST /v1/keys`.
      Verificación: `pnpm --dir backend/signer vitest run test/attestation.test.ts`.

**Tests a implementar:**

- [x] **P11.TST** — unit de política del signer contra vectores compartidos (mismo resultado que backend para cada caso), integración backend↔signer por mTLS (cert inválido → rechazo), firma S nunca emitida si cualquier check falla (tabla de casos: firma U inválida, sesión vencida, envelope ausente, nonce on-chain distinto, whitelist inactiva, saldo insuficiente, simulación revierte, policy snapshot inválido o con versión menor, pausa de integridad, regla estática violada), regla (safe, nonce), ledger diario, dev signer se niega fuera de Anvil, suite de contrato común a todos los `SignerProvider` (firma recuperable a la dirección, low-s, `v` correcto).
      Verificación: `pnpm --dir backend/signer test && pnpm --dir backend/app test`.

**Checks manuales:**

- [x] **P11.MAN** — inspeccionar que ningún log del signer contiene material sensible; revisar la tabla de reglas estáticas línea por línea; revisar permisos de archivos del volumen de keystores y del secret de desbloqueo.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** el worker puede obtener firmas S sólo para operaciones válidas; las reglas estáticas rechazan por sí mismas cualquier operación fuera de la allowlist aunque el backend la pida.

**Security checks:**

- [x] **P11.SEC** — S nunca en DB, Valkey, `.env`, logs, código ni API; keystores 0400 del UID del signer; credencial de desbloqueo en un secret separado de los keystores; mTLS obligatorio; signer sin puertos publicados y sólo en la red interna `signer`.
      Verificación: `pnpm --dir backend/signer test:security && bash ci/scripts/ci-security.sh`.

**Commits:** `feat(signer): add self-hosted signer service with encrypted keystores`, `feat(signer): add signed policy snapshots and gas tank`.

#### CHECKPOINT P11

- [x] build pasa: `pnpm --dir backend/signer build && pnpm --dir backend/app build`.
- [x] tests pasan: `pnpm --dir backend/signer test && pnpm --dir backend/app test`.
- [x] security tests pasan: `pnpm --dir backend/signer test:security && bash ci/scripts/ci-security.sh`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs` (runbooks del signer).
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P12:** suite de rechazo del signer completa y verde.

---

### P12 — Backend IV: creación de wallet

**Objetivo:** onboarding server-side completo (V9 §6 y §16): registro de U, enrollment de R, incorporación firmada por U, asignación de S, cálculo de dirección, deploy atómico, verificación y estados CREATING → DEPLOYING → VERIFYING → ACTIVE.

**Archivos/componentes:** `src/wallets/*`, `src/recovery/enrollment.ts`, rutas `wallet` y `recovery`.

**Dependencias:** P11.

**Implementación requerida:**

- [x] **P12.T01** — Con PlatformSession `ONBOARDING` (step-up, [B-PSES-03]): `POST /wallets` crea `wallets` (CREATING, `walletId`); `POST /wallets/{id}/user-key` registra dirección U, metadata pública KDF, flags de backup (debe existir ≥ 1 método persistente confirmado) y registro OPAQUE PENDING (pasa a ACTIVE en P12.T07).
      Verificación: `pnpm --dir backend/app vitest run test/wallets/create-user-key.test.ts`.
- [x] **P12.T01.b** — `KEY_RESTORE` [B-PSES-03] (movido desde P10, §13): step-up con prueba de posesión (firma EIP-712 `KeyRestore {userId, walletId, keyAddress, nonce}` de la U restaurada, que debe ser el rol U vigente on-chain leído por quórum) → PlatformSession `KEY_RESTORE`; `POST /wallets/{id}/user-key/restore` reemplaza sólo el registro OPAQUE de esa misma U (también tras rotar `OPAQUE_SERVER_SETUP`).
      Verificación: `pnpm --dir backend/app vitest run test/wallets/key-restore.test.ts` (Safe desplegada en el fork).
- [x] **P12.T02** — Enrollment de R: `POST /wallets/{id}/recovery/enrollments` (Wallet; nonce 128 bits, TTL 15 min) → `POST /recovery/enrollments/{id}/enrollment-key` (Recovery, PlatformSession ENROLLMENT; registra JWK P-256) → `POST /recovery/enrollments/{id}/submit` con `RecoveryEnrollment {userId, platformId, R, nonce, issuedAt, expiresAt}` firmado por la Enrollment Key + proof-of-control EIP-712 de R. Validaciones: firma, nonce, expiración, R ≠ U, R no usada por otra wallet, R es EOA (código vacío o designador EIP-7702), cadena correcta.
      Verificación: `pnpm --dir backend/app vitest run test/recovery/enrollment.test.ts`.
- [x] **P12.T03** — Asignación de S tras el enrollment de R: el backend pide `POST /v1/keys` al shard asignado; guarda `signer_keys` y la `SignerKeyAttestation` [B-SIG-07].
      Verificación: `pnpm --dir backend/app vitest run test/wallets/assign-executor.test.ts`.
- [x] **P12.T04** — Dirección esperada: `saltNonce = uint256(keccak256(abi.encode("MTW_SALT_V1", platformId, walletId)))`; cálculo local (TS) y `WalletFactory.predictWalletAddress` (eth_call) deben coincidir; se persiste `config_hash` (hash del initializer).
      Verificación: `pnpm --dir backend/app vitest run test/wallets/predict-address.test.ts` (TS vs `predictWalletAddress` en el fork).
- [x] **P12.T05** — `POST /recovery/enrollments/{id}/incorporate` (Wallet): firma EIP-712 de U `WalletCreationAuthorization {userId, platformId, walletId, U, R, S, saltNonce, expectedSafe, enrollmentNonce}` [W-01] después de que la Wallet verificó la atestación de S y recalculó la dirección; el backend acepta sólo si R coincide exactamente con el del enrollment y S/salt/dirección con los asignados.
      Verificación: `pnpm --dir backend/app vitest run test/recovery/creation-authorization.test.ts`.
- [x] **P12.T06** — `POST /wallets/{id}/deploy` (crítico): gas tank fondea S (monto inicial de policy) y envía `WalletFactory.createWallet(U, R, S, saltNonce)` → DEPLOYING; receipt → VERIFYING.
      Verificación: `pnpm --dir backend/app vitest run test/wallets/deploy.test.ts` contra el fork.
- [x] **P12.T07** — Verificación post-deploy por lectura directa on-chain (quórum) de **todos** los ítems de V9 §16 [C-FAC-05]; sólo si todo coincide → ACTIVE; si no → FAILED + alerta (la Safe nunca se presenta como operativa). OPAQUE PENDING → ACTIVE al quedar ACTIVE la wallet.
      Verificación: `pnpm --dir backend/app vitest run test/wallets/verify-active.test.ts` (incluye Safe con config alterada → nunca ACTIVE).
- [x] **P12.T08** — `GET /wallets/{id}/deployment` devuelve los datos que el frontend necesita para su verificación independiente (U, R, S, salt, factory, singleton, direcciones del sistema, expected address).
      Verificación: `pnpm --dir backend/app vitest run test/api/deployment-info.test.ts`.

**Tests a implementar:**

- [x] **P12.TST** — integración sobre el fork con signer dev: onboarding completo hasta ACTIVE; enrollment con R distinto en firma de U → rechazo; R reutilizada → rechazo; enrollment expirado; Safe pre-desplegada por un tercero con mismo initializer → idempotente (registro); verificación falla si se altera cualquier ítem (usando una Safe creada fuera de la factory con otra config) → nunca ACTIVE.
      Verificación: `pnpm --dir backend/app test`.

**Checks manuales:**

- [x] **P12.MAN** — inspeccionar en el fork la Safe creada (`cast call` de owners/threshold/guard).
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** A11 cubierto server-side; onboarding reproducible.

**Security checks:**

- [x] **P12.SEC** — el backend no aporta calldata arbitraria a la factory; sólo (U, R, S, salt).
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(wallet): add deterministic safe deployment`, `feat(recovery): add recovery key enrollment`.

#### CHECKPOINT P12

- [x] build pasa: `pnpm --dir backend/app build`.
- [x] tests pasan: `pnpm --dir backend/app test`.
- [x] security tests pasan: `pnpm --dir backend/app test:security`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P13:** wallet ACTIVE end-to-end en el fork por API.

---

### P13 — Backend V: pipeline de operaciones

**Objetivo:** [B-SM], [B-NONCE], [B-Q], [B-FIN] completos, más indexer de transfers y reconciliación.

**Archivos/componentes:** `src/operations/{state-machine.ts,service.ts,nonce-manager.ts}`, `src/worker/{main.ts,pipeline.ts,lease.ts}`, `src/chain/{watcher.ts,reconciler.ts,indexer.ts}`, rutas `operations`.

**Dependencias:** P12.

**Implementación requerida:**

- [x] **P13.T01** — Máquina de estados y `transitionOperation` [B-SM-01..03] con tabla de transiciones permitidas testeada exhaustivamente.
      Verificación: `pnpm --dir backend/app vitest run test/operations/state-machine.test.ts` (todas las transiciones permitidas y prohibidas).
- [x] **P13.T02** — Nonce manager [B-NONCE-01..03] con lock de fila y lease con fencing [B-NONCE-04].
      Verificación: `pnpm --dir backend/app vitest run test/integration/nonce-race.test.ts test/integration/two-workers.test.ts`.
- [x] **P13.T03** — `POST /operations/{id}/signatures` (crítico): verifica firma (ECDSA estricta) contra rol on-chain, envelope de envío, recalcula SafeTxHash, policy, 2FA si corresponde → USER_SIGNED → outbox.
      Verificación: `pnpm --dir backend/app vitest run test/operations/submit-signature.test.ts`.
- [x] **P13.T04** — Worker con el pipeline de 12 pasos [B-Q-02], reintentos [B-Q-03], recuperación tras crash [B-Q-04], concurrencia entre Safes.
      Verificación: `pnpm --dir backend/app vitest run test/worker/pipeline.test.ts` contra el fork y el signer dev.
- [x] **P13.T05** — Gestión de tx de S: fees EIP-1559 con topes de policy, reemplazo por fee bump, `chain_transactions` [B-NONCE-05].
      Verificación: `pnpm --dir backend/app vitest run test/worker/fees-replacement.test.ts`.
- [x] **P13.T06** — Watcher de finalidad y reorgs [B-FIN-01/02] (parámetros de ADR-018; en local `depth`).
      Verificación: `pnpm --dir backend/app vitest run test/resilience/reorg.test.ts`.
- [x] **P13.T07** — Reconciliador [B-FIN-03] + indexado de transacciones soberanas (eventos SafeL2) + indexer de `Transfer` de USDC/USDT hacia/desde Safes (`token_transfers`, con confirmaciones y reorg).
      Verificación: `pnpm --dir backend/app vitest run test/chain/reconciler-indexer.test.ts`.
- [x] **P13.T08** — Cancelación por NoOp con estado `CANCEL_REQUESTED` y reemplazo de la tx en vuelo [B-NONCE-06].
      Verificación: `pnpm --dir backend/app vitest run test/integration/cancel-session-destination.test.ts`.
- [x] **P13.T09** — Decisión de batching documentada (ADR-019) + test que demuestra que el worker procesa Safes distintas en paralelo y una Safe en orden.
      Verificación: `pnpm --dir backend/app vitest run test/worker/parallelism.test.ts`.
- [x] **P13.T10** — Policy del backend [B-POL-05] en `backend/app/src/policy/`: verificación del snapshot firmado y anti-rollback, tabla de operaciones por rol, límites por operación, ledger 24 h por Safe, umbral de 2FA y validación de destinos; usada por `prepare` y por el paso 6 del worker. Implementación independiente de la del signer, contrastada con los mismos vectores.
      Verificación: `pnpm --dir backend/app vitest run test/policy`.
- [x] **P13.T11** — Chequeo de configuración de la Safe antes de co-firmar (paso 7b de [B-Q-02]) en backend y signer, y estado `SOVEREIGN_MODIFIED` con alerta y aviso al usuario.
      Verificación: `pnpm --dir backend/app vitest run test/integration/config-drift.test.ts` (P13.TST.k).

**Tests a implementar:**

- [x] **P13.TST** — (prompt §29)
      Verificación: `pnpm --dir backend/app test` (incluye `test/resilience`).

- [x] **P13.TST.a** — requests duplicados e idempotencia (`Idempotency-Key` repetido, mismo body / distinto body).
      Verificación: `pnpm --dir backend/app vitest run test/integration/idempotency.test.ts`.
- [x] **P13.TST.b** — carrera de nonces: N `prepare` concurrentes → nonces únicos y consecutivos; liberación por expiración.
      Verificación: `pnpm --dir backend/app vitest run test/integration/nonce-race.test.ts`.
- [x] **P13.TST.c** — dos workers sobre la misma operación: sólo el dueño del lease transmite (fencing).
      Verificación: `pnpm --dir backend/app vitest run test/integration/two-workers.test.ts`.
- [x] **P13.TST.d** — timeout de RPC y desacuerdo de RPC (sin transición hasta consistencia) con el proxy de fallas.
      Verificación: `pnpm --dir backend/app vitest run test/resilience/rpc-faults.test.ts`.
- [x] **P13.TST.e** — transacción fallida (dropped), revertida por el Guard (receipt status 0, [B-SM-04]) y simulación que revierte (nunca se transmite).
      Verificación: `pnpm --dir backend/app vitest run test/integration/failed-reverted.test.ts`.
- [x] **P13.TST.f** — reorg con `anvil_reorg`: MINED → REORGED → re-ejecución de la misma SafeTx; CONFIRMED → FINALIZED.
      Verificación: `pnpm --dir backend/app vitest run test/resilience/reorg.test.ts`.
- [x] **P13.TST.g** — retry de cola, crash del proceso en cada paso del pipeline (kill -9 y reinicio) y reinicio del backend.
      Verificación: `pnpm --dir backend/app vitest run test/resilience/crash-restart.test.ts`.
- [x] **P13.TST.h** — flush de Valkey: el outbox re-encola sin pérdida ni duplicados.
      Verificación: `pnpm --dir backend/app vitest run test/resilience/valkey-flush.test.ts`.
- [x] **P13.TST.i** — cancelación NoOp ganando y perdiendo la carrera (original en QUEUED y en SUBMITTED); sesión expirada al enviar firma; ejecución legítima > 15 min después de firmar (OK) y > 24 h (SIGNATURE_STALE); destino no autorizado en el paso 7.
      Verificación: `pnpm --dir backend/app vitest run test/integration/cancel-session-destination.test.ts`.
- [x] **P13.TST.j** — policy del backend (P13.T10) contra los vectores compartidos: mismo veredicto que el signer en cada caso.
      Verificación: `pnpm --dir backend/app vitest run test/policy/vectors.test.ts`.
- [x] **P13.TST.k** — U+R retiran el Guard (o cambian module guard/fallback) soberanamente en el fork → backend y signer se niegan a co-firmar y la wallet queda `SOVEREIGN_MODIFIED`.
      Verificación: `pnpm --dir backend/app vitest run test/integration/config-drift.test.ts`.

**Checks manuales:**

- [x] **P13.MAN** — observar en métricas la evolución de estados de una operación en el fork.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** ninguna doble ejecución ni nonce duplicado bajo concurrencia; reorgs y crashes recuperados sin intervención.

**Security checks:**

- [x] **P13.SEC** — S sólo firma vía signer tras checks; ninguna transición sin auditoría.
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(backend): add operation pipeline with nonce management and finality tracking`.

#### CHECKPOINT P13

- [x] build pasa: `pnpm --dir backend/app build`.
- [x] tests pasan: `pnpm --dir backend/app test` (incluye `test/resilience`).
- [x] security tests pasan: `pnpm --dir backend/app test:security`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs` (diagrama de estados).
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P14:** suite de concurrencia/resiliencia verde 3 corridas consecutivas.

---

### P14 — Backend VI: whitelist, send y swap

**Objetivo:** operaciones de usuario V1 con validación doble (backend + signer) y enforcement on-chain.

**Archivos/componentes:** `src/whitelist/*`, `src/send/*`, `src/swap/{quote.ts,prepare.ts}`, rutas correspondientes.

**Dependencias:** P13.

**Implementación requerida:**

- [x] **P14.T01** — Whitelist (prompt §10): request → challenge ligado a `{userId, safe, chainId, destination, action, nonce, expiresAt}` (single-use, expirable, auditable, idempotente) → email [B-MAIL-02] → confirmación con código → atestación `ChallengeCompletion` firmada por el emisor de sesiones (la verifica el signer) → SafeTx `addDestination(dest)` firmada por U → ejecución → `ACTIVATING` → `ACTIVE` cuando `isWhitelisted` es true on-chain (24 h). Baja: `removeDestination` (U o R) inmediata.
      Verificación: `pnpm --dir backend/app vitest run test/integration/whitelist-challenge.test.ts`.
- [x] **P14.T02** — Validaciones de destino: EIP-55, ≠ Safe, ≠ contratos del sistema, ≠ dirección cero, ≠ tokens; no duplicado.
      Verificación: `pnpm --dir backend/app vitest run test/whitelist/destination-validation.test.ts`.
- [x] **P14.T03** — Send: `prepare` reconstruye SafeTx `token.transfer(dest, amount)`; valida policy, whitelist ACTIVE (quórum on-chain), saldo (quórum), nonce; 2FA si `amount ≥ umbral` (challenge ligado a SafeTxHash, token, monto, destino, nonce).
      Verificación: `pnpm --dir backend/app vitest run test/integration/send.test.ts`.
- [x] **P14.T04** — Swap quote: QuoterV2 (`eth_call`) sobre el pool canónico fijado; devuelve `expectedOut`, `minOut` según slippage (≤ 50 bps), impacto de precio, `deadline` (now + 10 min).
      Verificación: `pnpm --dir backend/app vitest run test/swap/quote.test.ts` contra el fork.
- [x] **P14.T05** — Swap prepare: grupo de 2 operaciones (`SWAP_APPROVE` nonce N con `approve(SwapExecutor, amountIn)` exacto; `SWAP` nonce N+1), enviadas juntas al signer para el chequeo de secuencia [B-SIG-02]; si la ejecución del swap falla en forma final, el backend ofrece re-cotizar (nueva SafeTx N+1) o `APPROVE_REVOKE`. Job de limpieza: allowances residuales detectadas → notificación al usuario.
      Verificación: `pnpm --dir backend/app vitest run test/integration/swap.test.ts`.
- [x] **P14.T06** — Endpoints de lectura: whitelist, operaciones del grupo, balances.
      Verificación: `pnpm --dir backend/app vitest run test/api/read-endpoints.test.ts` (incluye IDOR de [B-AUTHZ]).

**Tests a implementar:**

- [x] **P14.TST.a** — destino no whitelisteado en **tres capas**: API manipulada → rechazo del backend; SafeTx enviada directo al signer → rechazo del signer; ejecución directa con firmas válidas U+S en el fork → revert del Guard (A9).
      Verificación: `pnpm --dir backend/app vitest run test/security/whitelist-three-layers.test.ts`.
- [x] **P14.TST.b** — challenge expirado, reusado o con otra dirección; whitelist en ACTIVATING no usable; idempotencia del request.
      Verificación: `pnpm --dir backend/app vitest run test/integration/whitelist-challenge.test.ts`.
- [x] **P14.TST.c** — send real de USDC y USDT a destino activo con saldos verificados; 2FA exigido sobre el umbral.
      Verificación: `pnpm --dir backend/app vitest run test/integration/send.test.ts`.
- [x] **P14.TST.d** — swap USDC→USDT y USDT→USDC reales contra el pool del fork, allowance final 0, minOut bajo el piso → revert, token arbitrario → rechazo/revert, fallo final del swap → re-cotización o revocación.
      Verificación: `pnpm --dir backend/app vitest run test/integration/swap.test.ts`.

**Checks manuales:**

- [x] **P14.MAN** — email de whitelist en Mailpit muestra acción, dirección, red y expiración.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** send y swap funcionan con tokens y pool reales del fork; toda vía de bypass termina en rechazo o revert.

**Security checks:**

- [x] **P14.SEC** — A4, A9, A10, A15, A16, A18 cubiertos por tests en tres capas.
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(policy): add destination whitelist enforcement`, `feat(wallet): add whitelisted sends`, `feat(swap): add restricted usdc usdt swaps`.

#### CHECKPOINT P14

- [x] build pasa: `pnpm --dir backend/app build`.
- [x] tests pasan: `pnpm --dir backend/app test`.
- [x] security tests pasan: `pnpm --dir backend/app test:security`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P15:** bypass tests en tres capas verdes.

---

### P15 — Backend VII: rotaciones, recovery, migración excepcional, notificaciones

**Objetivo:** V9 §14 completo.

**Archivos/componentes:** `src/rotations/*`, `src/recovery/{u-replacement.ts,migration.ts}`, `src/notifications/*`, CLI de operadores `src/operators/cli.ts`.

**Dependencias:** P14.

**Implementación requerida:**

- [x] **P15.T01** — Propuesta asistida: `POST /wallets/{id}/rotations` para rol U (X = R; requiere U' registrado con OPAQUE PENDING), R (X = U; requiere R' enrollado) o S (X = U o R; S' asignado por shard) → SafeTx `RotationTimelock.propose(role, old, new)` → ejecución → `PENDING_TIMELOCK` con `executable_at` leído on-chain; email + notificación in-app.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-propose.test.ts`.
- [x] **P15.T02** — Cancelación individual: `POST /rotations/{id}/cancel` **sin autenticación** recibe la firma EIP-712 `CancelRotation` de U **o** R, verifica firma y propuesta pendiente on-chain y la retransmite vía gas tank (`cancelWithSignature`), con rate limit propio por propuesta [B-RL]; además la firma exportada se puede transmitir por cualquier relayer o por Recovery con wallet externa (procedimiento documentado). Estado CANCELLED al confirmarse.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-cancel.test.ts`.
- [x] **P15.T03** — Ejecución: al madurar, `POST /rotations/{id}/execute/prepare` prepara `swapOwner(prev, old, new)` (prev calculado on-chain); firma de U o R; ejecución por S vigente; roles actualizados on-chain (`RoleRotated`); efectos: U' → OPAQUE ACTIVE y retiro del registro viejo; R' → recovery_metadata; S' → signer_keys ACTIVE, S anterior RETIRED.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-execute.test.ts`.
- [x] **P15.T04** — Flujo "perdí U / Password U" (V9 §14) orquestado: step-up → U_REPLACEMENT → registro U' → propuesta firmada por R desde Recovery → 48 h → ejecución firmada por R.
      Verificación: `pnpm --dir backend/app vitest run test/integration/recovery-flows.test.ts` (caso U perdida).
- [x] **P15.T05** — Flujo "perdí R": step-up/OPERATIONS → enrollment R' → U propone → 48 h → U ejecuta.
      Verificación: `pnpm --dir backend/app vitest run test/integration/recovery-flows.test.ts` (caso R perdida).
- [x] **P15.T06** — Migración excepcional (credencial comprometida que veta): caso de operador con doble aprobación (`operator_actions`, dos operadores distintos con TOTP), wallet vieja → `MIGRATING`, creación de la Safe nueva con `migrated_from_wallet_id` (por la factory, con la credencial sana como owner), propuesta on-chain de autorización de migración en `PolicyRegistry` por la Governance Safe (24 h, guardianes pueden cancelar), `MIGRATION_TRANSFER` (saldo completo, exento del límite de 24 h) firmado por la credencial sana + S, wallet vieja → `MIGRATED`. Runbook `docs/runbooks/exceptional-migration.md`.
      Verificación: `pnpm --dir backend/app vitest run test/integration/migration.test.ts`.
- [x] **P15.T07** — Notificaciones (email + in-app) para todos los eventos de [B-MAIL-03]; el watcher detecta propuestas de rotación on-chain **no originadas por el backend** y notifica igual.
      Verificación: `pnpm --dir backend/app vitest run test/notifications` (incluye propuesta on-chain no originada por el backend).
- [x] **P15.T08** — Upgrade del Guard [C-GRD-17]: operación `GUARD_UPGRADE` (propuesta en el timelock, notificación, 48 h, ejecución con firma U + S), habilitada sólo si hay sucesor activo en `PolicyRegistry`.
      Verificación: `pnpm --dir backend/app vitest run test/integration/guard-upgrade.test.ts` (con un Guard sucesor de prueba desplegado en el fork).
- [x] **P15.T09** — Pérdida de una clave S: runbook `docs/runbooks/executor-key-loss.md` (U+R reemplazan S soberanamente desde Recovery `/sovereign` + `updateRoles` + alta de la nueva S en el signer) y test en el fork del procedimiento completo.
      Verificación: `pnpm --dir backend/app vitest run test/integration/executor-key-loss.test.ts`.

**Tests a implementar:**

- [x] **P15.TST.a** — propuesta → cancelación por U (firma) → ejecución imposible; propuesta → cancelación por R; cancelación transmitida por un relayer ajeno al backend.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-cancel.test.ts`.
- [x] **P15.TST.b** — ejecución antes de 48 h → revert; con old ≠ rol actual → revert; R+S proponiendo rol R → revert.
      Verificación: `pnpm --dir backend/app vitest run test/security/rotation-bypass.test.ts`.
- [x] **P15.TST.c** — recovery completo de U en el fork (warp 48 h) y flujo de R perdida.
      Verificación: `pnpm --dir backend/app vitest run test/integration/recovery-flows.test.ts`.
- [x] **P15.TST.d** — rotación de S y continuidad de operaciones con S'.
      Verificación: `pnpm --dir backend/app vitest run test/integration/rotation-s.test.ts`.
- [x] **P15.TST.e** — migración excepcional: sin autorización → revert; con autorización madura → OK sólo hacia la Safe autorizada; doble aprobación de operadores obligatoria.
      Verificación: `pnpm --dir backend/app vitest run test/integration/migration.test.ts`.

**Checks manuales:**

- [x] **P15.MAN** — emails de rotación propuesta/cancelada/ejecutada.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** V9 §14 y A5/A17 cubiertos; ninguna rotación asistida sin 48 h.

**Security checks:**

- [x] **P15.SEC** — cancelación posible sin backend (firma + cualquier relayer).
      Verificación: `pnpm --dir backend/app test:security`.

**Commits:** `feat(recovery): add key rotation, recovery and cancellation flows`.

#### CHECKPOINT P15

- [x] build pasa: `pnpm --dir backend/app build`.
- [x] tests pasan: `pnpm --dir backend/app test`.
- [x] security tests pasan: `pnpm --dir backend/app test:security`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs` (runbooks de recovery y migración).
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P16–P19:** API completa y estable (OpenAPI congelada para v1; cambios posteriores con versionado).

---

### P16 — Frontends: base común por elección

**Objetivo:** crear `frontend/wallet` y `frontend/recovery` como proyectos independientes con el hardening de [F-SEC] desde el primer commit, builds reproducibles y design tokens compartidos sólo como CSS.

**Archivos/componentes:** `frontend/design-tokens/{tokens.css,fonts/*,LICENSES}`, por app: `package.json` + `pnpm-lock.yaml`, `vite.config.ts`, `index.html`, `src/security/{trusted-types.ts,sw-killswitch.ts,csp-report.ts}`, `build/{sri-plugin.ts,manifest.ts,sign-manifest.ts,headers.json}`, `eslint.config.js`, `scripts/sync-design-tokens.mjs`; backend: `POST /api/v1/security/csp-report`.

**Dependencias:** P08 (puede avanzar en paralelo a P09–P15).

**Implementación requerida:**

- [x] **P16.T01** — `design-tokens/tokens.css` (variables CSS: colores, tipografía, espaciado; look & feel coherente con la landing existente sin copiar código) y fuentes self-hosted con licencia. Cada app lo copia en build con `scripts/sync-design-tokens.mjs` verificando SHA-256 (sin dependencia npm compartida).
      Verificación: `node frontend/wallet/scripts/sync-design-tokens.mjs --check` y `node frontend/recovery/scripts/sync-design-tokens.mjs --check`.
- [x] **P16.T02** — Scaffold de cada app con versiones exactas (§3.6) y settings de supply chain (P01.T05), con `@playwright/test` como dependencia de desarrollo propia para `test:browser` (tests de navegador de esa app contra el stack local; el proyecto `e2e/` de P22 cubre luego los flujos completos entre apps). Wallet: sin wagmi/conectores (test de dependencias). Recovery: wagmi/conectores declarados pero importados sólo vía `import()` en `src/external-wallet/`.
      Verificación: `pnpm --dir frontend/wallet install --frozen-lockfile && pnpm --dir frontend/wallet build`; ídem `frontend/recovery`; test de dependencias (Wallet sin wagmi).
- [x] **P16.T03** — ESLint: prohibidos `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`, `eval`/`new Function`, `localStorage`/`sessionStorage` fuera de módulos allowlisteados (sólo flags no sensibles y `state` OAuth), imports fuera del directorio de la app (salvo el CSS de tokens).
      Verificación: `pnpm --dir frontend/wallet lint` y `pnpm --dir frontend/recovery lint` (con un caso prohibido que debe fallar en `lint-fixtures/`).
- [x] **P16.T04** — Seguridad en runtime: política Trusted Types única `mtw-default` con allowlist de URLs de workers generada en build y comprobación al arrancar de que la CSP está activa ([F-SEC-02]), kill-switch de service workers ([F-SEC-04]), listener de `securitypolicyviolation` → `POST /api/v1/security/csp-report` (endpoint agregado en backend en esta tarea; rate limited, sin datos sensibles).
      Verificación: `pnpm --dir frontend/wallet test:browser -- security/trusted-types` y lo mismo en `frontend/recovery` (worker carga con TT forzado; sink de prueba bloqueado; sin SW).
- [x] **P16.T05** — Headers: `build/headers.json` por app (CSP de [F-SEC-01] con hosts por entorno, HSTS, COOP/COEP/CORP, Referrer-Policy, Permissions-Policy, nosniff) aplicado por `vite preview` en local y por el contenedor estático propio de cada app (`wallet-web`/`recovery-web`) en P26; `build.modulePreload.polyfill = false` y cero scripts/estilos inline (CSP `'self'`).
      Verificación: `pnpm --dir frontend/wallet test:browser -- security/headers` y lo mismo en `frontend/recovery` (contra `vite preview`).
- [x] **P16.T06** — Build reproducible: `SOURCE_DATE_EPOCH` = fecha del commit, nombres por hash de contenido, toolchain fijado; plugin SRI propio; generador de `release-manifest.json` (releaseId, commit, SHA-256 por archivo) y firma Ed25519 con la clave de release **de esa app** (dev local en `.secrets/`; CI por Environment en P20/P26). Implementado por separado en cada app.
      Verificación: `bash ci/scripts/repro-build.sh wallet` y `bash ci/scripts/repro-build.sh recovery` → manifests idénticos y firma verificable.
- [x] **P16.T07** — SBOM CycloneDX por build (syft vía imagen Docker fijada).
      Verificación: SBOM generado por build en `dist/sbom.cdx.json` de cada app (`bash ci/scripts/sbom.sh`).
- [x] **P16.T08** — Test de grafo de bundle en Recovery: los chunks de entrada y de los flujos de R interna no contienen módulos de wagmi/conectores/WalletConnect/Coinbase/MetaMask.
      Verificación: `pnpm --dir frontend/recovery vitest run test/bundle-graph.test.ts`.
- [x] **P16.T09** — Contratos del sistema por entorno [F-SEC-08]: script de build que genera `system-contracts.<env>.json` desde `contracts/deployments/<env>.json` (local: `deployments/local.json`), lo embebe y lo incluye en el manifest; incluye la clave pública de atestación del signer.
      Verificación: build local contiene el archivo y su hash figura en `release-manifest.json`; test que rechaza una dirección distinta informada por el backend.
- [x] **P16.T10** — Regla de dependencias comunes [F-SEC-09]: check de CI que compara los lockfiles de Wallet y Recovery y bloquea publicar en ambas apps, dentro de 72 h, un mismo bump de `@noble/*`, `viem` o `@scure/*`; requiere aprobación de revisores de cada dominio.
      Verificación: `bash ci/scripts/check-shared-deps.sh` con un caso que falla y otro que pasa.

**Tests a implementar:**

- [x] **P16.TST** — build sin scripts inline; SRI presente en todo `<script>`/`<link>`; manifest verificable con la clave pública; dos builds consecutivos → manifests idénticos; headers presentes en `vite preview` (Playwright); TT bloquea un sink de prueba; SW inexistente.
      Verificación: `pnpm --dir frontend/wallet test && pnpm --dir frontend/recovery test`.

**Checks manuales:**

- [x] **P16.MAN** — auditar con DevTools que no hay requests a terceros al cargar cada app.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** ambas apps arrancan y se construyen de forma reproducible con CSP/TT activos y sin violaciones.

**Security checks:**

- [x] **P16.SEC** — `pnpm audit --prod`, OSV-Scanner sobre cada lockfile, Semgrep reglas frontend.
      Verificación: `pnpm --dir frontend/wallet test:browser -- security && pnpm --dir frontend/recovery test:browser -- security && bash ci/scripts/ci-security.sh`.

**Commits:** `feat(wallet): scaffold hardened wallet frontend`, `feat(recovery): add independent recovery frontend`.

#### CHECKPOINT P16

- [x] build pasa: `pnpm --dir frontend/wallet build && pnpm --dir frontend/recovery build` (reproducibles).
- [x] tests pasan: `pnpm --dir frontend/wallet test && pnpm --dir frontend/recovery test`.
- [x] security tests pasan: `pnpm --dir frontend/wallet test:browser -- security && pnpm --dir frontend/recovery test:browser -- security && bash ci/scripts/ci-security.sh`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P17/P19:** CSP/TT sin violaciones y builds reproducibles.

---

### P17 — Frontend Wallet I: cuenta, gestión de U, backups y desbloqueo

**Objetivo:** [F-KEY], [F-DRV], [F-SES] en la app Wallet.

**Archivos/componentes:** `frontend/wallet/src/{api/*,crypto/*,workers/argon2.worker.ts,drive/*,auth/*,onboarding/*,unlock/*,security/*}`, `src/config/chain.base.json` (copia propia de direcciones fijadas + test de igualdad con `config/chains/base-mainnet.json`), `src/vendor/mtw-wordlist-v1.txt` (+ hash).

**Dependencias:** P10, P16.

**Implementación requerida:**

- [x] **P17.T01** — Cliente API: `credentials: 'include'`, CSRF, `Idempotency-Key`, errores RFC 9457, firma de requests críticos con la session key y envelope de envío ([F-SES-03]).
      Verificación: `pnpm --dir frontend/wallet vitest run src/api`.
- [x] **P17.T02** — **Spike OAuth Google (ADR-012)**: con los clientes OAuth locales reales, probar authorization code + PKCE sin client secret canjeado desde el navegador (el endpoint de token real se sondea con un código de prueba: distingue "falta client_secret" de "código inválido" sin necesitar un login interactivo). Registrar resultado (request/response sin secretos) en `docs/adr/ADR-012-*.md` y fijar el flujo. Implementar `drive/` ([F-DRV-01..05]) con verificación post-subida y chequeo de salud del backup.
      Verificación: ADR-012 actualizado con el resultado del spike y `pnpm --dir frontend/wallet vitest run src/drive`; check manual del round-trip OAuth registrado en §13.
- [x] **P17.T03** — Pantallas de cuenta: registro, verificación de email, login (+TOTP), logout, forgot/reset, sesiones (listar/revocar), TOTP setup. Texto explícito: password de cuenta ≠ Password U; reset de cuenta no recupera U.
      Verificación: `pnpm --dir frontend/wallet vitest run src/auth` + `pnpm --dir frontend/wallet test:browser -- auth`.
- [x] **P17.T04** — Módulo `crypto/`: generación de U [F-KEY-01], Password U [F-KEY-02], Argon2id en worker + HKDF [F-KEY-03], sobre `U.enc` con AAD [F-KEY-04], vida en memoria y zeroización [F-KEY-05], backup de 17 palabras con checksum [F-KEY-06.4], firma EIP-712 con `@noble/curves` (low-s).
      Verificación: `pnpm --dir frontend/wallet vitest run src/crypto` (vectores RFC 9106, RFC 5869, AES-GCM con AAD, 17 palabras).
- [x] **P17.T05** — Onboarding de U en este orden: conectar Drive (OAuth, [F-DRV-01]) → generar U → mostrar Password U → confirmar 2 palabras → subir a Drive y verificar → **backup independiente de la plataforma obligatorio** (archivo, QR o 17 palabras, [F-KEY-06]) → registro OPAQUE y alta de U en backend.
      Verificación: `pnpm --dir frontend/wallet vitest run src/onboarding` + `pnpm --dir frontend/wallet test:browser -- onboarding`.
- [x] **P17.T06** — Desbloqueo: Password U → Argon2id → OPAQUE → PlatformSession; `K_U` como CryptoKey no exportable; bloqueo por inactividad/expiración; chequeo periódico no bloqueante del backup en Drive [F-DRV-05]. Para probar el desbloqueo con scope `OPERATIONS` (que exige wallet ACTIVE) los tests completan el onboarding por API (P12) antes de usar la UI.
      Verificación: `pnpm --dir frontend/wallet vitest run src/unlock`.
- [x] **P17.T07** — Cambio de Password U [F-KEY-08] y flujo "perdí mi Password U" (step-up → U' → handoff a Recovery con QR/link).
      Verificación: `pnpm --dir frontend/wallet vitest run src/security/password-u`.
- [x] **P17.T08** — Medición de rendimiento de Argon2id en el perfil móvil de referencia (Playwright con emulación de dispositivo móvil y throttling de CPU 4×, en Chromium y WebKit): registrar p95 en ADR-013; aplicar la regla de fallback si supera 3 s.
      Verificación: p95 registrado en ADR-013 (`pnpm --dir frontend/wallet test:browser -- perf/argon2` con throttling de CPU).
- [x] **P17.T09** — Restauración de U en un dispositivo nuevo [F-KEY-10]: desde Drive, archivo, QR y 17 palabras; verificación contra el rol U on-chain; flujo `KEY_RESTORE` (prueba de posesión + reemplazo del registro OPAQUE) para la restauración por palabras.
      Verificación: `pnpm --dir frontend/wallet vitest run src/restore` + `pnpm --dir frontend/wallet test:browser -- restore`.

**Tests a implementar:**

- [x] **P17.TST** — vectores (RFC 9106 Argon2id, RFC 5869 HKDF, AES-GCM con AAD), alteración de AAD/ciphertext → falla, password errónea → falla sin oráculo, checksum de 17 palabras detecta errores de tipeo, wordlist con hash correcto, zeroización best-effort, integración con backend real (OPAQUE), Drive contra la API real con la cuenta de prueba (`GOOGLE_DRIVE_TEST_*`, obligatorio en cada `pnpm ci:local` y en CI).
      Verificación: `pnpm --dir frontend/wallet test && pnpm --dir frontend/wallet test:browser`.

**Checks manuales:**

- [ ] **P17.MAN** — onboarding completo en Chromium y Firefox; revisar textos de advertencia.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** U nunca sale del navegador ni se persiste en claro (verificado en P22); desbloqueo y backups funcionando contra servicios reales.

**Security checks:**

- [x] **P17.SEC** — búsqueda automática de la clave U/Password U en todos los requests y storages tras los flujos (test de canario).
      Verificación: `pnpm --dir frontend/wallet test:browser -- security`.

**Commits:** `feat(wallet): add user key management and encrypted backups`, `feat(wallet): add account and unlock flows`.

#### CHECKPOINT P17

- [x] build pasa: `pnpm --dir frontend/wallet build`.
- [x] tests pasan: `pnpm --dir frontend/wallet test && pnpm --dir frontend/wallet test:browser`.
- [x] security tests pasan: `pnpm --dir frontend/wallet test:browser -- security`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs` (ADR-012, ADR-013).
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P18:** flujo de cuenta + U + desbloqueo verde contra backend local.

---

### P18 — Frontend Wallet II: onboarding Safe y operación

**Objetivo:** completar la app Wallet (prompt §7, §10–§12, V9 §6/§16).

**Archivos/componentes:** `frontend/wallet/src/{recovery-activation/*,safe/{predict.ts,verify.ts},home/*,assets/*,whitelist/*,send/*,swap/*,activity/*,security/rotations/*,sovereign/*,chain/{client.ts,safe-tx.ts,decoders.ts,abis/*}}`.

**Dependencias:** P15, P17.

**Implementación requerida:**

- [x] **P18.T01** — Activar Recovery: crear enrollment, QR/link [F-LNK-01], esperar envío, confirmar R por fragmento de regreso o comparación manual completa [F-LNK-02], verificar la `SignerKeyAttestation` de S con la clave fijada [F-SEC-08], recalcular la dirección esperada y que U firme `WalletCreationAuthorization` [W-01].
      Verificación: `pnpm --dir frontend/wallet vitest run src/recovery-activation` + `pnpm --dir frontend/wallet test:browser -- recovery-activation`.
- [x] **P18.T02** — Creación de Safe: cálculo **propio** de la dirección (initializer + CREATE2 con direcciones de su `chain.base.json`) comparado con el backend; tras el deploy, verificación **propia** por RPC del frontend de todos los ítems de V9 §16 + codehash de todos los contratos del sistema; la Safe se muestra operativa sólo tras ACTIVE propio; re-verificación en cada desbloqueo.
      Verificación: `pnpm --dir frontend/wallet vitest run src/safe` (predict/verify contra vectores) + `pnpm --dir frontend/wallet test:browser -- safe-creation`.
- [x] **P18.T03** — Home: dirección (EIP-55, copiar, QR de recepción con advertencia "sólo red Base"), saldos leídos directo de cadena y cruzados con backend, actividad reciente, banner de rotaciones pendientes leídas on-chain.
      Verificación: `pnpm --dir frontend/wallet test:browser -- home` (copiar dirección, QR, saldos, actividad).
- [x] **P18.T04** — Assets: USDC y USDT con balance, símbolo, decimales y contrato; si `symbol/decimals` on-chain difieren de la config → error bloqueante.
      Verificación: `pnpm --dir frontend/wallet test:browser -- assets`.
- [x] **P18.T05** — Whitelist: lista (`destinationsOf` on-chain + labels del backend), alta (código del email, revisión de la dirección, firma U), cuenta regresiva de activación, baja.
      Verificación: `pnpm --dir frontend/wallet test:browser -- whitelist`.
- [x] **P18.T06** — Send: token, destino (sólo ACTIVE), monto (parsing con bigint y decimales), review decodificado desde los bytes construidos localmente y comparados con los del backend, 2FA si corresponde, firma, seguimiento de estado.
      Verificación: `pnpm --dir frontend/wallet test:browser -- send` (incluye bytes del backend ≠ locales → firma bloqueada).
- [x] **P18.T07** — Swap: cotización del backend + cotización propia (QuoterV2 `eth_call` por RPC propio), slippage ≤ 0,5 %, review de las 2 SafeTx (approve exacto + swap, allowance final 0), firma de ambas, seguimiento del grupo.
      Verificación: `pnpm --dir frontend/wallet test:browser -- swap`.
- [x] **P18.T08** — Actividad: operaciones con estados (incluye MINED/CONFIRMED/FINALIZED), transfers entrantes/salientes, link al explorer (sin embeber terceros).
      Verificación: `pnpm --dir frontend/wallet test:browser -- activity`.
- [x] **P18.T09** — Seguridad: rotaciones (pendientes on-chain, cancelar con firma U → relay o exportar firma; ejecutar maduras), estado de Recovery, sesiones, TOTP.
      Verificación: `pnpm --dir frontend/wallet test:browser -- security-rotations`.
- [x] **P18.T09.a** — Reemplazar Recovery (R perdida o comprometida): iniciar enrollment de R' (mismo flujo QR/link de P18.T01 hacia Recovery), U firma la propuesta, cuenta regresiva de 48 h, U firma la ejecución.
      Verificación: `pnpm --dir frontend/wallet test:browser -- replace-recovery`.
- [x] **P18.T09.b** — Rotación de S solicitada por la plataforma (shard, migración a HSM, compromiso): banner con motivo, revisión de la nueva dirección S' (leída on-chain del timelock tras proponer), U firma propuesta y, al madurar, ejecución.
      Verificación: `pnpm --dir frontend/wallet vitest run src/security/rotations` + test de integración contra backend y fork.
- [x] **P18.T10** — Co-firma soberana: importar SafeTx (JSON/QR) de Recovery, decodificar y mostrar, firmar con U, exportar firma; **sin backend**.
      Verificación: `pnpm --dir frontend/wallet vitest run src/sovereign` + `pnpm --dir frontend/wallet test:browser -- sovereign-cosign`.
- [x] **P18.T11** — Migración excepcional en Wallet (`/security/migration`): verificación on-chain de la Safe destino (owners, roles en el Guard, creada por la factory, autorización madura en `PolicyRegistry`) antes de firmar `MIGRATION_TRANSFER` con U.
      Verificación: test de integración contra el fork con una autorización de migración de prueba.

**Tests a implementar:**

- [x] **P18.TST** — unit de `predict.ts`/`verify.ts` contra vectores; integración contra backend + fork (onboarding completo, send, swap, whitelist, rotaciones); test de que la UI no permite elegir destinos no ACTIVE; test de que un `prepare` del backend con bytes distintos a los locales bloquea la firma.
      Verificación: `pnpm --dir frontend/wallet test && pnpm --dir frontend/wallet test:browser`.

**Checks manuales:**

- [x] **P18.MAN** — recorrido completo en el fork; legibilidad del review de operaciones.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** todas las pantallas de [F-UI] Wallet operativas contra servicios reales del entorno local.

**Security checks:**

- [x] **P18.SEC** — ningún dato de la SafeTx se toma del backend sin re-construcción local; verificación independiente de la Safe obligatoria.
      Verificación: `pnpm --dir frontend/wallet test:browser -- security`.

**Commits:** `feat(wallet): add safe onboarding, assets, whitelist, send and swap`.

#### CHECKPOINT P18

- [x] build pasa: `pnpm --dir frontend/wallet build`.
- [x] tests pasan: `pnpm --dir frontend/wallet test && pnpm --dir frontend/wallet test:browser`.
- [x] security tests pasan: `pnpm --dir frontend/wallet test:browser -- security`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P20:** Wallet completa en local (P19 puede haberse completado en paralelo).

---

### P19 — Frontend Recovery

**Objetivo:** app mínima e independiente para R (V9 §5/§6/§14/§18; prompt §9).

**Archivos/componentes:** `frontend/recovery/src/{api/*,crypto/*,workers/argon2.worker.ts,drive/*,auth/*,enroll/*,external-wallet/* (lazy),recover-u/*,rotations/*,sovereign/*,chain/*}`, `src/config/chain.base.json` (copia propia).

**Dependencias:** P15, P16.

**Implementación requerida:**

- [x] **P19.T01** — Auth de cuenta + step-up (email OTP + TOTP) → PlatformSession `ENROLLMENT`/`RECOVERY` con session key propia (Enrollment Key).
      Verificación: `pnpm --dir frontend/recovery vitest run src/auth`.
- [x] **P19.T02** — Módulo `crypto/` **implementado y revisado por separado** del de Wallet (R-encryption-v1, Password R, sobre `R.enc`, 17 palabras); comparte sólo vectores de test (copiados, con hash).
      Verificación: `pnpm --dir frontend/recovery vitest run src/crypto` (mismos vectores que Wallet, copia propia con hash).
- [x] **P19.T03** — Enrollment desde link/QR: Enrollment Key, crear R interna (Password R + backups: Drive Recovery / archivo / QR / palabras) **o** conectar wallet externa (chunk lazy: `injected`, `metaMask`, `coinbaseWallet` con `preference: { options: 'eoaOnly' }`, `walletConnect` con `showQrModal: false` y QR propio), proof-of-control EIP-712, envío, link/QR de regreso [F-LNK-02].
      Verificación: `pnpm --dir frontend/recovery test:browser -- enroll` (R interna y externa con el provider de test).
- [x] **P19.T04** — Recovery de U: ver U' pendiente (y comparar con lo que muestra Wallet), desbloquear R, firmar propuesta (R+S), cuenta regresiva on-chain, firmar ejecución al madurar.
      Verificación: `pnpm --dir frontend/recovery test:browser -- recover-u`.
- [x] **P19.T05** — Rotaciones: pendientes on-chain; cancelar con firma de R (relay del backend o envío propio con wallet externa pagando gas a `cancelWithSignature`); ejecutar maduras.
      Verificación: `pnpm --dir frontend/recovery test:browser -- rotations`.
- [x] **P19.T06** — Modo soberano: acciones tipificadas (transferir saldo a una dirección elegida, reemplazar S, retirar/cambiar Guard o module guard, `updateRoles` del Guard, NoOp) con el formato [W-05], nonce leído on-chain, firma R, export para co-firma U, import de la firma U, combinación ordenada por signer, transmisión con wallet externa o export de calldata para cualquier relayer. Debe funcionar **con el backend apagado**.
      Verificación: `pnpm --dir frontend/recovery test:browser -- sovereign` con el backend detenido.
- [x] **P19.T07** — Compatibilidad de conectores con CSP/Trusted Types: test E2E por conector; hosts de WalletConnect agregados a `connect-src` tras verificarlos en la doc oficial; conectores incompatibles excluidos y documentados.
      Verificación: `pnpm --dir frontend/recovery test:browser -- connectors` y registro de conectores probados en §13.
- [x] **P19.T08** — Importar/restaurar R [F-KEY-10]: desde Drive de Recovery en un dispositivo nuevo, archivo, QR o 17 palabras; verificación contra el rol R on-chain; nueva Password R y re-cifrado si se restauró por palabras.
      Verificación: `pnpm --dir frontend/recovery vitest run src/restore` + `pnpm --dir frontend/recovery test:browser -- restore`.
- [x] **P19.T09** — Herramienta de salida soberana `wallet/tools/sovereign-exit/`: bundle estático único, reproducible y firmado, que funciona offline (sólo usa el RPC que el usuario indique): descifra `U.enc`/`R.enc` o restaura desde 17 palabras, arma una SafeTx soberana tipada, firma con U y R, combina y emite la calldata de `execTransaction` o la transmite con la cuenta que el usuario elija. Es la única pieza que junta U y R, sólo en la máquina del usuario y fuera de los origins de la plataforma.
      Verificación: test E2E en el fork con backend y frontends apagados: transferencia soberana exitosa.
- [x] **P19.T10** — Pantallas `/emergency` (R + S: quitar destinos, NoOp, revocar allowances) y `/migration` (R firma `MIGRATION_TRANSFER` tras verificar on-chain la Safe destino).
      Verificación: `pnpm --dir frontend/recovery vitest run src/emergency src/migration` + integración contra backend y fork.

**Tests a implementar:**

- [x] **P19.TST** — vectores crypto; enrollment interno y externo (con wallet de prueba inyectada en Playwright mediante extensión/provider EIP-6963 de test que firma con una clave de test — sólo en E2E); recovery de U en fork con warp de 48 h; modo soberano con backend detenido.
      Verificación: `pnpm --dir frontend/recovery test && pnpm --dir frontend/recovery test:browser`.

**Checks manuales:**

- [x] **P19.MAN** — WalletConnect real: test automatizado que conecta Recovery con una wallet headless (`@reown/walletkit`, versión fijada) a través del **relay real de Reown** con `WALLETCONNECT_PROJECT_ID`, firma el proof-of-control y una cancelación de rotación en el fork; más los conectores `injected`, `metaMask` y `coinbaseWallet` con el provider EIP-6963 de test.
      Verificación: `pnpm --dir frontend/recovery test:browser -- walletconnect.live` en verde; resultado registrado en §13.

**Acceptance criteria:** Recovery cumple su función mínima sin compartir runtime con Wallet; modo soberano operativo sin plataforma.

**Security checks:**

- [x] **P19.SEC** — grafo de bundle (P16.T08) verde; ningún request a terceros salvo los de WalletConnect cuando se usa ese conector.
      Verificación: `pnpm --dir frontend/recovery test:browser -- security && pnpm --dir frontend/recovery vitest run test/bundle-graph.test.ts`.

**Commits:** `feat(recovery): add independent recovery frontend`, `feat(recovery): add sovereign transaction builder`.

#### CHECKPOINT P19

- [x] build pasa: `pnpm --dir frontend/recovery build`.
- [x] tests pasan: `pnpm --dir frontend/recovery test && pnpm --dir frontend/recovery test:browser`.
- [x] security tests pasan: `pnpm --dir frontend/recovery test:browser -- security && pnpm --dir frontend/recovery vitest run test/bundle-graph.test.ts`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs`.
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P20:** enrollment, recovery de U, cancelación y modo soberano verdes en local.

---

### P20 — Integridad de releases y pausa de cooperación de S

**Objetivo:** V9 §17 "monitores independientes … una discrepancia pausa la cooperación de S".

**Archivos/componentes:** `wallet/backend/integrity-monitor/` (proyecto propio: `src/monitor.ts`, `src/attestation.ts`), `.github/workflows/wallet-integrity-offhost.yml` (chequeo off-host programado), `backend/signer/src/policy/integrity.ts`, `wallet/config/release-keys/{wallet.pub,recovery.pub}` (públicas), runbook `docs/runbooks/integrity-mismatch.md`.

**Dependencias:** P18, P19.

**Implementación requerida:**

- [x] **P20.T01** — Claves de release Ed25519 **distintas** para Wallet y Recovery (dev en `.secrets/`; staging/prod sólo en el GitHub Environment de cada pipeline). Públicas fijadas en el monitor.
      Verificación: `node scripts/check-release-keys.mjs` (públicas fijadas, privadas ausentes del repo y del backend).
- [x] **P20.T02** — Integrity monitor (contenedor propio, clave de atestación propia): cada 60 s y por app/entorno descarga `/.well-known/release-manifest.json(.sig)`, verifica firma, descarga cada archivo listado y verifica SHA-256, verifica headers (CSP, HSTS, etc.) y SRI de `index.html`, detecta archivos/scripts no listados; registra `integrity_status` y emite la atestación firmada `IntegrityAttestation` de [W-03] (`{platformId, app, environment, releaseId, manifestSha256, status, observedAt, expiresAt}`) que consume el signer.
      Verificación: `pnpm --dir backend/integrity-monitor vitest run`.
- [x] **P20.T02.a** — Chequeo **off-host**: workflow programado de GitHub Actions (cada 15 min) que hace las mismas verificaciones contra las URLs públicas con las claves públicas de release del repo y alerta por email/webhook ante discrepancia; no depende del host de producción (si el host se compromete, la alerta igual sale), no pausa al signer.
      Verificación: ejecución manual del workflow contra un `vite preview` expuesto en un runner de prueba con un archivo alterado → falla y notifica.
- [x] **P20.T03** — Signer: con `INTEGRITY_REQUIRED=true` (staging/prod) exige atestaciones OK de ambas apps con antigüedad ≤ 5 min; ante MISMATCH rechaza cooperar de inmediato (`COOPERATION_PAUSED`); ante UNREACHABLE alerta y concede 15 min de gracia antes de pausar; alerta crítica, auditoría y banner en Wallet; el camino soberano no se afecta.
      Verificación: `pnpm --dir backend/signer vitest run test/policy/integrity.test.ts`.
- [x] **P20.T04** — Reanudación sólo con atestación OK + acción de dos operadores registrada.
      Verificación: `pnpm --dir backend/integrity-monitor vitest run test/resume-dual-approval.test.ts`.

**Tests a implementar:**

- [x] **P20.TST** — alterar un archivo del build servido localmente → pausa en ≤ 2 ciclos; firma de manifest inválida → pausa; restaurar → reanudación con doble aprobación; monitor caído → fail-closed.
      Verificación: `pnpm --dir backend/integrity-monitor test && pnpm --dir backend/signer vitest run test/policy/integrity.test.ts`.

**Checks manuales:**

- [x] **P20.MAN** — simulacro de mismatch en local con el stack completo.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** A20 verde.

**Security checks:**

- [x] **P20.SEC** — el monitor no comparte credenciales con los pipelines de frontends; las claves privadas de release no existen en el backend.
      Verificación: `bash ci/scripts/ci-security.sh`.

**Commits:** `feat(security): add release integrity monitoring and signer cooperation pause`.

#### CHECKPOINT P20

- [x] build pasa: `pnpm --dir backend/integrity-monitor build`.
- [x] tests pasan: `pnpm --dir backend/integrity-monitor test && pnpm --dir backend/signer vitest run test/policy/integrity.test.ts`.
- [x] security tests pasan: `bash ci/scripts/ci-security.sh`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs` (runbook de integridad).
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

**Condición para pasar a P21:** pausa por integridad demostrada en local.

---

### P21 — Entorno local integrado y seed determinístico

**Objetivo:** levantar todo con el mínimo de comandos y obtener siempre el mismo escenario (prompt §26–§27).

**Archivos/componentes:** `wallet/scripts/{dev.mjs,install-all.mjs,dev-fresh}`, `wallet/package.json` (scripts `install` hook, `dev`, `dev:fresh`, `deploy-local`, `seed-local`), `docs/runbooks/local-environment.md`.

**Dependencias:** P20.

**Implementación requerida:**

- [x] **P21.T01** — `pnpm install` en `wallet/` ejecuta `scripts/install-all.mjs`: `pnpm install --frozen-lockfile` en cada proyecto (lockfiles separados) y `forge soldeer install` + `script/verify-deps.sh` en `contracts`; sin dependencias en la raíz.
      Verificación: `cd wallet && pnpm install` en un clon limpio instala todos los proyectos con lockfile congelado.
- [x] **P21.T02** — `pnpm dev` (`scripts/dev.mjs`, sólo `node:child_process`): verifica preflight rápido → compose arriba → migraciones (backend y signer) → `deploy-local` (idempotente) → `seed-local` (idempotente) → signer dev, API (8080/8081), worker, watcher, indexer, gas tank, integrity monitor (modo local) → Wallet (5173) y Recovery (5174); logs con prefijo; apagado ordenado con Ctrl+C.
      Verificación: `node scripts/dev-healthcheck.mjs` (health de cada servicio, contratos desplegados y ambos frontends respondiendo).
- [x] **P21.T03** — `pnpm dev:fresh`: `fork:reset` + reset de DBs + deploy + seed → escenario determinístico (mismas direcciones de contratos y de la Safe de prueba, mismos saldos reales de USDC/USDT del fork).
      Verificación: `pnpm dev:fresh` dos veces → mismas direcciones y saldos (`diff` de los reportes de seed).
- [x] **P21.T04** — Seed completo (prompt §27), extendiendo la parte on-chain de P07.T07 con la off-chain: usuario de prueba con email verificado en DB, U/R generadas de forma determinística **sólo en local** desde `LOCAL_SEED` (los flujos de producto siguen generando claves con CSPRNG), sobres `U.enc`/`R.enc` de prueba cifrados con Passwords de prueba en `wallet/.secrets/seed/` (para importarlos en los frontends), registro OPAQUE del usuario, S en signer dev, Safe creada por `WalletFactory` y registrada en DB como ACTIVE tras la verificación normal, USDC y USDT fondeados con tokens reales del fork, destino de prueba whitelisteado y activado (warp de 24 h en el fork). Imprime credenciales de prueba (sólo local).
      Verificación: `node scripts/seed-check.mjs` (login por API del usuario seed, Safe ACTIVE y saldo on-chain esperado).
- [x] **P21.T05** — Runbook local + troubleshooting (puertos ocupados, RPC archive, caché del fork, reset).
      Verificación: `node scripts/check-docs.mjs`.

**Tests a implementar:**

- [x] **P21.TST** — `scripts/dev-healthcheck.mjs` y `scripts/seed-check.mjs`: tras `pnpm dev:fresh` todos los servicios responden, el usuario seed inicia sesión por API, su Safe está ACTIVE con el saldo esperado, y dos ejecuciones de `dev:fresh` producen los mismos valores (el spec E2E equivalente se agrega en P22).
      Verificación: `node scripts/dev-healthcheck.mjs && node scripts/seed-check.mjs`.

**Checks manuales:**

- [x] **P21.MAN** — desde un clon limpio: `docker compose up -d && pnpm install && pnpm preflight && pnpm dev`.
      Verificación: resultado registrado en §13 (fecha, responsable y observaciones).

**Acceptance criteria:** los 4 comandos levantan PostgreSQL, Valkey, fork de Base, contratos desplegados, backend, worker, signer, Wallet y Recovery.

**Security checks:**

- [x] **P21.SEC** — el seed se niega a correr fuera de `APP_ENV=local` y fuera de Anvil.
      Verificación: `bash ci/scripts/ci-security.sh`.

**Commits:** `chore(infra): add one-command local environment and deterministic seed`.

#### CHECKPOINT P21

- [x] build pasa: `pnpm install && pnpm dev` (todos los servicios arriba).
- [x] tests pasan: `node scripts/dev-healthcheck.mjs && node scripts/seed-check.mjs`.
- [x] security tests pasan: `bash ci/scripts/ci-security.sh`.
- [x] integración anterior sigue funcionando: `pnpm ci:local`.
- [x] documentación actualizada: `node scripts/check-docs.mjs` (runbook local).
- [x] no secrets committed: `gitleaks git --redact` sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío.
- [x] git status revisado: `git status --short` vacío tras el commit; `git push origin feat/walletWeb/cmarchese`; hash anotado en §13.

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
| 2026-10-17 | P01 — Fundaciones del repositorio y toolchain | Completado | `df9f6bf` `docs(wallet): add architecture decision records and threat model`, `f9d4560` `chore(wallet): pin toolchain versions and add wordlist v1` | 32 ADRs, `THREAT_MODEL.md` v1, `docs/VERSIONS.md` (sin rangos; `versions-doc.test.mjs` lo contrasta con `versions.json`), estructura de §5.2 con README por carpeta, `.editorconfig`, `.gitattributes`, `.gitleaks.toml` (reglas por defecto + propias; direcciones EVM públicas en allowlist) y hook pre-commit instalado por `bootstrap hook` (probado: bloquea un secreto de prueba y deja pasar lo limpio), wordlist MTW-WORDLIST-V1 verificada (65.536 palabras, SHA-256 `c2bf4e5b…`, licencia MIT), política de supply chain de pnpm en `pnpm-workspace.yaml` (pnpm 12 ya no lee esos settings de `.npmrc`). P01.MAN y P01.T07 (2026-10-17, agente revisor independiente): primera revisión **no aprobado** (3 altos: GUARD_UPGRADE ausente en ADR-005 y ADR-025, topología de host único en ADR-022; 5 medios; 7 bajos); segunda revisión **aprobado con observaciones** (1 medio, 6 bajos), todas corregidas; CF-01 no bloqueante y CF-06 aprobado confirmados. Push protection de GitHub bloqueó un push por fixtures con formato de credencial: los tests arman esos valores en tiempo de ejecución. |
| 2026-10-17 | P02 — CI base | Completado | `8efad40` `ci(wallet): add per-domain ci scripts and workflows` | Scripts `wallet/ci/scripts/ci-<área>.sh` (SKIP mientras el proyecto no existe), `ci-security.sh` (gitleaks sobre la historia completa, OSV-Scanner, `pnpm audit --prod`, Semgrep con reglas de registry y propias, zizmor), gate de cobertura de contratos, build reproducible en dos jobs y `pnpm ci:local` en verde (árbol limpio del commit). Nueve workflows: los ocho del planner más `wallet-ci-gate`, único check requerido de `main`, que espera los workflows de las áreas tocadas (un check requerido con filtro `paths` quedaría pendiente para siempre en PRs que no tocan `wallet/`). Acciones fijadas por SHA, `permissions: contents: read`, sin `pull_request_target`, checkout sin credenciales persistidas; zizmor sin hallazgos high/medium (sólo 10 sugerencias low de sintaxis `$/`). Environments por área con sus secrets y `wallet-staging`/`wallet-production` restringidos a tags `wallet-v*`; ruleset que protege los tags `wallet-v*` (bypass sólo admin); protección de `main`: check `wallet-ci-gate`, PR obligatorio, commits firmados, incluye administradores, sin force push ni borrado. Cambio respecto del planner: el repositorio es de un usuario con un único colaborador, así que CODEOWNERS apunta a `@DigiCris` por dominio y la protección no exige la aprobación de un code owner (GitHub no permite aprobar el PR propio y bloquearía todo merge); se activa al sumar un segundo revisor (`docs/CI.md`). P02.MAN (2026-10-17, agente, `bash ci/github/apply-settings.sh verify`): secretos separados por Environment, `wallet-production` y `wallet-staging` sólo con tags `wallet-v*`, secrets de CI presentes. |
| 2026-10-17 | CHECKPOINT P02 | Completado | `8efad40` | Workflows del push en verde en GitHub (wallet-security con `docs` y `security`, wallet-contracts, wallet-backend, wallet-signer, wallet-frontend-wallet, wallet-frontend-recovery, wallet-repro-build). P02.T03: PR de prueba #1 (rama temporal que sólo tocaba `wallet/frontend/wallet/`, contra el branch de trabajo) disparó únicamente wallet-frontend-wallet, wallet-repro-build y wallet-security (wallet-e2e omitido por no tener label); PR cerrado sin merge y rama borrada. |
| 2026-10-17 | P03 — Base fork y contratos externos | Completado | `901d6dd` `feat(contracts): pin external base dependencies and fork verification` | `config/chains/base-mainnet.json` completado (`verifiedAt` y `notes` por contrato, fuentes de Uniswap fijadas por commit de `Uniswap/sdks` porque la página de deployments de v3 ahora redirige a GitHub); proyecto Foundry con solc 0.8.37, EVM `cancun`, optimizer 200 sin `via_ir`, perfiles `default`/`ci`/`fork` y dependencias Soldeer verificadas byte a byte contra las fuentes oficiales (`script/verify-deps.sh`: forge-std 32, OpenZeppelin 226 y v3-core 29 archivos `.sol` idénticos; Safe en `dc437e8`); `test/fork/ExternalContracts.t.sol` (hash del bloque, 16 codehashes, Safe 1.5.0, `proxyCreationCode`, USDC/USDT, pool) en verde; `scripts/verify-external` (cast, en paralelo, sin imprimir la URL del RPC) integrado como PF-15 (un codehash alterado en una copia del JSON → FALLA, exit 1); `docs/EXTERNAL_CONTRACTS.md` con `check-external-docs.mjs`; `docs/runbooks/fork.md` con la advertencia de Denim. P03.MAN (2026-10-17, agente): cada dirección contrastada contra su fuente oficial: Safe (safe-deployments v1.5.0, `canonical` en 8453), USDC (Circle), USDT (Superchain token list), Uniswap v3 factory/QuoterV2/SwapRouter02 (`sdk-core`), UniversalRouter 2.1.2 (`universal-router-sdk`, 8453), Permit2 (`permit2-sdk`), v4 (deployments oficiales y `sdk-core`); el pool se deriva con `getPool` en el fork. Con el Anvil local, los fork tests se corren con `--threads 1`. |
| 2026-10-17 | P04 — Contratos I | Completado | `b56e72c` `feat(contracts): add policy registry, destination whitelist and deny-all module guard` | Librerías (`SafeSignatureParser`, `CallDecoder`, `Roles`, `OpTypes`), interfaces, `PolicyRegistry` (modos, timelock de 24 h, guardianes, revocación inmediata, sucesores [C-POL-06]), `DestinationWhitelist` y `DenyAllModuleGuard`. Tests: unitarios y fuzz de cada contrato; P04.T01 compara los selectores con la interfaz oficial de Safe (commit fijado) y con el bytecode desplegado; P04.T02 diferencial del parser contra `checkNSignatures` de una Safe real del fork (10.000 runs en el perfil `ci`, más un diferencial de layout contra `SignatureDecoder`); P04.T03 recorre cada selector de autoridad económica de [C-DEC-03] (con selectores de las interfaces de OpenZeppelin donde existen); P04.T06 en fork: Safe 1.5.0 acepta `setModuleGuard(DenyAll)` y toda ejecución por módulo revierte. Cobertura de `src/`: 100 % de líneas y ramas en PolicyRegistry, CallDecoder, SafeSignatureParser, Roles, DestinationWhitelist y DenyAll (`forge coverage` no atribuye las ramas de modificadores inlineados a todas sus copias: se testea el revert de cada función protegida). Slither: sin High ni Medium (`docs/security/slither-triage.md`). Cambio respecto del planner: Slither 0.11.6 no admite `--fail-high` junto con `--fail-medium`; se usa `--fail-medium`, que ya falla con High (planner, `ci-contracts.sh` y `CI.md` actualizados). P04.MAN (2026-10-17, agente): NatSpec revisada; se documentaron las 22 funciones externas de `PolicyRegistry` que no la tenían; cada cambio de estado emite su evento (altas, activaciones, cancelaciones, revocaciones, modo). |
| 2026-10-17 | CI: Semgrep en el gate de seguridad | Completado | `17afffa` `ci(wallet): exclude gas-optimization semgrep rules from the security gate` | El job `security` de GitHub falló con el código de P04 por cuatro reglas `solidity.performance.*` del pack `p/smart-contracts` (sugerencias de gas, no de seguridad, algunas contrarias a decisiones del proyecto): se excluyen por id en `ci-security.sh` y los dos falsos positivos de seguridad restantes llevan `nosemgrep` con justificación (`docs/security/semgrep-triage.md`). Workflows del push en verde. |
| 2026-10-17 | P06 — Contratos III: SwapExecutorV3 | Completado | `d21265e` `feat(swap): add restricted usdc usdt swap executor` | `SwapExecutorV3` [C-SWP-01..05] contra el pool canónico v3 USDC/USDT 0,01 %: tokens, pool y factory inmutables verificados en el constructor (`getPool`, `token0/token1/fee`, decimales), payer en transient storage atado a `msg.sender`, `ReentrancyGuardTransient`, callback sólo del pool durante un swap y sólo por el `amountIn` exacto, débito exacto y crédito mínimo, recipient siempre el llamador, sin custodia ni admin. Registro del executor y de USDC/USDT en el set V1 del `PolicyRegistry` e integración con [C-GRD-07]/[C-GRD-09] (`SwapGuardIntegration`, 5 tests, en el commit del Guard). Tests en fork: `SwapExecutorV3Test` (16: ambos sentidos con saldos, executor sin fondos y allowance final 0, fill parcial y monto sobre la liquidez, piso de `minOut`, deadline, token arbitrario, callback ajeno, reentrancia, resultados inconsistentes del pool, allowance residual inutilizable por terceros, fuzz de 1 unidad a 10.000 tokens y slippage) y `QuoteReferenceTest` (2: swap real == QuoterV2 en el mismo bloque, de 1 a 10.000 tokens en ambos sentidos). ADR-015 con el análisis completo de alternativas (SwapRouter02, UniversalRouter + Permit2, v4, MultiSend). A15 y A16 en verde. P06.MAN (2026-10-17, agente, contra el executor desplegado por `DeployCore` en el fork local, trader fondeado por impersonación de un holder real): 1.000 USDC → 1.001,363627 USDT y QuoterV2 en el bloque anterior (52700323) devuelve exactamente lo mismo; 1.001,363627 USDT → 999,800009 USDC, idéntico a QuoterV2 en 52700325; allowance final 0 y executor sin saldo en ambos. P06.SEC: el único `transferFrom` de `src/` es el del callback con payer = `msg.sender` del swap en curso (`docs/security/external-calls-review.md`); Slither sin Medium/High. Cambios respecto del planner: el fuzz de swaps en fork corre 500 runs en el perfil `ci` (`forge-config: ci.fuzz.runs = 500`) por el costo de RPC (el resto del perfil mantiene 10.000); el commit del executor va antes que el del Guard porque `SystemDeployer`/`DeployCore` de P05 lo despliegan en el orden de §6.1. |
| 2026-10-17 | P05 — Contratos II: SecurityGuard, RotationTimelock, SafeBootstrap, WalletFactory | Completado | `fc77d7d` `feat(contracts): add security guard, rotation timelock and wallet factory`, commit `feat(wallet): add deterministic safe deployment` | `SecurityGuard` [C-GRD-01..17] con contexto apilado por Safe y profundidad en transient storage (runtime 22.707 B < 24.576: sin [C-GRD-16], ADR-003), `RotationTimelock` [C-RTL-01..05] (EIP-712, cancelación por firma de la U o R vigente), `SafeBootstrap` y `WalletFactory` con `createProxyWithNonceL2` y verificación atómica [C-FAC-05]. Tests de integración en fork: WalletFactory 16, SafeBootstrap 7, RotationTimelock 9, AssistedPath 21, SovereignPath 10, Rotations 7, GuardUpgrade 9, Migration 2, BootstrapMode 3 y GuardBranches 9. Criterios de aceptación: A1/A2/A3 `test_singleKeyCannotExecute` (`GS020` con una clave y `GS026` con la misma clave dos veces) y `test_executorApprovedHashSignatureRejected`; A6 `SovereignPathTest` completo; A7 `test_ethSignCosignerRejected` y el diferencial de P04; A8 `test_structuralInvariants`, `test_sovereignConfigChangesFailClosedUntilRestored` y `DenyAllModuleGuardForkTest`; A11 `WalletFactoryTest` y `SafeBootstrapTest`; A12 `test_signaturesCannotBeReplayed` (otro nonce, otra Safe y chainId 1); A13 `test_noOpCancelsPendingNonce`; A17 `RotationsTest` y `RotationTimelockTest`. Cobertura de `src/`: 100 % de líneas y de ramas. P05.T05: `DeployCore.s.sol` (orden de §6.1, nonce del deployer verificado al inicio, `WalletFactory` predicha y verificada al final, `validateConfig`, JSON de [C-SCR-01]), `VerifyDeployment.s.sol` (123 verificaciones: externos, direcciones `CREATE`, codehash, runtime idéntico al artefacto salvo inmutables, compilador, cada inmutable, policy inicial y argumentos de constructor; `DeployScriptsTest` exige la cantidad exacta de fallas ante cada alteración), `FundForkAccounts.s.sol`, `scripts/deploy-core` y runbook `docs/runbooks/deploy.md`; deploy en el fork local con el deployer derivado de `LOCAL_SEED` (nonce 0): `WalletFactory` en la dirección predicha y `VerifyDeployment OK`. P05.MAN (2026-10-17, agente): Safe creada por la factory desplegada en el fork (`createWallet` con un remitente impersonado, 492.909 de gas) e inspeccionada con `cast` vía `scripts/inspect-wallet`: codehash del proxy, singleton SafeL2, `VERSION` 1.5.0, owners == roles del Guard, threshold 2, nonce 0, guard == SecurityGuard, module guard == DenyAll, fallback 0, sin módulos, `rolesOf` registrada (v1), `isWallet` y `verifyWallet` OK; contra una Safe ajena (la Governance Safe) el inspector reporta 6 diferencias y sale con 1. P05.SEC: Slither 0.11.6 con 67 resultados, todos informativos o Low triados; revisión manual de cada llamada externa del Guard (`docs/security/external-calls-review.md`), que encontró y corrigió una lectura sin protección en `_predecessorRoles`: ahora `_tryGuardSlot` hace una `staticcall` con decodificación de largo exacto y nunca revierte (test con cuatro singletons hostiles). Cambios respecto del planner: (1) la importación de roles de [C-GRD-17] vive en el propio `SecurityGuard` (inmutable `PREDECESSOR`, 0 en V1, `RolesImported`) y el chequeo de estado intacto acepta el module guard sucesor activo en el registro, porque sin eso un upgrade legítimo de module guard dejaría el camino asistido en fail-closed para siempre (ADR-029); (2) `WalletFactory.validateConfig` pública (el constructor revierte con `InvalidConfig(reason)`) para re-verificar on-chain desde los scripts, `verifyWallet` tolera singletons que no son Safe, `createWallet` es `nonReentrant` y los constructores rechazan direcciones cero; (3) la forma de verificar P05.T05: el fondeo va en una invocación de forge previa porque la simulación on-chain de `forge script` usa el estado del bloque en que arranca, `DeployCore` se niega a transmitir fuera de Anvil, y se agregó la red `ci` para que el job de contratos despliegue y verifique de punta a punta en cada corrida; la regla "ningún workflow despliega" de `workflows.test.mjs` se acotó a los comandos (excluye los filtros `paths:`) y se sumó una regla que sólo admite el broadcast de `deploy-ephemeral.sh` contra `127.0.0.1`; (4) `DeployScriptsTest` se omite bajo `forge coverage` (`vm.isContext`), porque ese build sin optimizador no coincide con los artefactos de release que compara `VerifyDeployment`; corre completo en `forge test`; (5) el parámetro de `ISafe.getTransactionHash` se llama `_nonce`, como en la interfaz oficial (shadowing de Slither). |
| 2026-10-17 | CHECKPOINT P05 y P06 (local) | Completado | `fc77d7d` y commit `feat(wallet): add deterministic safe deployment` | `bash ci/scripts/ci-contracts.sh`: `forge build --sizes`; `forge test --profile ci` con 204 tests en 24 suites, sin fallas; cobertura de `src/` 100 % de líneas y ramas; Slither `--fail-medium` OK; `DeployCore` + `VerifyDeployment` sobre el Anvil efímero OK. `node scripts/check-docs.mjs` → DOCS OK, tests de CI y del preflight en verde, gitleaks sin hallazgos en cada commit. `pnpm ci:local` y la CI de GitHub del push se registran en la fila siguiente. |
| 2026-10-17 | CHECKPOINT P05 y P06 (CI) | Completado | `f81b640`, `562892a` `fix(contracts): create the deployments directory before writing the json` | `pnpm ci:local` en verde sobre el árbol limpio de `f81b640` (`CI LOCAL OK`). En GitHub, todos los workflows del push quedaron en verde salvo `wallet-contracts`: el deploy efímero falló con `vm.writeJson: No such file or directory`, porque git no versiona el directorio vacío `contracts/deployments/` y en local ya existía. `DeploymentJson.write` ahora lo crea; se reprodujo localmente sin el directorio y pasó. Con `562892a`, `wallet-contracts` y `wallet-security` quedaron en verde. |
| 2026-10-17 | P07 — Contratos IV: suite adversarial, fuzz/invariants, cobertura, Slither, deploy/seed local | Completado | `40cf861` `fix(contracts): cache rpc state only for remote endpoints`, `9319d9b` `test(security): add wallet invariants and adversarial tests`, commits `fix(contracts): bound the predecessor guard slot read and narrow slither suppressions`, `chore(contracts): add deterministic local deploy and seed` y `feat(contracts): export abis and cross-language vectors` | P07.T01: 18 contratos de ataque en `test/adversarial/` (a–r, 82 tests), cada uno con el motivo de revert exacto (errores del Guard, `GS0xx` de Safe o el motivo del token o del pool cuando Safe 1.5.0 propaga el revert interno). P07.T02: `WalletInvariantsTest`, un handler con 23 acciones (asistidas legítimas y abusivas, soberanas y warps) y contadores de violación; 12 invariantes (A1–A17, conservación de fondos e integridad de configuración) más `test_handlerExercisesTheSystem`, que demuestra que no son vacuas; perfil `ci` con 32 runs × 50 de profundidad por modo (1.600 llamadas, 0 reverts). P07.T03: cobertura de `src/` 100 % de líneas y de ramas. P07.T04: Slither con 81 hallazgos, 14 suprimidos (3 High, 9 Medium, 2 Low) bajo baseline en CI y 67 informativos o Low (`docs/security/slither-triage.md`). P07.T05: `test/vectors/` (sistema, SafeTxHash de 12 tipos de operación calculados por la Safe real con firmas de U, S y R, CREATE2 y `CancelRotation`) y `test/vectors/wire/` con todos los formatos de §7.15 (W-01 EIP-712 de plataforma en Solidity; W-02 a W-07 en `script/wire-vectors.mjs` sólo con `node:crypto`, con autoverificación inversa de cada vector); `VectorsTest` exige que los commiteados coincidan y regenerar no produce cambios. P07.T06: 10 ABIs en `out-abi/` (8 contratos más `ISafe` e `ISafeProxyFactory`), estables al regenerar. P07.T07: `pnpm deploy-local [--policy-mode]` idempotente (`DeployLocal.s.sol`: si el JSON verifica no transmite; otro modo sobre un deploy existente revierte con `DifferentPolicyModeDeployed`) y `pnpm seed-local` (Safe del usuario de prueba con 10.000 USDC y 5.000 USDT reales transferidos por holders reales impersonados); dos ciclos `fork:reset && deploy-local && seed-local` dan un `deployments/local.json` idéntico. P07.T08: `docs/security/invariants.md`. P07.T09: CI corre la suite completa en `restricted` y en `bootstrap` (290 tests por modo). P07.MAN (2026-10-17, agente revisor independiente con contexto nuevo, Slither en un worktree propio, también con `--show-ignored-findings` y con las supresiones neutralizadas): **aprobado con observaciones**. Ninguna supresión esconde algo explotable. Resoluciones: (1, media) el bloque `slither-disable` que cubría todo `SwapExecutorV3.swap` se reemplazó por supresiones de una línea; `_tokenIn` sale de los inmutables (sin `missing-zero-check`) y el límite de precio se calcula antes de la llamada (`reentrancy-balance` ×4 → ×2); (2) baseline de suprimidos en CI (`ci/scripts/slither-baseline.mjs`, `contracts/slither-suppressed.json`, falla ante cualquier suprimido nuevo o cambiado; probado quitando una entrada); (3 a 7, 9) justificaciones corregidas en el triage (`reentrancy-no-eth` como reentrancia de sólo lectura; post-condiciones reales; taint de `block.timestamp` en `Proposal`; 7 comparaciones de tiempo reales de 10, con la inclusión forzada desde L1 de Base dentro de `seq_window_size = 3600` bloques ≈ 12 h, verificado en `base/base` `32fb57f`, por debajo de los timelocks de 24 h y 48 h; composición real de `naming-convention`; límites de Slither con transient storage en assembly) y comentario de `WalletFactory` reordenado; (8) `_tryGuardSlot` pasa a una `staticcall` en assembly con tope de 50.000 de gas, copia de 96 bytes y retorno exacto, porque un singleton hostil podía agotar el gas del llamador; nuevo test con un singleton que quema gas y return-data bombs de 2 MB y 4 KB. P07.SEC: Slither `--fail-medium` OK, baseline OK, Semgrep de Solidity en `ci-security.sh` y suite adversarial en ambos modos. Cambios respecto del planner: (a) los vectores `wire/` de §7.15 se generan ya en P07.T05, como pide esa sección, aunque la tarea no los listaba; las firmas P-256 se conservan si siguen siendo válidas, porque ECDSA P-256 usa k aleatorio y regenerar no debe producir cambios; (b) invariantes con 32 runs × 50 en `ci` y 16 × 32 en `default`, porque cada llamada son varias SafeTx reales sobre el fork; (c) en `local` y `ci`, `block` y `timestamp` del JSON son los del bloque de fork base (`timeSource`) para que el JSON sea reproducible; (d) `foundry.toml` cachea estado RPC sólo de endpoints remotos y la clave de caché de CI pasa a `v2`: el default de Foundry cacheaba el Anvil local bajo la ruta del Base real (saldos viejos tras `fork:reset` y caché contaminada); (e) se agregaron dos commits de corrección y uno propio para ABIs y vectores y se reforzaron las expectativas de revert genéricas de suites anteriores; (f) las marcas de P07.T01 y P07.T02 van en el commit final de la fase y no en `9319d9b`. |
| 2026-10-17 | CHECKPOINT P07 (local) | Completado | commit `feat(contracts): export abis and cross-language vectors` | `forge build --sizes` (Guard 22.565 B). `POLICY_MODE=restricted` y `POLICY_MODE=bootstrap forge test --profile ci`: 290 tests por modo, sin fallas. Slither `--fail-medium` y baseline OK. ABIs y vectores estables al regenerar. Cobertura 100 % de líneas y ramas. `DeployCore` + `VerifyDeployment` sobre el Anvil efímero OK. `pnpm preflight` → PREFLIGHT PASSED. `pnpm ci:local` en verde. `node scripts/check-docs.mjs` → DOCS OK. gitleaks sin hallazgos en cada commit. La CI de GitHub del push se registra en la fila de P08. |
| 2026-10-17 | Corrección de P06 y P07: umbrales de §10 | Completado | `d72ae47` `test(contracts): run invariant and fuzz campaigns at the full ci thresholds` (CI de GitHub en verde: 500 runs × 25.000 llamadas y fuzz de swaps de 10.000 runs en ambos modos) | Al preparar P08 se revisó §10: exige runs ≥ 500 con profundidad ≥ 50 para invariantes y runs ≥ 10.000 para fuzz en CI. Las filas de P06 y P07 los habían bajado a 32 × 50 y a 500 como "desviaciones", y eso reducía alcance, así que se corrigieron. Causa del costo: con remitentes aleatorios, el motor de invariantes traía cada cuenta nueva del RPC remoto (~0,15 s por llamada; con un handler vacío pasaba lo mismo y 8 campañas en paralelo dieron HTTP 429). Con `targetSender` fijo baja a ~4 ms por llamada. Resultado: `WalletInvariantsTest` corre 500 runs × 50 por modo de policy (25.000 llamadas, 0 reverts, ~97 s cada modo) y el fuzz de swaps vuelve a 10.000 runs (~15 s; el tope de 500 respondía a una caché RPC fría). `[profile.ci.invariant]` pasa a `runs = 500`. |
| 2026-10-17 | P08 — Backend I: fundaciones | Completado | commit `feat(backend): add service foundations, schema and observability` | P08.T01: proyecto `backend/app` (Node 26 con type stripping, TypeScript 6.0.3 estricto con `erasableSyntaxOnly` y `rewriteRelativeImportExtensions`, ESLint 10 + typescript-eslint `strictTypeChecked`, Prettier, Vitest 5 con los proyectos `backend` y `security`); versiones exactas y política de supply chain (`check-pnpm-policy` OK, cuatro scripts de instalación denegados con su motivo). P08.T02: `src/config/env.ts` con Zod por `APP_ENV`; todo secreto por `<VAR>` o `<VAR>_FILE` y sólo `_FILE` con ruta absoluta en staging/producción (ADR-030); rechazo de valores de ejemplo, claves de baja entropía, passwords débiles en URLs, la clave de ejemplo de RFC 8032, pares Ed25519 que no corresponden, http/hosts locales, quórum no dual, finalidad por profundidad y proveedores RPC iguales fuera de local; errores sin valores; secretos envueltos en `Secret` (no se serializan). P08.T03: migración `0001_initial_schema` con las 26 tablas de [B-DB], dominios `eth_address`/`bytes32`/`uint256`/`ecdsa_signature`, las 35 FKs de [B-DB-FK] con ON DELETE RESTRICT, índices únicos parciales, CHECKs (p. ej. OPERATIONS sólo por OPAQUE y vida máxima de 15 min de la PlatformSession), triggers append-only de `audit_events` y `operator_actions` y `updated_at`; política de GRANTs convergente (`grants.ts`): `mtw_app` DML y sólo SELECT/INSERT en las append-only, `mtw_readonly` sin hashes ni secretos cifrados, tablas del migrador en `mtw_meta` de sólo lectura; rol `mtw_readonly` (NOLOGIN) agregado a `init-db.sh` y aplicado a la base local existente. CLI `db:migrate`, `db:status [--check]`, `db:backup` y `db:restore` (lógico dentro del contenedor; staging/producción: pgBackRest). Probado sobre PostgreSQL 18.6 real con el mismo init: UPDATE/DELETE/TRUNCATE de `audit_events` fallan para `mtw_app` (GRANT) y para su dueño (trigger), el índice parcial impide dos operaciones activas con el mismo nonce y `wallet_keys_metadata` impide claves duplicadas; backup/restore conserva datos, trigger y permisos. P08.T04: `withTransaction` (SERIALIZABLE por defecto, reintento ante 40001/40P01 con backoff) probado con un write skew real (40001), un deadlock (40P01), agotamiento de reintentos y errores que no se reintentan; repositorios de outbox e idempotencia. P08.T05: `RpcQuorumClient` con health checks (chainId, head, latencia, atraso), lecturas sensibles en el bloque común y comparación, `RPC_DISAGREEMENT`/`RPC_TIMEOUT`/`RPC_UNAVAILABLE`, escrituras a ambos y receipts con quórum; métricas por proveedor; probado con dos Anvil del mismo fork y el proxy de inyección de fallas (timeout, respuesta divergente, chainId incorrecto, head atrasado, error HTTP, recuperación). P08.T06: SafeTx/EIP-712, firmas ECDSA estrictas (65 bytes, low-s, v ∈ {27, 28}), typed data de plataforma [W-01], `CancelRotation`, dirección CREATE2 y decoder tipificado de la llamada interna (sólo CALL sin ETH, destinos y selectores del sistema, calldata canónica), validados contra copias byte a byte de `contracts/test/vectors` (`SHA256SUMS`) y ABIs generados desde `out-abi` (75 tests); el test y un paso de `ci-backend.sh` verifican la igualdad con la fuente. P08.T07: logger pino con redacción en profundidad, IP truncada, email enmascarado y limpieza de credenciales en strings; canarios en logs directos, requests reales (headers y body) y errores; métricas prom-client en un puerto interno; `/health`, `/health/live` y `/health/ready` (base, migraciones, Valkey, RPC). P08.T08: dos listeners Fastify (8080/8081) con `client` del listener, helmet, CORS estricto por listener (otro Origin → 403 también en el preflight), sólo JSON, límite de body, errores RFC 9457 y requestId del servidor. P08.T09: OpenAPI 3.1 desde Zod, una spec por listener, Swagger UI con "Try it out" sólo fuera de producción y sin barra "Explore"; ninguna ruta puede registrarse sin `operationId`, `tags`, `summary`, 2xx y errores documentados. P08.T10: `Idempotency-Key` (24 h, hash JCS del request, repetición con `Idempotent-Replayed`, 422 con otro body o URL, 409 en curso, 4xx guardados, 5xx que liberan la clave). P08.T11: rate limiting en Valkey: global por IP y listener y las nueve políticas de [B-RL] con buckets por IP, email, usuario, sesión, Safe, propuesta o tipo de challenge (claves hasheadas, compartidas entre réplicas y entre listeners, nunca entre políticas, fail-closed). P08.T12: audit writer con cadena HMAC y `pnpm audit:verify` (detecta manipulación directa aun como superusuario); outbox dispatcher con BullMQ, consumidor con confirmación y re-encolado desde Postgres tras un FLUSHDB de Valkey. P08.TST: `pnpm test` con 21 archivos y 245 tests (PostgreSQL 18.6 y Valkey 9.2 reales por Testcontainers, Anvil sobre el fork, entrypoints `api` y `worker` como procesos reales); cobertura 96,75 % de líneas (`src/chain/` 97,6 %, umbral de §10 90 %, también configurado para `domain/` y `policy/`). P08.MAN (2026-10-17, agente): base local migrada y `node src/main.ts api` contra compose + fork: `/health/ready` listo (head del fork 52706212); `/docs` de :8080 y :8081 renderizado en Chromium headless: "MTW API — Wallet" y "MTW API — Recovery", cada uno con su servidor y sus tres operaciones de health (en P08 son las únicas rutas; el aislamiento por listener lo prueba `openapi-coverage.test.ts` con una ruta sólo de Wallet). La revisión visual llevó a dos ajustes: descripción con `api.<WALLET_DOMAIN>` (el texto entre `<>` se tomaba como HTML) y layout sin barra "Explore". P08.SEC: `pnpm test:security` (6 archivos, 43 tests) y `ci-security.sh` (gitleaks sin hallazgos; OSV-Scanner sin hallazgos en los 474 paquetes del backend; `pnpm audit --prod` sin vulnerabilidades; Semgrep sin hallazgos tras reemplazar `Math.random` del jitter por `crypto.randomInt`; zizmor). Defectos encontrados por los tests y corregidos: redacción de URLs con usuario vacío y de claves versionadas; BullMQ esperaba sin límite con Valkey caído y el dispatcher retenía su transacción hasta el idle timeout (timeout de publicación y corte del lote); carrera entre la confirmación del consumidor y el commit del dispatcher; snapshot previo al lock en escritores de auditoría SERIALIZABLE concurrentes; el 503 de readiness no aceptaba un Problem; parser `text/plain` por defecto de Fastify. Cambios respecto del planner: (a) `jobId = <aggregateId>-<outboxEventId>` en vez de sólo el id del agregado ([B-Q-01]): deduplica la republicación del mismo evento sin descartar un evento nuevo del mismo agregado mientras su job anterior sigue activo (con el id solo se perdía, por ejemplo, un reintento encolado durante el procesamiento); la serialización por Safe la da el lease de [B-NONCE-04]; (b) columna `outbox_events.processed_at` (confirmación del consumidor) para re-encolar lo publicado y no procesado tras perder Valkey; (c) `token_transfers` único por (chain_id, tx_hash, log_index, safe_address): un mismo Transfer entre dos Safes de la plataforma genera dos filas; (d) tabla `audit_chain_lock` y opción `auditLock` de `withTransaction`: en REPEATABLE READ/SERIALIZABLE el advisory lock de [B-AUD] no alcanza porque el snapshot se toma antes de esperarlo; (e) `audit_events` sin FKs (registra intentos sobre entidades inexistentes y su verificación sólo lee esa tabla); (f) valores que [B-DB] no fijaba: estados de `operation_groups` (OPEN/COMPLETED/FAILED/CANCELLED) y su `wallet_id`, `integrity_status.id`, `operator_actions` con los dos aprobadores en la misma fila; (g) doce versiones de §3.6 publicadas hace menos de 7 días se fijaron en la última versión de su línea con 7 días (`docs/VERSIONS.md`); (h) `type` de RFC 9457 = `urn:mtw:problem:<código>`; (i) métricas del worker en `WORKER_METRICS_PORT` (9465). |
| 2026-10-17 | P09 — Backend II: cuenta, autenticación y email | Completado | `c135d77` `feat(backend): add transactional email provider`, `1f9824b` `feat(auth): add account and session management` | CI de GitHub en verde en los 7 workflows (`wallet-backend` corrió también los tests live: el cambio toca email/autenticación). P09.T01: registro y verificación de email por la API (`POST /auth/register`, `/auth/verify-email`, `/auth/verify-email/resend`); email normalizado (NFKC, minúsculas) y único por plataforma; password de 12 a 128 puntos de código tras NFKC, sin la parte local del email y fuera de la lista NCSC 100k de SecLists vendorizada con commit y SHA-256 fijados (`data/common-passwords`, verificada al cargarla); Argon2id m=64 MiB, t=3, p=1 sobre base64(HMAC-SHA256(PASSWORD_PEPPER_vN, password)) con `pepper_version` y rehash al rotar; OTP de 8 dígitos (CSPRNG) guardado como HMAC(OTP_HMAC_KEY, challengeId:código), comparación en tiempo constante, TTL 15 min, 5 intentos, un solo uso, un código vigente por tipo; verificar el email desbloquea una cuenta bloqueada (el OTP es el factor de desbloqueo) y nunca abre sesión en una deshabilitada. P09.T02: login con respuesta y tiempo uniformes (Argon2id dummy para emails inexistentes), sesión nueva en cada login con revocación de la anterior (`rotated_from_id`), cookie `__Host-mtw_sid`/`__Host-mtr_sid` firmada, sólo `sha256(token)` en la base, inactividad de 30 min deslizante (a lo sumo una escritura por minuto) y absoluta de 12 h, sesión atada a su listener, logout que revoca la sesión y sus PlatformSessions, `GET /sessions` con dispositivo, IP truncada y última actividad, `DELETE /sessions/:id` (404 si es de otro usuario) y `DELETE /sessions`, `GET/PATCH /users/me` (locale y zona horaria de los emails). P09.T03: CSRF HMAC(CSRF_SECRET, sessionId) por `GET /auth/csrf` y exigido con Origin exacto y JSON en todo método no seguro (preValidation: 401/403 antes que 400); toda ruta declara `config.auth` y documenta 401/403/415 o el servidor no arranca. P09.T04: `POST /auth/forgot-password` (link al frontend del listener con el token de 256 bits en el fragmento, TTL 30 min, un solo uso, invalidado por un pedido nuevo) y `POST /auth/reset-password` (revoca todas las sesiones y PlatformSessions, desbloquea, avisa por email); test explícito: `opaque_records`, `wallet_keys_metadata`, `recovery_metadata`, `wallets` y `totp_factors` quedan idénticos. P09.T05: `src/auth/risk.ts`: contadores por cuenta y por IP en Valkey (15 min), espera exponencial desde el 5.º fallo (1 s… 15 min), bloqueo blando al 10.º con desbloqueo por OTP del email (`POST /auth/unlock/request` y `/auth/unlock`), señales de credential stuffing FAILURE_SPIKE (`AUTH_FAILURE_SPIKE_PER_MINUTE`) e IP_MANY_ACCOUNTS (métrica `mtw_auth_risk_signals_total`, log y auditoría `AUTH_RISK_SIGNAL`), una vez por ventana. P09.T06: TOTP RFC 6238 (`otpauth`, SHA-1, 6 dígitos, 30 s, ±1 paso), secreto de 160 bits sellado con AES-256-GCM (AAD `totp:<userId>`), anti-replay por `last_used_step`, 10 códigos de recuperación `XXXXX-XXXXX` (Argon2id m=19 MiB, t=2) de un solo uso, obligatorio en el login (`totp` o `recoveryCode`), setup/enable/disable con rotación de sesión y aviso por email. P09.T07: `EmailProvider` con adaptadores `mailgun` (fetch + Basic, Events API) y `smtp` (nodemailer → Mailpit); envío por el outbox en la misma transacción con los parámetros sellados (AAD `email:<referencia>`), `Message-ID = <referencia@dominio>` y `X-MTW-Ref`; 19 plantillas (las de [B-MAIL-02/03] y las de cuenta) con acción, dirección completa EIP-55 en grupos de 4, red, Safe, expiración en hora local y UTC, origen y qué hacer si no fue el usuario, sin links de acción salvo el de reset; snapshots de las 19. P09.TST: `pnpm test` con 36 archivos y 458 tests contra PostgreSQL 18.6, Valkey 9.2 y Mailpit reales (Testcontainers) y Anvil sobre el fork; los flujos de cuenta leen los códigos del pipeline de email real (outbox → BullMQ → worker → SMTP de Mailpit); cobertura 96,49 % de líneas (`src/auth/` 99,5 %, `src/chain/` 97,6 %). TST.a–f en `test/security/{auth-login,sessions,csrf,otp-reset,bruteforce-totp,cookies}.test.ts` (la fuerza bruta corre con las esperas reales, sin adelantar relojes). TST.g (`mailgun.live.test.ts`): las 19 plantillas por la API real de Mailgun (sandbox) a `EMAIL_TEST_ADDRESS` con evento `delivered` confirmado en la Events API, más rechazos reales no reintentables (API key inválida → 401, destinatario no autorizado → 403). TST.h (`real-delivery.live.test.ts`): registro, reset y desbloqueo de punta a punta con la API real, el worker real por Mailgun (remitente `no-reply@<EMAIL_PROVIDER_DOMAIN>`) y lectura de cada código o link con la Gmail API (`rfc822msgid:` del envío, `includeSpamTrash=true`); ningún código, token, contraseña ni credencial en los logs. P09.MAN (2026-10-17, agente): API y worker locales contra compose (Mailpit en `localhost:8025`): registro, verificación, perfil, logout, login, sesiones, TOTP (activar y desactivar con código de recuperación), olvido y reset, bloqueo real con 10 fallos y desbloqueo, intento de registro con email existente: 9 emails revisados en texto y en HTML (Chromium headless). La revisión llevó a: mayúscula tras punto en "Si no fuiste vos", doble ":" en el desbloqueo, pie distinto para emails con código o con link, una sola fila de hora cuando la zona del usuario es UTC, y el registro acepta `locale` y `timeZone` del navegador para que el primer email ya salga en hora local. P09.SEC: `pnpm test:security` (12 archivos, 97 tests) y `ci-security.sh` (gitleaks sin hallazgos, OSV-Scanner sin hallazgos en 474 paquetes, `pnpm audit --prod` sin vulnerabilidades, Semgrep y zizmor sin hallazgos). Defectos encontrados por los tests y corregidos: `verify` de @node-rs/argon2 sólo acepta entradas UTF-8 válidas (con el HMAC en bytes crudos ningún hash verificaba: ahora va en base64); caché de la lista de passwords comunes que ignoraba el largo mínimo pedido; errores SMTP 5xx tratados como reintentables; timeouts al leer el cuerpo de Mailgun que escapaban sin clasificar; zonas horarias válidas rechazadas (los navegadores informan alias distintos); TOTP incorrecto al activar o desactivar devolvía 401 (el frontend cerraría la sesión); ventana de reintentos de `withTransaction` demasiado corta bajo carga (6 intentos, jitter hasta 1 s). Cambios respecto del planner: (a) endpoints adicionales `POST /auth/verify-email/resend`, `POST /auth/unlock/request` y `POST /auth/unlock` (el desbloqueo por OTP de [B-AUTH-08] necesita su par pedido/confirmación) y `GET/PATCH /users/me`; (b) `verify-email` abre la sesión: probar el control del email equivale a iniciarla; (c) registro sin enumeración: un email ya verificado recibe la plantilla nueva `registration-attempt` y no cambia; uno sin verificar toma la última contraseña registrada y cierra sesiones previas; (d) migración `0002_account_preferences` (`users.locale`, `time_zone` y `last_failed_login_at`) para la hora local de [B-MAIL-02]; (e) TOTP en el mismo `POST /auth/login` (campos `totp` o `recoveryCode`; sin ellos 401 `TOTP_REQUIRED`); (f) antes de iniciar sesión el token CSRF se ata a un id anónimo en la cookie `__Host-mtw_csrf`/`__Host-mtr_csrf` (el spec sólo define el atado a la sesión) y un DELETE sin cuerpo no exige `Content-Type`; (g) contador por IP con la misma espera exponencial y la re-autenticación al desactivar TOTP en el mismo presupuesto (403 `REAUTH_FAILED`, no 401); variable nueva `AUTH_FAILURE_SPIKE_PER_MINUTE`; (h) plantillas en un módulo `src/email/templates.ts` en vez de `templates/*`; (i) cola `email` con 8 intentos y espera desde 5 s (≈ 10,5 min, dentro del TTL de los códigos), rechazos definitivos sin reintento y códigos vencidos que no se envían (`mtw_emails_skipped_total`); (j) toda ruta idempotente exige usuario autenticado al registrarse; (k) tests contra Mailgun y Gmail en el proyecto `live` (`pnpm test:live`): por la cuota del sandbox, CI los corre cuando el cambio toca email/autenticación, a diario y a pedido (`docs/CI.md`); (l) el sandbox de Mailgun firma DKIM/SPF como `sandbox.mgsend.net` con un From `@sandbox….mailgun.org`: DMARC no alinea y Gmail rechaza ~30 % con 550 5.7.40; los tests reenvían sólo ante ese rechazo (hasta 8 envíos) y en TST.h, tras un rechazo confirmado, liberan el bucket de [B-RL] del Valkey propio del test (equivale a que pase la ventana; los rate limits se prueban de verdad en `bruteforce-totp`); con el dominio propio de staging/producción no ocurre; (m) la verificación adicional de P09.T07 ("token de servidor de staging") se hizo con la API key real del sandbox: no hay servidor de staging en esta ejecución; (n) Mailpit de test sólo acepta destinatarios `test.invalid` (rechazo 550 real para los tests de error definitivo) y Valkey de test con 64 bases (una por archivo). |
| 2026-10-17 | P10 — Backend III: PlatformSession | Completado | commit `feat(auth): add opaque-based platform sessions and signed critical requests` | P10.T01: `pnpm opaque:setup` (sólo `APP_ENV=local`) genera `OPAQUE_SERVER_SETUP` en `wallet/.env` sin imprimirlo, conserva comentario y permisos y nunca reemplaza un valor existente (invalidaría los registros); probado como proceso real; PF-29 en verde (`PREFLIGHT PASSED`); la configuración lo exige (128 bytes en base64url, deserializado al arrancar) y en staging/producción sólo por `_FILE`. P10.T02: registro OPAQUE (`@serenity-kit/opaque`, RFC 9807) ligado a (wallet, key_version) con el identificador `mtw:<plataforma>:<walletId>:<versión>`, keyStretching `argon2id-custom` 16 MiB/1/1 fijo y versionado en `opaque_records`; PENDING hasta confirmar U on-chain, ACTIVE después (el ACTIVE anterior pasa a RETIRED; un PENDING repetido reemplaza al anterior). P10.T03: `POST /platform-sessions/opaque/start|finish` (sólo listener de Wallet): estado del servidor en Valkey 60 s, un solo uso (GETDEL), binding `HMAC(clave de sesión OPAQUE, thumbprint ‖ loginAttemptId)` → PlatformSession OPERATIONS de 15 min con su fila, auditada; Password U incorrecta, binding ajeno, intento reusado, vencido (probado con espera real) o de otra sesión de cuenta: 403 `REAUTH_FAILED` uniforme. P10.T04: `POST /platform-sessions/step-up/start|finish`: código por email (plantilla `step-up-code`, TTL 10 min, 5 intentos) atado a la sesión de cuenta, al scope y a la session key; TOTP o código de recuperación si está activo; ONBOARDING sólo sin wallet ACTIVE (atada a la wallet en curso), U_REPLACEMENT y RECOVERY con la wallet ACTIVE, ENROLLMENT con una wallet viva; cada scope en su listener; nunca OPERATIONS; rota la sesión de cuenta. P10.T05: token JWS EdDSA con `jose` (header y payload JCS, `kid` = thumbprint RFC 7638 de la clave del emisor, audiencia `mtw-api`/`mtw-signer`) que reproduce byte a byte el vector `jws.json`; plugin Fastify (`config.platformSession`: scopes y crítica) en preValidation que valida token, fila no revocada ni vencida, coincidencia claims/fila y sesión de cuenta padre; `DELETE /platform-sessions/{id}`. P10.T06: requests críticos con `X-Session-Signature` P-256 IEEE P1363 sobre `MTW-REQ-V1` (ruta con query y bytes exactos del cuerpo), `X-Session-Timestamp` ±60 s y `X-Session-Nonce` único por sesión 5 min (Valkey `SET NX`; una firma inválida no consume el nonce); envelope `MTW-SUBMIT-V1` (validez al momento del envío y antigüedad ≤ 24 h) como librería para el worker. P10.T07: `pnpm dev:session` (sólo local; con otro `APP_ENV` se niega antes de cargar la configuración): crea el usuario de desarrollo atado a la Safe del seed local con AuthSecret_U = HKDF(Argon2id(Password U)) (verificado contra el vector `envelope.json`), inicia sesión, desbloquea por OPAQUE contra la API local y firma un request; deja contraseñas, session key y headers en `wallet/.secrets/` (0600) y no imprime valores salvo con `--print`. P10.TST: 8 archivos nuevos (vectores, registro, login, step-up, token y scopes, firma de requests, `opaque:setup`, P10.SEC); `pnpm test` con 44 archivos y 513 tests en verde (PostgreSQL, Valkey y Mailpit reales; dos corridas); cobertura 96,49 % de líneas. P10.MAN (2026-10-17, agente): API local contra compose; `dev:session` creó el usuario de desarrollo (Safe del seed `0x8319…F872`) y emitió el material; Swagger UI de `:8080/docs` en Chromium headless por CDP: "Authorize" con `platformSession`, `sessionSignature` y `csrfToken`, campos `X-Session-Timestamp`/`X-Session-Nonce` y "Try it out" de `POST /platform-sessions/check` → 200 (OPERATIONS, OPAQUE_U); la misma firma otra vez → 403 `REQUEST_REPLAYED`; una firma nueva → 200; los headers se leyeron del archivo sin imprimirse. Observación: Swagger necesita que los campos se carguen antes de ejecutar (el primer intento automatizado salió sin aplicar los valores y dio 403 sin quemar el nonce). P10.SEC: `test/security/platform-session.test.ts`: registro y desbloqueo registrando cada byte enviado; ni la Password U ni AuthSecret_U (hex, base64, base64url) aparecen en los requests, los logs, la base (`opaque_records`, `platform_sessions`, `audit_events`) ni Valkey; `OPAQUE_SERVER_SETUP` sólo por `_FILE` en staging/producción y nunca serializado. Cambios respecto del planner: (a) claim `walletId` (nullable) en el token además de `safe`: una sesión de onboarding todavía no tiene Safe y [B-AUTHZ] la ata a la wallet; los vectores `jws.json` y `p256.json` pasan a usar UUID en `sessionId`/`accountSessionId` (el formato real); (b) headers `X-Session-Timestamp` y `X-Session-Nonce` (el spec sólo nombra el string firmado) y ruta firmada = URL con query; (c) formato del binding y del envelope de envío definidos y con vectores nuevos (`session-binding.json`, `p256.json#submissionEnvelope`) generados por `contracts/script/wire-vectors.mjs`; (d) endpoint adicional `POST /platform-sessions/check` (ruta crítica sin efectos para probar la session key; la usa P10.MAN); (e) política de [B-RL] adicional `opaque-login` (5/min por sesión, 20/h por usuario): cada inicio OPAQUE es un intento de Password U; (f) fallas de la capa PlatformSession como 403 con código propio (`PLATFORM_SESSION_REQUIRED/INVALID`, `SCOPE_NOT_ALLOWED`, `REQUEST_SIGNATURE_INVALID`, `REQUEST_EXPIRED`, `REQUEST_REPLAYED`) y 409 `WALLET_NOT_ACTIVE`, sin 401 con la sesión de cuenta vigente; (g) `KEY_RESTORE` (prueba de posesión EIP-712 contra el rol U on-chain) se emite junto con su ruta `user-key/restore` en P12.T01.b (agregada), donde existen Safes desplegadas; (h) `dev:session` escribe el material en `wallet/.secrets/` en lugar de imprimirlo; (i) challenge `STEP_UP` con TTL de 10 min; (j) la verificación del segundo factor pasa a `src/auth/second-factor.ts` (login, desactivación de TOTP y step-up); (k) en staging/producción `OPAQUE_SERVER_SETUP` lo genera `scripts/deploy/init-secrets.sh` (P26.T09); el CLI sólo sirve en local. |
| 2026-10-17 | CI de P10 (GitHub) | Completado; tests live pendientes de re-ejecución | `85651b8`; `8f6ae45` `fix(backend): pace live email tests to the mailgun sandbox quota` | En el push de P10 quedaron en verde todos los workflows salvo `wallet-backend`: la suite normal pasó (44 archivos), pero los dos archivos live fallaron con 429 de Mailgun. El dominio sandbox admite **100 pedidos por día** en ventana móvil de 24 h (no ~300 como decía `ci-backend.sh`) y una corrida live completa usa ~40 envíos (19 plantillas, los reenvíos por el rechazo DMARC del sandbox y los 3 flujos de entrega real); P09 y P10 los corrieron el mismo día y agotaron la cuota. Corrección: `parseRetryAfter` lee `Retry-After` y el "try again after <fecha>" del cuerpo (`EmailSendError.retryAfter`, también en el log del worker); los tests live envían con la política de reintentos del worker (8 intentos, backoff exponencial desde 5 s), corren archivo por archivo y, si Mailgun informa una fecha posterior a esa ventana, fallan en el acto con `MailgunQuotaExhaustedError` y la fecha; CI los corre sólo cuando cambia el envío de email o los propios tests live, a diario y a pedido (los flujos de autenticación siguen cubiertos con Mailpit en la suite normal). Los tests live **no se dan por aprobados**: se vuelven a correr cuando se libere la cuota y el resultado se registra en una fila propia. |
| 2026-10-17 | P11 — Signer S | Completado | `2b80760` `chore(tooling): pin age for encrypted signer backups`, `1aab2f4` `fix(backend): redact error messages logged as the first argument`, `193ecb6` `feat(signer): add self-hosted signer service with encrypted keystores`, commit `feat(signer): add signed policy snapshots and gas tank` | Proyecto independiente `backend/signer` (sin código compartido con el backend; mismas versiones y política de supply chain, `docs/VERSIONS.md`). P11.T01: `DevelopmentSignerProvider` = `SelfHostedSoftwareSignerProvider` con guardas: se niega a arrancar con `APP_ENV` distinto de `local` o si el RPC no devuelve `anvil_nodeInfo.forkConfig` (9 tests). P11.T02: HTTPS con mTLS obligatorio (TLS 1.3, cliente `mtw-backend` por CN o SAN DNS) y rutas `POST /v1/keys`, `POST /v1/sign-safe-tx`, `POST /v1/keys/retire`, `POST /v1/sign-platform-tx` y `GET /v1/health`, con errores `{code, reason?, retryable}` y spec OpenAPI interna generada desde los schemas (`openapi.json`, nunca publicada); cliente mTLS del backend en `src/signer-client` (8 tests: sin certificado, otra CA, CN no permitido y TLS 1.2 rechazados). P11.T03: policy independiente con los pasos 2–8 y 7b de [B-Q-02] (`sign-safe-tx` 21 tests, `sign-operations` 11 tests con cada operación por rol contra el sistema desplegado en el fork) y vectores compartidos de policy: 111 casos generados por `contracts/script/policy-vectors.mjs` y copiados byte a byte al signer y al backend (la policy del backend los usa en P13.TST.j). P11.T04: snapshot firmado (Ed25519 sobre los bytes exactos) con anti-rollback en la DB del shard; `policy:build`, `policy:sign` y `policy:verify` verificados sobre el snapshot local; el backend lo verifica igual (`src/policy/snapshot.ts`). P11.T05: reglas estáticas antes de cualquier E/S, SR-01..SR-14 (SafeTx y tx de S) y GT-01..GT-06 (cuenta gas tank), con 77 casos de rechazo. P11.T06: keystores V3 (scrypt N=2^14 r=8 p=1, AES-128-CTR, MAC keccak), contraseña = HKDF-SHA256 de la credencial del shard por dirección, `credentialFingerprint` HMAC, escritura atómica 0400; interoperabilidad: `cast wallet decrypt-keystore` descifra los keystores generados y el signer descifra los de `cast wallet import`, más el vector oficial V3 de scrypt (7 tests; `selfhosted` 8 tests: keystore faltante o corrupto → `BROKEN`, restart con otra credencial, permisos). P11.T07: interfaz de HSM y adaptador de firmas (low-s, `v` por recuperación) en `HardwareSignerProvider`, suite de contrato común contra Development y SelfHosted (9 tests), runbook `docs/runbooks/signer-hardware-migration.md`; la evaluación de Clef y Web3Signer ya estaba en ADR-014. P11.T08: `assignShard` = SHA-256("mtw-signer-shard-v1:" + walletId) mod N sobre los shards activos ordenados, guardado en `signer_keys` con la atestación (migración 0003); `sharding` 7 tests con dos shards reales y `multi-shard` 3 tests. P11.T09: proceso `gas-tank` del backend con la cuenta del shard `platform`: recargas mín./objetivo con tope diario propio y tope del snapshot en el signer, deploy de Safes sólo con una S atestada, retransmisión de cancelaciones (simuladas antes de firmar) y métricas de saldos (7 tests contra el fork). P11.T10: procedimientos como CLIs reales con runbook `docs/runbooks/signer-lifecycle.md` (9 tests): alta de shard, backup `age` sin la credencial, restore + `restore-verify`, keystore corrupto o faltante (`BROKEN` + restore), rotación de la credencial, custodia en dos copias `age` para custodios distintos, migración en dos fases (`shard:migrate` + `signer:reassign`) y destrucción de claves retiradas. P11.T11: `SignerKeyAttestation` Ed25519 en `POST /v1/keys` y `attestation:public-key` (3 tests). P11.TST: signer 21 archivos y 337 tests (cobertura de líneas: `src/chain` 98,75 %, `src/policy` 93,63 %; el quórum `dual` se prueba con dos Anvil reales y el proxy de fallas); backend 48 archivos y 535 tests (cobertura de líneas: total 95,06 %, `src/chain` 97,77 %, `src/policy` 100 %; la primera corrida de `ci:local` marcó `src/policy` en 75 % porque el loader del snapshot sólo se probaba por el camino feliz: `test/policy/snapshot.test.ts` cubre sus rechazos y el loader responde `PolicySnapshotError` también ante un archivo firmado que no es JSON; además, los tests de migraciones esperaban sólo 0001 y 0002 y ahora cubren la 0003). P11.SEC: `test:security` (S nunca en DB, `.env`, logs ni respuestas; redacción; transporte) y `ci-security.sh` → SECURITY SCANS OK. P11.MAN (2026-10-17, agente): shards `dev-1` y `platform` reales contra el stack local (DBs migradas, cuenta gas tank creada, procesos levantados y ejercitados); en sus logs, 0 de 15 canarios (credenciales, contraseñas derivadas, claves privadas, contenido de keystores, tokens); tabla de reglas estáticas revisada línea por línea contra [B-SIG-06]; permisos: directorios de keystores 0700, keystores 0400, credencial 0600 fuera del directorio de keystores. Cambios respecto del planner: (a) el snapshot local no se versiona: sale del deploy local (depende de `LOCAL_SEED`) y se arma con `policy:build` (nuevo) antes de firmarlo; `config/policy/local/` en `.gitignore`; (b) rutas y CLIs adicionales: `POST /v1/keys/retire` (retiro de una S que ya no es executor on-chain), `POST /v1/sign-platform-tx` (gas tank), `shard:backup`, `shard:restore`, `shard:destroy-retired`, `credential:escrow`, `attestation:public-key`, `openapi`; (c) shard `platform` para la cuenta gas tank (local en el puerto 8091 con DB `mtw_signer_platform_dev`; `SIGNER_PLATFORM_*`) con reglas GT-xx: recarga sólo a la S vigente de una Safe registrada, deploy sólo con S atestada, cancelación simulada antes de firmar; (d) `DEPLOYMENT_TAG` en `DeployCore`: los tests del signer y del backend despliegan en su propio Anvil con un JSON por tag que se borra al leerlo; (e) migración 0003 del backend: `signer_keys.attestation` (nullable, expand) guarda la atestación de cada S; (f) `RotationKind` de los contratos empieza en 0 (U=0 … MODULE_GUARD=4) y `Role` en 1: el signer y los vectores siguen esos valores; (g) el quórum del signer compara valores normalizados (cantidades como número, datos en minúsculas, bloque por hash y timestamp) en lugar del JSON crudo; (h) `age` 1.3.2 en la toolchain (PF-07) para los backups; (i) PF-27 por shard con el fingerprint HMAC correcto (antes un SHA-256 truncado), PF-18 crea la DB del shard `platform` en volúmenes previos a P11 y `secrets:local` agrega a `wallet/.env` las variables nuevas de `.env.example`; (j) logger del backend: un `Error` como primer argumento salía sin redactar (corregido con canario; el signer nace con la corrección); (k) Anvil de los tests con más reintentos y tope de unidades de cómputo por instancia (429 del RPC remoto con varios forks en paralelo). Observación de seguridad: durante la sesión, un `ps` mostró la URL del RPC primario con su API key en los argumentos de Anvil (salida local de la terminal; no se commiteó ni se registró en ningún archivo); conviene rotar esa key antes del despliegue final. |
| 2026-10-17 | CHECKPOINT P11 (local) | Completado | commit `feat(signer): add signed policy snapshots and gas tank` | `pnpm --dir backend/signer build` y `pnpm --dir backend/app build` OK; tests del signer y del backend (fila anterior); `test:security` del signer y `ci-security.sh` OK; `pnpm ci:local` en verde sobre el árbol limpio del commit (con `MTW_LIVE_TESTS=0`: la cuota de Mailgun sigue agotada; contratos en los dos modos de policy, Slither y deploy efímero, backend, signer, docs y security); `node scripts/check-docs.mjs` → DOCS OK; gitleaks sin hallazgos (historia completa y cada commit) y ningún `.env` ni `.secrets/` versionado; cada commit intermedio compila, pasa lint y los tests de CI por separado. La CI de GitHub del push se registra en la fila siguiente. |
| 2026-10-18 | CI de P11 (GitHub) | Completado; tests live pendientes de re-ejecución | `372ae50`; `4caa1bf` `test(signer): allow slow fork reads in the signer test harness` | Push de P11 (`372ae50`): en verde wallet-security, wallet-contracts, wallet-repro-build y los dos frontends. wallet-backend pasó la suite normal (48 archivos, 535 tests) y fallaron sólo los tests live por la cuota de Mailgun: `MailgunQuotaExhaustedError` con la fecha que informa Mailgun (el dominio acepta envíos desde 2026-10-18T06:18:23Z); el diseño de P10 funcionó (falla inmediata con la fecha, sin quemar reintentos). wallet-signer falló en un test (`approve + swap` contra el pool real de Uniswap: `RPC_UNAVAILABLE`) porque en CI varios forks traen estado del RPC remoto con límite de ritmo y una lectura en frío superó el timeout de 5 s del cliente RPC del signer: el harness de tests corre el signer con 30 s (producción sigue en 5 s). Con `4caa1bf`: wallet-signer, wallet-backend y wallet-security en verde. Los tests live se re-ejecutan cuando se libera la cuota y su resultado se registra en una fila propia. |
| 2026-10-18 | P12 — Backend IV: creación de wallet | Completado | `e439a5d` `test(backend): deploy the system once per test run`, `bf43bdc` `test(security): make timing checks robust to machine load`, `4cdb6a7` `feat(policy): pin system codehashes and the safe proxy creation code`, commit `feat(wallet): add deterministic safe deployment and recovery key enrollment` | P12.T01: `POST /wallets` (CREATING o la wallet en curso; Idempotency-Key) y registro de U en dos pasos — `user-key/opaque-registration` (respuesta OPAQUE, sin estado) y `user-key` — con dirección, KDF público ([F-KEY-03]) y backups confirmados (al menos uno que no dependa de la plataforma, [F-KEY-06]); registro OPAQUE PENDING atado a (wallet, versión 1); U reemplazable hasta la autorización y nunca una clave de otra wallet, de otro rol, una S ni una R viva. P12.T01.b: KEY_RESTORE como scope de step-up con prueba de posesión: nonce del challenge y firma EIP-712 `KeyRestore` de la U vigente on-chain (SecurityGuard.rolesOf por quórum) y ACTIVE en el backend, verificada antes de consumir el código; `user-key/restore` reemplaza el registro OPAQUE de la misma U, la sesión se revoca al usarse y el step-up usa el cupo sensible de [B-RL] (3 por día). P12.T02: enrollment con nonce de 32 bytes y 15 min; Enrollment Key P-256 una sola vez (ENROLLMENT, listener de Recovery); `RecoveryEnrollment` firmado sobre su JCS ([W-02]) y prueba de control EIP-712 de R; R EOA (sin código o con designador EIP-7702, leído por quórum), distinta de U y nunca usada; R externa con `connectorId`; un enrollment nuevo reemplaza a los anteriores. P12.T03: S creada por el shard asignado (POST /v1/keys por mTLS) con su `SignerKeyAttestation` verificable con la clave de atestación del signer, guardada en `signer_keys`; idempotente; signer caído → 503 sin estado parcial. P12.T04: `saltNonce = uint256(keccak256(abi.encode("MTW_SALT_V1", platformId, walletId)))`, initializer y CREATE2 locales con el creation code del proxy fijado (su keccak256 es el `proxyCreationCodeHash` de config/chains) == `WalletFactory.predictWalletAddress` por quórum; `config_hash` = keccak256 del initializer (igual al de `initializerFor`); vectores nuevos en create2.json (`saltNonces` y `proxyCreationCode`, generados en Solidity desde el fork). P12.T05: la WalletCreationAuthorization se acepta sólo si cada campo es el registrado (R del enrollment, S, salt, Safe esperada, nonce) y la firma EIP-712 estricta es de U → CONFIRMED. P12.T06: deploy asíncrono: `POST /wallets/{id}/deploy` → DEPLOYING + evento `WALLET_DEPLOY_REQUESTED` → cola `gas-tank` → `WalletDeployer` en el proceso gas-tank: `createWallet(U, R, S, salt)` por la cuenta gas tank (o registro sin tx si la Safe ya existe, p. ej. desplegada por un tercero) → VERIFYING. P12.T07: verificación V9 §16 en un bloque común por quórum contra las direcciones y codehashes del snapshot firmado (factory, proxy, singleton, owners, threshold, nonce, guard, module guard, fallback, módulos, roles y registro en el Guard, timelock, PolicyRegistry, bootstrap, chainId) → ACTIVE (claves y registro OPAQUE ACTIVE; recién ahí se fondea S) o FAILED con el ítem que falló y alerta (log de error, `mtw_wallet_verification_failures_total`, auditoría); nunca ACTIVE con una Safe que no verifica. P12.T08: `DeploymentInfo` de [B-API-SCH] (más `proxyFactory`, `configHash` y `failureReason`); la Safe operativa sólo aparece en `GET /wallets/me` con la wallet ACTIVE. P12.TST: backend 60 archivos y 577 tests (42 nuevos de P12; cobertura de líneas: total 94,89 %, `src/chain` 98,35 %, `src/policy` 100 %, `src/wallets` 91,24 %, `src/recovery` 92,72 %, `src/platform-session` 95,54 %); signer 21 archivos y 337 tests (cobertura de líneas: `src/chain` 98,75 %, `src/policy` 93,75 %). P12.SEC: `test/security/wallet-onboarding.test.ts`: ninguna ruta acepta initializer, destino o calldata, el evento de deploy lleva sólo el id y la tx de deploy es exactamente `createWallet(U, R, S, salt)` hacia la factory; IDOR en todas las rutas del onboarding (404 para recursos ajenos, también con la PlatformSession propia); ni el registro OPAQUE ni el AuthSecret aparecen en logs ni en la auditoría. P12.MAN (2026-10-18, agente): onboarding real hasta ACTIVE en el fork (test temporal, no versionado) e inspección con `cast` de la Safe `0x4D92Ce8d6618a7C16A172121C739064815F501bF`: `getOwners` = [U, R, S], `getThreshold` 2, `nonce` 0, slot del guard = SecurityGuard, slot del module guard = DenyAllModuleGuard, fallback handler 0, sin módulos, slot 0 = SafeL2 1.5.0, `SecurityGuard.rolesOf` = (U, R, S, inicializado, versión 1) e `isRegistered`, `WalletFactory.isWallet` y `verifyWallet` = (true, 0x0); S con 0,001 ETH (recarga inicial). Sin observaciones. Cambios respecto del planner: (a) el registro OPAQUE de U usa dos rutas (`user-key/opaque-registration` + `user-key`) porque OPAQUE es de dos mensajes; (b) ruta `POST /wallets/{id}/executor` para la asignación de S y la Safe esperada (P12.T03–T04 no nombraban una ruta); (c) nonce de enrollment de 32 bytes (≥ 128 bits; es el bytes32 de WalletCreationAuthorization y el formato del vector p256.json); (d) deploy asíncrono por outbox al proceso gas-tank (cola nueva `gas-tank`) y fondeo inicial de S después de ACTIVE: el signer sólo recarga la S vigente de una Safe registrada (regla GT de P11); (e) migración 0004 (expand): `wallets.expected_safe`, `failure_reason` y `deploy_requested_at`; nonce, backups, marcas de tiempo y CHECKs de completitud del enrollment; una inscripción viva por wallet y por R; (f) `codehashes` en el snapshot de policy firmado (schema del signer y del backend, `policy:build`, vectores de policy) para verificar por codehash los contratos críticos (V9 §16); (g) creation code del proxy de Safe fijado en el backend (verificado por test contra config/chains y el vector) para el cálculo local independiente de la factory; (h) una sesión ONBOARDING emitida antes de crear la wallet vale para esa wallet mientras está en CREATING, DEPLOYING o VERIFYING (con la wallet ACTIVE ya no); (i) códigos de error nuevos `SIGNATURE_INVALID` y `KEY_NOT_ALLOWED` (422) y `ENROLLMENT_EXPIRED` (409); (j) el global setup del backend pasa a nivel raíz (una infraestructura para los proyectos backend y security), despliega el sistema una vez por corrida (estado volcado, `--load-state` por archivo) y limita los workers a 4; (k) test del entrypoint `gas-tank` como proceso real; (l) dos tests de seguridad sensibles al tiempo (respuesta uniforme del login, espera exponencial de fuerza bruta) miden ahora pares intercalados y la espera restante acotada por la latencia: con los archivos de onboarding en paralelo fallaban por carga, sin debilitar lo que verifican; (m) P12 en cuatro commits (infraestructura de tests, robustez de los tests de tiempo, codehashes y creation code fijados, y la funcionalidad): el enrollment de R y el deploy van en un mismo commit, `feat(wallet): add deterministic safe deployment and recovery key enrollment`, en lugar de los dos nombres del planner, porque son pasos del mismo flujo y sus tests (onboarding por la API) recorren ambos. |
| 2026-10-18 | CHECKPOINT P12 (local) | Completado | `e439a5d` `test(backend): deploy the system once per test run`, `bf43bdc` `test(security): make timing checks robust to machine load`, `4cdb6a7` `feat(policy): pin system codehashes and the safe proxy creation code`, `ce34a63` `feat(wallet): add deterministic safe deployment and recovery key enrollment`, `e523637` `test(contracts): skip the vector check under forge coverage` | `pnpm --dir backend/app build` y `pnpm --dir backend/signer build` OK; backend 60 archivos y 577 tests (42 nuevos de P12; cobertura de líneas: total 94,89 %, `src/chain` 98,35 %, `src/policy` 100 %, `src/wallets` 91,24 %, `src/recovery` 92,72 %, `src/platform-session` 95,54 %) (incluye `test:security`); `ci-security.sh` OK; `pnpm ci:local` sobre el árbol limpio de `ce34a63` falló sólo en `contracts`: `Vectors.t.sol` (vectores de P12 comparados con el despliegue real) también corría bajo `forge coverage`, que compila sin optimizador y cambia los codehashes; `e523637` lo saltea en el contexto de cobertura (en `forge test` sigue verificando) y `pnpm ci:local` quedó en verde sobre el árbol limpio de `e523637` (con `MTW_LIVE_TESTS=0`: la cuota de Mailgun sigue agotada); `node scripts/check-docs.mjs` → DOCS OK; gitleaks sin hallazgos y ningún `.env` ni `.secrets/` versionado. La CI de GitHub del push se registra en la fila siguiente. |
| 2026-10-18 | CI de P12 (GitHub) | Completado; tests live pendientes de re-ejecución | `e523637` | Push `4caa1bf..e523637`: `wallet-backend` (60 archivos, todos verdes; los tests live no corrieron porque el cambio no toca el envío de email), `wallet-signer`, `wallet-security`, `wallet-frontend-wallet` y `wallet-frontend-recovery` en verde. `wallet-contracts` falló en la primera corrida por un 429 del RPC del fork en `vm.createSelectFork` (dos suites de fork, con los jobs de backend y signer forkeando la misma key en paralelo) y pasó al re-ejecutarlo; P13 agrega en `ci-contracts.sh` el re-run de sólo los tests fallidos cuando la corrida falla por un límite de ritmo del RPC del fork (`forge test --rerun`, hasta 3 veces con espera creciente; `forge coverage` se reintenta con el mismo criterio): el primer intento con `--fork-retries 12 --fork-retry-backoff 2000` rompía `forge test`, que sólo acepta esos flags junto con `--rpc-url` (forkearía todas las suites) y no tienen clave en `foundry.toml` (ver CHECKPOINT P13). Los tests live siguen pendientes de la cuota de Mailgun (ver la fila de CI de P10). |
| 2026-10-18 | P13 — Backend V: pipeline de operaciones | Completado | `fdeee22` `ci(contracts): retry rate-limited fork requests`, `119cc64` `test(security): compare path medians in the login timing check`, `7f31573` `feat(backend): add operation pipeline with nonce management and finality tracking`, `de8281b` `fix(ci): rerun failed contract tests after fork rate limits` | P13.T01: máquina de estados con transición única (`UPDATE … WHERE id AND status IN (…) [AND lease_version]`, evento `OPERATION_<ESTADO>` y outbox en la misma transacción) y tabla de transiciones probada exhaustivamente contra la base (las 225 combinaciones, conflictos por estado y por lease, atomicidad con outbox, una sola ganadora entre 10 transiciones concurrentes); constraint trigger diferido que rechaza al confirmar todo cambio de estado sin su evento de auditoría. P13.T02: nonce = menor libre ≥ el on-chain bajo `SELECT … FOR UPDATE` de la wallet (10 prepare concurrentes → consecutivos; una CREATED vencida o cancelada libera el suyo y la próxima lo ocupa); lease por Safe de 30 s con fencing (`exec_lease_version` → `lease_version`) y reclamo auditado (`OPERATION_RECLAIMED`); dos workers: con el lease vigente el segundo no procesa y, si el primero queda colgado con la firma de S pedida, el segundo retoma, firma y transmite y el primero aborta en su escritura con fencing (una sola tx de S y una sola ejecución). P13.T03: `POST /operations/{id}/signatures` (crítico e idempotente; en Wallet firma U con OPERATIONS y en Recovery R con RECOVERY): firma ECDSA estricta contra el rol vigente on-chain, envelope `MTW-SUBMIT-V1` (±60 s, firmado por la session key, dentro de la vigencia de la sesión), SafeTxHash recalculado desde la intención guardada, policy, 2FA y nonce no consumido → USER_SIGNED → QUEUED + `OPERATION_QUEUED`; `POST /operations/{id}/cancel`, `GET /operations/{id}` (historial desde la auditoría) y `GET /wallets/{id}/operations` (cursor). P13.T04: worker S con los 12 pasos (sesión y envelope al momento del envío con la firma de menos de 24 h, hash, firma, nonce, policy con ledger de 24 h y challenges, whitelist, 7b, `evaluateAssisted` + `eth_call` desde la Safe, firma de S en el signer, write-ahead de la tx firmada con fencing, transmisión a los dos RPC, receipt) contra el fork y el shard real (NoOp hasta FINALIZED, SEND real de USDC, tres operaciones de una Safe en una pasada), reintentos con backoff y jitter (signer caído → FAILED_RETRYABLE `SIGNER_UNAVAILABLE` → re-encolado por el scheduler → MINED) y consumo real de la cola por BullMQ. P13.T05: fees EIP-1559 acotados por el snapshot y reemplazo por fee bump ≥ 12,5 % con el mismo nonce de cuenta y la misma SafeTx (Anvil sin minado automático), la reemplazada queda REPLACED. P13.T06: watcher `depth`/`tags` (con `tags`, CONFIRMED bajo el head `safe` y FINALIZED bajo el `finalized`, heads mínimos entre proveedores y hash reconfirmado); reorgs reales con `anvil_reorg`: tx descartada → REORGED (`REORG_DETECTED`) → QUEUED → re-ejecución de la misma SafeTx → FINALIZED, y tx re-incluida → REORGED → MINED; sin transición ante RPC caído. P13.T07: indexer de eventos de SafeL2 (`safe_executions`: las de la plataforma ligadas a su operación, las soberanas auditadas `SAFE_SOVEREIGN_EXECUTION`) y `Transfer` de USDC/USDT con cursor por hash de bloque, finalidad y reorg (retrocede y re-escanea); reconciliación cada 60 s y completa diaria (configuración, nonce, ejecuciones indexadas, roles, whitelist, rotaciones del timelock y saldos contra el neto indexado) con cada discrepancia auditada una vez (`RECONCILIATION_DISCREPANCY`). P13.T08: cancelación por NoOp con CANCEL_REQUESTED: con la original encolada gana la NoOp; con la original en el mempool la NoOp reemplaza la tx en vuelo de S y gana (original CANCELLED `SUPERSEDED_BY_NOOP`, su tx REPLACED); si la original se mina primero, MINED y la NoOp FAILED_FINAL `CANCEL_TOO_LATE`. P13.T09: ADR-019 (sin batching, ya documentado) y test: dos Safes avanzan en paralelo y cada una en orden de nonce. P13.T10: policy del backend con el snapshot completo y anti-rollback en `policy_snapshots` al arrancar `api`, `worker` y `gas-tank` (que además exigen que el snapshot sea de su plataforma); 111/111 vectores compartidos. P13.T11: paso 7b en el envío de firma, en el worker y en la reconciliación (y en el signer, de P11): U+R retiran el Guard o ponen un fallback handler → SOVEREIGN_MODIFIED con los ítems, auditoría, notificación, email (plantilla nueva `safe-config-modified`) y alerta; el signer se niega por su cuenta (`SAFE_CONFIG_MODIFIED`). P13.TST: backend 81 archivos y 1009 tests (21 archivos nuevos de P13; cobertura de líneas: total 93,19 %, `src/chain` 97,16 %, `src/policy` 98,27 %, `src/operations` 92,5 %, `src/worker` 77,29 % —el resto lo ejercitan los tests del proceso `worker` real, que la cobertura de v8 no mide—); TST.a idempotencia; TST.b carrera de nonces; TST.c dos workers; TST.d desacuerdo y timeout de RPC con el proxy de fallas (sin transición hasta consistencia); TST.e simulación que revierte (nunca se transmite), revert minado determinístico (USDC con el destino bloqueado por el blacklister real → FAILED_FINAL + alerta) y transitorio (USDC pausado y reanudado por el pauser real → reintento → MINED) y tx descartada (nonce de S consumido por fuera → TX_DROPPED → re-firma → MINED); TST.f reorg; TST.g kill -9 del proceso `worker` validando, con la firma de S pedida, entre el registro y la transmisión (el nuevo retransmite la misma tx) y esperando el receipt, más reinicio ordenado; TST.h flush de Valkey (re-publicación sin pérdida ni duplicados); TST.i cancelación, sesión vencida, ejecución a +16 min (OK) y +25 h (`SIGNATURE_STALE`) y destino desautorizado antes del paso 7 (`WHITELIST_INACTIVE`); TST.j vectores; TST.k deriva de configuración. P13.SEC: `test/security/operations.test.ts`: la base rechaza un cambio de estado sin su evento; el historial auditado de cada operación es un camino válido de la máquina de estados; el backend no tiene claves secp256k1 ni código para firmar como S; un backend comprometido que salte la policy no obtiene la firma de S (el signer rechaza `POLICY_REJECTED` y la firma de U de otra SafeTx); una intención adulterada en la base termina `INTEGRITY_MISMATCH` sin pedirle nada al signer. P13.MAN (2026-10-18, agente): proceso `worker` real contra el fork con una operación nueva, raspando su `/metrics`: `mtw_wallet_operations{status}` pasó por QUEUED → READY → SUBMITTED → MINED → CONFIRMED → FINALIZED en ≈ 2 s, `mtw_operation_transitions_total` sumó VALIDATING, READY, SUBMITTED, MINED, CONFIRMED y FINALIZED (QUEUED la cuenta el proceso `api`), `mtw_executor_transactions_total` submitted, mined, confirmed y finalized, y `mtw_wallet_operations_stuck` en 0 (test temporal, no versionado). Sin observaciones. Cambios respecto del planner: (a) transiciones agregadas a §7.4: `QUEUED → FAILED_FINAL` (NoOp que perdió la carrera de [B-NONCE-06] y firmas de más de 24 h que esperan un nonce menor, [B-PSES-06]) y `REORGED → MINED` (la misma tx de S re-incluida en otro bloque: no se re-ejecuta lo que la cadena canónica ya contiene); (b) [B-NONCE-01]: el nonce es el menor libre ≥ el on-chain en lugar de `max(onchain, next_safe_nonce, max(activo)+1)`: con la fórmula literal un nonce liberado por vencimiento quedaba como hueco permanente y las operaciones de nonce mayor esperaban para siempre ([B-NONCE-02] pide que vuelva a estar disponible); sin huecos ambas coinciden; (c) [B-DB]: `UNIQUE(safe_tx_hash)` pasa a índice único parcial sobre las operaciones vivas (excluye EXPIRED, CANCELLED y FAILED_FINAL): la misma SafeTx debe poder volver a prepararse después de vencer; (d) migración 0005 (expand): vencimiento de las CREATED, `blocked_reason`, envelope completo (firma de la session key, token de la PlatformSession y atestación del challenge, que el signer vuelve a verificar; token y atestación fuera del alcance de `mtw_readonly`), `requires_two_factor`, `signed_at`, `cancels_operation_id`, deriva de configuración en `wallets`, `safe_executions`, `chain_cursors`, `updated_at` en `token_transfers`, índices y el constraint trigger de auditoría; (e) el signer exige el platformId del snapshot en las PlatformSessions: el backend valida al arrancar que el snapshot sea de su plataforma, y los tests usan la clave del emisor de sesiones y el platformId que fijan el snapshot y los shards; (f) una NoOp firmada no se cancela con otra (409) y una operación en VALIDATING responde `OPERATION_BUSY` (transitorio); (g) el envío de la firma no consume el cupo `operation-create` de [B-RL] (lo acota el prepare que creó la operación); (h) `POST /operations/{id}/two-factor` y las rutas de prepare de send, swap y whitelist quedan para P14 (el envío de firma ya exige el challenge completado y ligado a la operación); (i) el worker deja de esperar el receipt si la operación salió de SUBMITTED por otro camino (cancelación), lee el nonce de cuenta de S antes que los receipts y el watcher mira el mempool antes que los receipts (sin eso, un bloque minado entre las dos lecturas se confundía con un descarte: lo detectó el test de la carrera de la NoOp); (j) indexer: el rango de `eth_getLogs` se achica solo si el proveedor lo rechaza (plan con límite de rango; probado con el proxy de fallas) y el retroceso por reorg nunca baja del bloque de inicio (con el fork, debajo del bloque del fork Anvil reenvía las consultas al RPC remoto); (k) métricas nuevas (transiciones, errores clasificados, duración por paso, tx de S, reorgs, deriva, discrepancias, cabeza del indexer, operaciones atascadas) y configuración `WORKER_*`, `WATCHER_INTERVAL_MS`, `INDEXER_INTERVAL_MS`, `RECONCILER_INTERVAL_MS` (con defaults, en `.env.example`); (l) el test de tiempo uniforme del login compara las medianas de los dos caminos (16 pares intercalados) en lugar de la mediana de las diferencias por par, que mide dispersión y no sesgo: con los archivos de P13 en paralelo superaba el umbral sin que hubiera oráculo; el piso de 20 ms (el email inexistente paga el Argon2id completo) se mantiene; (m) concurrencia y resiliencia (14 archivos, 282 tests: carreras de nonce, dos workers, paralelismo, idempotencia, reorgs, fallas de RPC, crash/restart, flush de Valkey, finalidad) en 3 corridas consecutivas en verde; el helper de tests inserta la PlatformSession con el mismo instante base para `issued_at` y `expires_at` (antes un desfase de 1 ms violaba `platform_sessions_lifetime` de forma intermitente); el escenario de reinicio ordenado (SIGTERM) de `crash-restart` falló 2 veces sin causa visible (el worker nuevo no dejaba logs en 120 s): se agregaron el volcado de operaciones, lease y outbox ante la falla y logs `debug` del pipeline (lease ocupado, operación procesada), y después pasó 8 corridas seguidas (4 en las 3 pasadas de resiliencia más 1, y 4 en bucle). |
| 2026-10-18 | CHECKPOINT P13 (local) | Completado | `fdeee22`, `119cc64`, `7f31573`, `de8281b` | `pnpm --dir backend/app build` y `pnpm --dir backend/signer build` OK; `pnpm ci:local` sobre el árbol limpio de `7f31573`: backend 81 archivos y 1009 tests (cobertura de líneas total 93,2 %), signer 21 archivos y 337 tests, lint/typecheck, OpenAPI interna del signer, gitleaks de toda la historia del branch, OSV-Scanner, `pnpm audit --prod`, Semgrep y zizmor en verde; falló sólo `contracts`: los flags `--fork-retries`/`--fork-retry-backoff` de `fdeee22` exigen `--rpc-url` en `forge test`. `de8281b` los reemplaza por el re-run de los tests fallidos ante un 429 (con test del patrón en `ci/tests/scripts.test.mjs`) y `ci-contracts.sh` quedó en verde sobre el árbol limpio de `de8281b`: 290/290 tests en `POLICY_MODE=restricted` y en `bootstrap`, ABIs y vectores sin cambios al regenerar, cobertura de `src/` 100 % de líneas y de ramas, Slither con baseline y DeployCore + VerifyDeployment (123 verificaciones) sobre un Anvil efímero; el resto del árbol es idéntico al de `7f31573` (con `MTW_LIVE_TESTS=0`: la cuota de Mailgun sigue agotada). `node scripts/check-docs.mjs` → DOCS OK; gitleaks sin hallazgos y ningún `.env` ni `.secrets/` versionado. La CI de GitHub del push se registra en la fila siguiente. |
| 2026-10-18 | CI de P13 (GitHub) | Completado; tests live pendientes de re-ejecución | `7aa9a8d`, `b6147c0`, `233d2ab`, `b336e53` | Push `e523637..7aa9a8d`: `wallet-contracts` (290/290 en los dos modos de policy, sin reintentos por 429), `wallet-signer`, `wallet-security`, `wallet-frontend-wallet`, `wallet-frontend-recovery` y `wallet-repro-build` en verde; `wallet-backend` falló en 3 archivos que pasaban en local, todos por el RPC remoto del fork compartido por los jobs de backend, signer y contratos o por una carrera del propio test: `rpc-faults` (el gas tank recibió `RPC_UNAVAILABLE` del signer durante el deploy del setup, que el helper corría una sola vez), `pipeline` (el SEND real superó los 60 s leyendo estado frío del fork y su ejecución tardía corrió el nonce del test siguiente) y el reinicio ordenado de `crash-restart` (el worker sí ejecutó las dos operaciones, pero el watcher del proceso confirmó la primera antes de que el test viera las dos en MINED a la vez: la condición `=== 'MINED'` no se cumplía nunca; el volcado de diagnóstico agregado en P13 lo mostró). `b6147c0` (`test(backend): harden fork tests against rate limits and confirmation races`): el escenario acepta cualquier estado ejecutado y sigue probando la ejecución única con el nonce de la Safe, el SEND tiene 180 s y el helper `deploy()` reintenta los errores transitorios del RPC o del signer como el job del outbox; `233d2ab` corrige el formato (el hook no corre prettier en el backend, que no define `lint:staged`). La corrida siguiente falló en otros 2 archivos porque Anvil terminó al arrancar sin poder leer el chain id del RPC remoto; `b336e53` (`test: retry anvil startup and skip the remote chain id lookup`) pasa `--fork-chain-id 8453` y reintenta el arranque en los helpers del backend y del signer: `wallet-backend` (81 archivos, 1009 tests), `wallet-signer` y `wallet-security` en verde. Se intentó además apuntar el secret `BASE_RPC_URL` del entorno `wallet-ci-contracts` al proveedor secundario (QuickNode, con estado histórico en el bloque del fork verificado) para repartir el ritmo entre proveedores; el clasificador de permisos de la sesión bloqueó cargar el valor desde `wallet/.env`, así que queda como recomendación para el owner. Los tests live siguen pendientes de la cuota de Mailgun (ver la fila de CI de P10). |
| 2026-10-18 | P14 — Backend VI: whitelist, send y swap | Completado | commits `feat(policy): add destination whitelist enforcement`, `feat(wallet): add whitelisted sends`, `feat(swap): add restricted usdc usdt swaps` | P14.T01: `POST /wallets/{id}/whitelist/requests` (crítico, idempotente, [B-RL] 5/día por Safe y 10/día por usuario + 3 challenges/10 min) valida el destino, rechaza duplicados y crea el challenge `WHITELIST_ADD` ligado a {userId, Safe, chainId, destino, acción, nonce de 16 bytes, vencimiento} (15 min, 5 intentos, un solo uso, auditado) con el email [B-MAIL-02]; `POST /whitelist/requests/{id}/confirm` verifica el código (intento contado aunque falle) y prepara `addDestination` con la `ChallengeCompletion` (JWS EdDSA del emisor de sesiones, ligada a la SafeTx y su nonce; reproduce byte a byte el vector [W-03]) guardada en la misma transacción; la firma de U, el worker y el signer (que verifica la atestación con la clave fijada) la ejecutan; el indexer guarda los eventos de `DestinationWhitelist` y la sincronización del worker los aplica confirmados: ACTIVATING con el `activatesAt` del evento → ACTIVE cuando `isWhitelisted` es true on-chain a las 24 h (reloj de la cadena), con email y notificación; baja con U (`/whitelist/{destination}/remove`) o con R (`/emergency/whitelist-remove`), inmediata, con email que dice quién la hizo; las altas U+R por fuera quedan `SOVEREIGN` con notificación. P14.T02: EIP-55 (minúsculas o checksum exacto), ≠ 0x0, ≠ la Safe, ≠ contratos del sistema y de Safe, ≠ tokens, no duplicado (activo, en activación o con un alta confirmada en curso; un pedido que esperaba el código se reemplaza). P14.T03: `POST /wallets/{id}/send/prepare` arma `transfer` de USDC/USDT y aplica la policy con lecturas por quórum (destino activo, saldo, límites, mínimo, nonce); ≥ umbral → `requiresTwoFactor`: `POST /operations/{id}/two-factor` crea el challenge `HIGH_VALUE_TX` (TOTP si está activo, si no OTP por email con monto, token, destino y nonce) y con el código guarda la `ChallengeCompletion`; sin ella la firma de U es 403; aviso `high-value-executed` (notificación + email, una vez) al confirmarse. P14.T04: cotización con QuoterV2 por `eth_call` (quórum, codehash fijado verificado) sobre el pool del SwapExecutor: salida idéntica a QuoterV2 en el bloque, `minOut` por slippage (≤ 50 bps) acotado al piso, impacto contra el precio medio de `slot0`, `deadline` = bloque + 600 s; con el pool desviado (venta real de 200.000 USDC en el fork por el SwapRouter02) `SWAP_PRICE_OUT_OF_RANGE`. P14.T05: grupo `operation_groups` con el par `approve(SwapExecutor, amountIn)` (N) + `swap` (N+1) en nonces consecutivos; cada mitad se evalúa con la otra como pareja anticipada y el par se encola recién con las dos firmas de U (grupo bloqueado); el worker y el signer exigen la pareja real ([B-SIG-02], `pairedSafeTx`); par incompleto → la mitad firmada FAILED_FINAL `PAIR_INCOMPLETE` y nonce liberado; swap fallido con el approve ejecutado → grupo FAILED, `nextActions` [REQUOTE, REVOKE_APPROVAL], notificaciones `SWAP_FAILED` y `RESIDUAL_ALLOWANCE` (limpieza de allowances: allowance on-chain leída con quórum, aviso único) y `POST /operation-groups/{id}/requote` (par nuevo) o `/revoke-approval`. P14.T06: `GET /wallets/{id}/balances` (quórum, con la allowance hacia el SwapExecutor), `GET /wallets/{id}/whitelist` (los dos listeners) y `GET /operation-groups/{id}` (operaciones del grupo con su `groupId`), con IDOR. P14.TST.a/SEC (`test/security/whitelist-three-layers.test.ts`, A4, A9, A10, A15, A16, A18): cada bypass se rechaza en el backend, en el signer (SafeTx firmada por U enviada directo por mTLS) y on-chain con firmas válidas de U y S (S descifrada del keystore y la credencial del shard: host del signer comprometido) — `DestinationNotWhitelisted`, approve a otro spender, `MinOutBelowFloor`, token fuera del par, `SwapPostConditionFailed` (approve mayor que el swap) y llamada arbitraria revierten; una `ChallengeCompletion` falsificada (kid del emisor, otra clave) o ausente no obtiene la firma de S; S llamando directo a `addDestination` sólo toca su propia lista y sin la firma de U la Safe no ejecuta (`GS026`). P14.TST.b: challenge vencido (EXPIRED), reusado (no sirve en el mismo pedido ni en otro; intento contado), con otra dirección (binding adulterado → FAILED) y agotado; ACTIVATING no usable; idempotencia del pedido. P14.TST.c: send real de USDC y USDT con saldos verificados, 2FA por email y por TOTP, 2FA de una operación que no sirve para otra (declarado o copiado en la base). P14.TST.d: swaps reales USDC→USDT y USDT→USDC (salida ≥ minOut, allowance final 0), minOut bajo el piso y token arbitrario rechazados (y revert on-chain en el test de seguridad), swap vencido con el approve ejecutado (bloques que avanzan 700 s) → re-cotización con par nuevo → COMPLETED, y → revocación → CANCELLED. P14.MAN (2026-10-18, agente): plantilla real `whitelist-challenge` enviada por SMTP al Mailpit del stack local y leída por su API: asunto `[MTW local] Confirmá el nuevo destino autorizado`, acción, dirección completa EIP-55 en grupos de 4, etiqueta, red "Base fork local — chainId 8453", Safe, vencimiento en hora local y UTC, origen (IP/dispositivo), qué hacer si no fue el usuario y ningún link en el HTML; sin observaciones. Suite del backend: 88 archivos y 1057 tests (7 archivos y 48 tests nuevos de P14; cobertura de líneas: total 93,43 %, `src/whitelist` 95,47 %, `src/send` 100 %, `src/swap` 93,1 %, `src/operations` 94,48 %, `src/chain` 97,26 %, `src/policy` 98,27 %, `src/notifications` 100 %); typecheck, lint y `check-docs` OK. Cambios respecto del planner: (a) re-cotización = par nuevo (approve + swap) en los nonces siguientes en lugar de "nueva SafeTx N+1": el signer de P11 sólo co-firma un SWAP emparejado con el approve que co-firmó en el mismo pedido ([B-SIG-02]) y re-emparejar un approve ya ejecutado con otro swap debilitaría esa regla; el approve nuevo vuelve a fijar la allowance exacta; endpoints `GET /operation-groups/{id}`, `POST /operation-groups/{id}/requote` y `/revoke-approval` agregados a §7.11; (b) `minOut` se acota al piso cuando el slippage pedido lo deja debajo (la regla literal rechazaba siempre el slippage máximo, porque el fee de 1 bp deja la cotización apenas debajo de la paridad) y sólo se rechaza si la cotización misma está debajo del piso; (c) `USER_SIGNED → FAILED_FINAL` agregado a §7.4 (mitad firmada de un par que no se completó, sin co-firma de S); (d) el grupo de emergencia (R) de [B-API] (`whitelist-remove`, `noop`, `revoke-approval`) se implementa en P14: ninguna fase de backend lo tenía asignado, P14.T01 exige la baja con R y P19.T10 lo consume; (e) migración 0006 (expand, con backfill antes de cada CHECK): `whitelist_events` (nueva, agregada a [B-DB]), estado y motivo de los pedidos, origen/activación/baja de los destinos, par/monto/cotización de los grupos y `dedupe_key` de notificaciones; (f) la whitelist del backend se sincroniza desde los eventos on-chain de `DestinationWhitelist` (también altas y bajas soberanas o por MultiSend) y no desde el estado de las operaciones; (g) un pedido nuevo del mismo destino reemplaza al que esperaba el código (no 409) y `confirm` se puede reintentar sin otro código durante 15 min si el prepare falló por un error transitorio; (h) errores `DESTINATION_INVALID` (422, con el motivo), `WHITELIST_DUPLICATE` y `SWAP_PRICE_OUT_OF_RANGE` (409), métricas `mtw_whitelist_events_total`, `mtw_two_factor_challenges_total`, `mtw_swap_quotes_total`, `mtw_notifications_created_total` y `EFFECTS_INTERVAL_MS` (lazo de efectos del worker, en `.env.example`); (i) `SubmitSignatureRequest.twoFactorChallengeId` opcional como en [B-API-SCH] (si viene, debe ser el challenge completado de la operación); (j) los tests de whitelist, send y swap vencen entre casos las CREATED que quedaron sin firmar (ocupan nonces menores, [B-NONCE-03]); el test de whitelist usa el prepare interno (la misma policy) para no depender de la ruta de send del commit siguiente. |
| 2026-10-18 | CHECKPOINT P14 (local) | Completado | `cb0af29`, `0f1fa5e`, `a6d6b71` | `pnpm --dir backend/app build` y `pnpm --dir backend/signer build` OK sobre el árbol limpio de `a6d6b71`; `pnpm ci:local` sobre ese árbol: contratos 290/290 en `POLICY_MODE=restricted` y en `bootstrap`, cobertura de `src/` 100 % de líneas y de ramas, Slither con baseline y DeployCore + VerifyDeployment (123 verificaciones) sobre un Anvil efímero; backend 88 archivos y 1057 tests (incluye `test:security`; cobertura de líneas total 93,43 %), signer 21 archivos y 337 tests, lint/typecheck, OpenAPI interna del signer, gitleaks de toda la historia del branch (58 commits, sin hallazgos), OSV-Scanner, `pnpm audit --prod`, Semgrep y zizmor en verde (`CI LOCAL OK`, con `MTW_LIVE_TESTS=0`: la cuota de Mailgun sigue agotada). Bypass tests en tres capas (P14.TST.a, `test/security/whitelist-three-layers.test.ts`: backend, signer y Guard en el fork) en verde: se cumple la condición para pasar a P15. `node scripts/check-docs.mjs` → DOCS OK; ningún `.env` ni `.secrets/` versionado. La CI de GitHub del push se registra en la fila siguiente. |
| 2026-10-18 | CI de P14 (GitHub) | Completado; tests live pendientes de re-ejecución | `9fb7b38`, `1b4a48f` | Push `b336e53..9fb7b38` (P14 y su checkpoint): `wallet-security` en verde; `wallet-backend` falló en 2 de 1057 tests por tiempo, los dos verdes en local: el caso de reorg de `reconciler-indexer` crea su propia wallet (onboarding + deploy + NoOp) dentro del timeout por defecto de 60 s, que con el fork remoto de CI no alcanza, y el SEND real de `pipeline` superó sus 180 s mientras una corrida local de esta sesión usaba en paralelo el mismo RPC del fork. `1b4a48f` (`test(backend): give the reorg reconciliation case room on the remote fork`) le da 300 s a ese caso: `wallet-backend` (88 archivos, 1057 tests) y `wallet-security` en verde. Desde acá no se corren tests de fork locales mientras corre la CI de GitHub (comparten el ritmo del proveedor). Los tests live siguen pendientes de la cuota de Mailgun (ver la fila de CI de P10). |
| 2026-10-18 | P15 — Backend VII: rotaciones, recovery, migración excepcional, notificaciones | Completado | commit `feat(recovery): add key rotation, recovery and cancellation flows` | P15.T01: `POST /wallets/{id}/rotations` (crítico, idempotente, [B-RL] 3/día por usuario) en los dos listeners: U propone U, R, S, GUARD y MODULE_GUARD desde Wallet y R propone U o S desde Recovery ([C-GRD-11]); la clave nueva nunca la manda el cliente (U′ del flujo U_REPLACEMENT con su registro OPAQUE PENDING y KeyAcceptance, R′ del enrollment de reemplazo con su KeyAcceptance, S′ creada por el signer para la wallet con su SignerKeyAttestation, el sucesor del Guard leído del PolicyRegistry) y el worker y el signer la vuelven a verificar ([B-SIG-02]); con `RotationProposed` confirmado → PENDING_TIMELOCK con el `executableAt` del evento, email y notificación. P15.T02: `POST /rotations/{id}/cancel` público (sin sesión ni CSRF; rate limit propio de 10/h por propuesta y 60/h por IP) verifica la firma EIP-712 `CancelRotation` contra la U o la R vigentes y la propuesta pendiente on-chain y la encola para el gas tank (cola `gas-tank`, mismo worker que los deploys), que transmite `cancelWithSignature`; CANCELLED con el evento confirmado; la cancelación sin la plataforma (relayer cualquiera o wallet propia) queda en `docs/runbooks/rotation-cancellation.md`. P15.T03: `POST /rotations/{id}/execute/prepare` con la propuesta madura (48 h según el reloj de la cadena; READY_TO_EXECUTE con notificación) arma `swapOwner(prev, old, new)` con `prev` leído on-chain (R no ejecuta su propia rotación); efectos al confirmarse `RotationExecuted`: U′ → registro OPAQUE ACTIVE y el anterior RETIRED; R′ → su enrollment CONFIRMED y el anterior RETIRED; S′ → ACTIVE y la anterior RETIRED, retirada también en su shard ([B-SIG-08], seguimiento `signer_retired_at`); metadatos de claves ROTATED_OUT/ACTIVE. P15.T04 ("perdí U"): step-up U_REPLACEMENT (sólo Wallet, CF-12) → paso 1 OPAQUE con versión de clave = última U + 1 → `POST /recovery/u-replacement` (U′, KDF, backups, registro OPAQUE PENDING y KeyAcceptance; email "recuperación iniciada" y notificación) → R propone y ejecuta desde Recovery; la Password U′ desbloquea la wallet y la vieja ya no. P15.T05 ("perdí R"): enrollment de reemplazo creado con OPERATIONS en Wallet → Recovery (ENROLLMENT) envía R′ con su prueba de control y su KeyAcceptance (nonce del enrollment) → U propone → 48 h → U ejecuta. P15.T06: migración excepcional con la CLI de operadores (`pnpm operators`; TOTP por stdin con anti-replay; URI de enrolamiento escrita en un archivo 0600): caso abierto por un operador y aprobado por otro distinto (`operator_actions`), wallet vieja MIGRATING (la plataforma sólo co-firma MIGRATION_TRANSFER y la NoOp), Safe nueva con `migrated_from_wallet_id` y la credencial sana reutilizada en su rol (los índices únicos de claves y de R vivas excluyen las filas con `reused_from_wallet_id`), autorización on-chain de la Governance Safe (24 h, cancelable por guardianes), `POST /wallets/{id}/migration/prepare` (saldo completo de cada token, firma la credencial sana: U desde Wallet con el desbloqueo OPAQUE de la wallet vieja, R desde Recovery con el step-up atado a la wallet vieja) y MIGRATED/COMPLETED cuando la vieja queda sin saldo con las transferencias confirmadas; runbook `docs/runbooks/exceptional-migration.md`. P15.T07: email y notificación in-app para todos los eventos de [B-MAIL-03] (se agregan NEW_LOGIN y PASSWORD_RESET_COMPLETED; la pausa de cooperación por integridad la dispara el monitor de P20), `GET /notifications` (cursor, no leídas) y `POST /notifications/{id}/read` en los dos listeners; el indexer sigue los eventos de los RotationTimelock y las propuestas on-chain que no originó el backend quedan con origen ONCHAIN y se notifican igual. P15.T08: GUARD_UPGRADE (propuesta GUARD/MODULE_GUARD sólo con el sucesor activo en el PolicyRegistry, notificación, 48 h, `setGuard`/`setModuleGuard` firmado por U y ejecutado por S); para que la Safe actualizada siga en modo asistido, los sucesores (Guard con su RotationTimelock y module guard) se fijan en el snapshot de policy firmado (campo opcional `successors`, en backend y signer; `pnpm policy:build --successors`): el estado se lee del Guard que gobierna la Safe, la deriva acepta los sucesores y las propuestas y cancelaciones van al timelock del sucesor; runbook `docs/runbooks/guard-upgrade.md`. P15.T09 (pérdida de S): `operators executor:prepare` (S′ en el shard y los documentos [W-05] `swapOwner` + `updateRoles` para U + R por el camino soberano) y `executor:activate` (verificación on-chain con quórum; S′ ACTIVE, la perdida RETIRED y retirada en su shard); runbook `docs/runbooks/executor-key-loss.md`. Tests: `rotation-propose`, `rotation-cancel` (TST.a), `rotation-execute`, `rotation-s` (TST.d), `recovery-flows` (TST.c), `migration` (TST.e), `guard-upgrade`, `executor-key-loss`, `notifications/{api,onchain-proposal}`, `security/rotation-bypass` (TST.b en tres capas: backend, signer directo y Guard en el fork; P15.SEC: la firma de R transmitida por un relayer cualquiera cancela sin el backend) y en el signer `policy/successors`. P15.MAN (2026-10-18, agente): plantillas reales `rotation-proposed`, `rotation-cancelled` y `rotation-executed` (y `recovery-started`, `migration-approved`, `migration-completed`) enviadas por SMTP al Mailpit del stack local y leídas por su API: acción, claves completas en grupos de 4, red, Safe, plazo de 48 h y fechas en hora local y UTC, origen, qué hacer si no fue el usuario y ningún link en el HTML; sin observaciones. Suite del backend: 13 archivos de test nuevos (11 contra el fork con signer real, más `policy/guards` y `operators/operators` en proceso) y 1 del signer (`policy/successors`); las cifras totales, la cobertura y la CI local quedan en la fila del CHECKPOINT P15. |
| 2026-10-18 | CHECKPOINT P15 (local) | Completado | `55909eb`, `f5f3e4e` | `pnpm ci:local` sobre el árbol limpio de `f5f3e4e`: contratos 290/290 en `POLICY_MODE=restricted` y en `bootstrap`, cobertura de `src/` 100 % de líneas y de ramas, Slither con baseline sin cambios y DeployCore + VerifyDeployment (123 verificaciones) sobre un Anvil efímero; backend 101 archivos y 1109 tests (proyectos `backend` y `security`; cobertura total: líneas 92,7 %, sentencias 88,89 %, ramas 81,05 %; líneas de `src/chain` 97,38 % y de `src/policy` 98,38 %) y `pnpm --dir backend/app build`; signer 22 archivos y 344 tests, build y spec OpenAPI interna al día; gitleaks de toda la historia del branch (62 commits, sin hallazgos), OSV-Scanner, `pnpm audit --prod`, Semgrep y zizmor en verde (`CI LOCAL OK`; los tests live siguen pendientes de la cuota de Mailgun). La primera corrida, sobre `55909eb`, falló en 8 tests del backend con el mismo síntoma ("no llegó el email esperado"): el helper de Mailpit pedía el cuerpo y los headers de todos los mensajes del destinatario en cada sondeo de 150 ms; con varios archivos sondeando en paralelo eso saturaba a Mailpit, el SMTP del worker vencía y el reintento (backoff de 5 s) llegaba después de los 30 s de espera. `f5f3e4e` (`test(backend): fetch each mailpit message once while polling`) pide cada mensaje una sola vez y espera lo que dura un reintento del worker. Bypass de rotaciones en tres capas (P15.TST.b, `test/security/rotation-bypass.test.ts`) en verde y spec OpenAPI de los dos listeners cubierta por `test/api/openapi-coverage.test.ts`: se cumple la condición para pasar a P16–P19 (los cambios de API posteriores son aditivos). `node scripts/check-docs.mjs` → DOCS OK (runbooks de cancelación de rotaciones, migración excepcional, pérdida de S y upgrade del Guard); ningún `.env` ni `.secrets/` versionado. La CI de GitHub del push se registra en la fila siguiente. |
| 2026-10-18 | P16 — Frontends: base común por elección | Completado | commits `feat(wallet): scaffold hardened wallet frontend` y `feat(recovery): add independent recovery frontend` | P16.T01: `frontend/design-tokens/` con `tokens.css` (variables `--mtw-*`, con un acento propio de Recovery), Inter Variable y JetBrains Mono Variable self-hosted (`@fontsource-variable/*` 5.3.0, SHA-256 en su README) y `LICENSES` (OFL 1.1); cada app las copia con `scripts/sync-design-tokens.mjs` verificando el SHA-256 contra su `design-tokens.lock.json` (`--check`; `--pin` adopta un cambio revisado). P16.T02: `frontend/wallet` y `frontend/recovery` independientes (React 19.3.0, TypeScript 6.0.3, Vite 8.3.4, react-router 8.4.0, viem 2.57.4; política de supply chain de P01.T05 y versiones con ≥ 7 días, docs/VERSIONS.md); Wallet sin wagmi ni conectores (test sobre `package.json` y lockfile); Recovery con wagmi, `@wagmi/core`, `@wagmi/connectors`, WalletConnect, Coinbase (sólo EOA) y MetaMask declarados e importados sólo por el `import()` de `src/external-wallet/` (configuración completa para P19 y detección EIP-6963 sin conectar). P16.T03: ESLint con `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`, `insertAdjacentHTML` y demás sinks de HTML, `document.write`, `eval`/`new Function`, Web Storage fuera de `src/storage/flags.ts` y `src/drive/oauth-state.ts`, imports fuera de la app (regla propia) y wagmi/conectores (Wallet: nunca; Recovery: sólo en `src/external-wallet/`, y ese módulo sólo por `import()`); `lint-fixtures/` con 11 (Wallet) y 12 (Recovery) casos que fallan con la regla esperada (`scripts/lint-fixtures.mjs`). P16.T04: arranque de seguridad antes de renderizar (`src/security/boot.ts`): comprobación de que la CSP y Trusted Types se aplican (soporte, nombre de política restringido y sink de script bloqueado; si no, pantalla de bloqueo y reporte `CSP_INACTIVE`), política única `mtw-default` con la allowlist de workers resuelta en el build (`?worker&url`, `createTrustedWorker`), kill-switch de service workers y reporter de `securitypolicyviolation` (deduplicado, tope de 20 por carga, descuenta exactamente las violaciones de sus pruebas, sin cookies ni datos sensibles); worker de Argon2id (`@noble/hashes`, parámetros de los sobres; vector de RFC 9106 y resultado igual a `crypto.argon2Sync` de Node). Backend: `POST /api/v1/security/csp-report` en los dos listeners (público y sin CSRF, schema que rechaza query, fragmento y muestras arbitrarias, bucket propio de 30/min y 300/h por IP, log estructurado y métrica `mtw_frontend_security_reports_total`; `test/api/security-report.test.ts`). P16.T05: `build/headers.json` por app (CSP de [F-SEC-01] con los hosts del entorno —Wallet con `'wasm-unsafe-eval'` para OPAQUE, Recovery sin WASM—, HSTS, nosniff, `Referrer-Policy: no-referrer`, COOP/COEP/CORP y Permissions-Policy mínima con cámara sólo en `/restore` y `/sovereign`) aplicado por `vite preview` (y `vite` en dev) a toda respuesta, 403 a `Service-Worker: script` y emitido en `dist/.well-known/security-headers.json` para el contenedor de P26; `modulePreload.polyfill = false`, sin assets inline y sin scripts ni estilos inline (el plugin SRI hace fallar el build si aparecen). P16.T06: build reproducible (nombres por hash, sin sourcemaps, `SOURCE_DATE_EPOCH` = fecha del commit), SRI sha384 propio sobre los bytes finales, release manifest [W-04] en JCS y firma Ed25519 con la clave de release de cada app (`build/sign-manifest.ts`, que se niega con el árbol sucio; `build/verify-manifest.ts` detecta archivos alterados o agregados y firmas ajenas); `ci/scripts/repro-build.sh <app>`: dos builds en worktrees limpios de HEAD → manifests y firmas idénticos. P16.T07: `ci/scripts/sbom.sh` (syft por imagen fijada) → `dist/sbom.cdx.json` (CycloneDX 1.7; 278 componentes en Wallet, 574 en Recovery). P16.T08: `frontend/recovery/test/bundle-graph.test.ts` sobre el grafo real del build: la entrada y todo lo alcanzable sin pasar por el chunk de `src/external-wallet/` no contiene wagmi, `@wagmi/*`, WalletConnect/Reown, Coinbase, MetaMask, mipd ni react-query. P16.T09: `build/system-contracts.ts` genera `system-contracts.<env>.json` desde `contracts/deployments/<env>.json` (address + codehash de los 8 contratos y la clave pública de atestación del signer), lo publica en `dist/` (cubierto por el manifest) y lo embebe; `assertReportedSystem` rechaza cualquier dirección distinta informada por el backend. P16.T10: `ci/scripts/check-shared-deps.sh` falla si el mismo paquete `@noble/*`, `@scure/*` o `viem` cambia de versión en las dos apps con menos de 72 h entre ambos cambios (también sin commitear); la aprobación por dominio la exige CODEOWNERS; `ci/tests/check-shared-deps.test.mjs` con casos que fallan y que pasan. P16.TST: Vitest de cada app (Wallet 9 archivos y 51 tests, Recovery 9 y 53: lógica de seguridad, contratos fijados, Argon2id, dependencias, dos builds de release reales con SRI y manifest verificable, grafo del bundle) y Playwright contra `vite preview` (Wallet 15, Recovery 16: headers en documento, fallback y assets; CSP/TT activos sin violaciones ni reportes; worker de Argon2id con TT forzado; sink de prueba bloqueado y reportado sin el valor; `Worker`, `script.src` y `setTimeout` con strings bloqueados; sin service workers; en Recovery el chunk de wallet externa bajo CSP/TT). P16.MAN (2026-10-18, agente): auditoría de red de la carga de cada app con el protocolo de DevTools de Chromium (Playwright): todos los requests al propio origin, ninguno a terceros; queda automatizada en `test/browser/security/trusted-types.spec.ts`. P16.SEC: OSV-Scanner encontró `uuid` < 11.1.1 (GHSA-w5hq-g745-h8pq, High) transitivo del conector de MetaMask; override a 11.1.1 (misma API; la librería sólo usa `v4()`) → OSV y `pnpm audit --prod` sin hallazgos en los 4 proyectos; Semgrep con reglas propias de frontend (`ci/semgrep/mtw-frontend.yml`, probadas por `ci/tests/semgrep-frontend.test.mjs`) y zizmor en verde. Cambios respecto del planner: (1) sin `@vitejs/plugin-react`: Vite 8 transforma JSX con Oxc y el preámbulo inline de React Refresh rompe la CSP también en dev; (2) en dev la CSP va como header del servidor (no `<meta>`) con dos agregados documentados: el websocket de HMR y `'unsafe-inline'` en `style-src`; (3) `upgrade-insecure-requests` sólo en staging y producción (local y ci corren sobre http://localhost); (4) claves de release locales: las que genera P01 en `wallet/.env` (`WALLET_RELEASE_SIGNING_KEY_LOCAL`/`RECOVERY_RELEASE_SIGNING_KEY_LOCAL`), no archivos en `.secrets/`; (5) el worker de Argon2id se crea acá (no en P17.T04) para probar Trusted Types con un worker real, y lo usa la pantalla `/device-check` (protecciones, medición de Argon2id, contratos fijados y, en Recovery, wallets EIP-6963); (6) reproducibilidad: `ci/scripts/repro-build.sh <app>` y, en CI, un job `inputs` (environment `wallet-ci-contracts`) que arma los mismos insumos de la red ci para los dos builds; (7) Recovery acepta TypeScript 6.0.3 como peer de los `@solana/*` transitivos y deniega dos scripts de instalación (docs/VERSIONS.md); (8) el arranque no prueba eval: con Trusted Types exigido y sin política `default`, `eval`/`new Function` sobre strings ya quedan bloqueados y esa violación cambia de forma según el navegador. |
| 2026-10-18 | CI de P15 (GitHub) | Completado | `a5aad3b` | Los 6 workflows en verde sobre `a5aad3b`; `wallet-backend` en el segundo intento: el primero agotó el ritmo del RPC del fork compartido con otros jobs (429 del proveedor), sin fallas de código. Origen de los ajustes de presupuesto de RPC de la fila "CI de P16/P17". |
| 2026-10-18 | P17 — Frontend Wallet I | Completado | `7561bc3`, `953af15`, `fe047ee`, `f6cb84e`, `8d9cd5c`, `9aca839`, `d66f125`, `a0f6ad9`, `b709d1b` | Cliente de API del listener Wallet (CSRF con un reintento ante rotación, Idempotency-Key, problemas RFC 9457, requests críticos firmados con la session key P-256 no extraíble MTW-REQ-V1 y sobre de envío MTW-SUBMIT-V1 sobre JCS); cuenta (registro, verificación de email, login con TOTP, reset, desbloqueo de cuenta, TOTP y sesiones); PlatformSession por OPAQUE con AuthSecret_U (bloqueo a los 5 min de inactividad, revocada al bloquear y al salir) y step-up de los scopes sensibles; alta de U con Password U de 5 palabras (2 confirmadas al azar), `U.enc`, registro OPAQUE y backups verificados (Drive appDataFolder, archivo, 17 palabras impresas, QR animado); desbloqueo desde la caché local, Drive o archivo; cambio de Password U desbloqueado; Password U perdida → U′ con KeyAcceptance y handoff a Recovery; restauración en un dispositivo nuevo (sobre o 17 palabras verificadas contra la U on-chain, re-sellado con KEY_RESTORE con prueba de posesión). Tests: Vitest 28 archivos / 164 tests con umbral de 90 % de líneas por directorio de lógica; Playwright contra el stack aislado (16 tests: auth, onboarding, desbloqueo, Password U, restauración y canario de U/Password U en requests y storages) y la medición de Argon2id (ADR-013). Cambios respecto del planner: (1) OAuth de Drive con flujo implícito, por la regla de decisión de ADR-012: el spike de P17.T02 mostró que el endpoint de token de Google exige `client_secret` a los clientes web aun con PKCE (resultado registrado en el ADR); (2) ruta nueva del backend `POST /wallets/:id/user-key/password` (cambio de Password U, `953af15`) y metadatos KEY_RESTORE en el step-up; (3) en la restauración por palabras el step-up KEY_RESTORE va antes de sellar (la prueba de posesión firma con la U restaurada); (4) Argon2id: el p95 con `@noble/hashes` superó el presupuesto en el perfil móvil (CPU limitada por Docker en CI: 4,90 s Chromium / 8,72 s WebKit), así que se aplicó el plan B de ADR-013: hash-wasm 4.12.0 en el worker (1,11 s / 2,81 s), con el vector RFC 9106 validado contra `argon2Sync` de Node; (5) el orquestador del stack aislado (`scripts/stack/stack.mjs`) se adelantó de P21 para los tests de navegador; (6) `src/config/chain.base.json` como copia propia de la app; (7) `zeroize` saltea buffers ya transferidos a un worker. P17.MAN según R-14: ver la fila «Checks manuales P17.MAN, P18.MAN y P20.MAN». Ida y vuelta de OAuth (check de P17.T02): el pedido de autorización que arma la app se probó contra Google con los clientes locales de Wallet y de Recovery (2026-10-19, navegador automatizado): Google lo acepta y redirige a su pantalla de inicio de sesión (`/v3/signin/identifier`; con cliente o redirect inválidos va a `/signin/oauth/error`), y la vuelta con un token real de la cuenta de prueba por el mismo camino de Google la cubren los specs de onboarding y Drive; el consentimiento con una cuenta de Google real requiere una persona y queda en el smoke del despliegue final (`go-live.md`). |
| 2026-10-18 | P18 — Frontend Wallet II | Completado | `920388b`, `e736848` | Activación de Recovery (enrollment, link y QR [F-LNK-01] con el pedido en el fragmento, confirmación de R por el link de regreso en otra pestaña vía BroadcastChannel o por comparación manual de la dirección completa en sus 10 grupos; si el link trae otra R el pedido se aborta y hay que generar otro [F-LNK-02]); creación de la Safe con la asignación de S verificada (SignerKeyAttestation Ed25519 contra la clave fijada en el build [F-SEC-08], dirección por CREATE2 propio, config hash y typed data exacto de WalletCreationAuthorization [W-01]); verificación propia de la Safe por el RPC del frontend (V9 §16 y codehash de los contratos del sistema) al crearla y en cada desbloqueo (SafeGate); inicio (EIP-55, copiar, QR de recepción con advertencia de red, saldos de la cadena cruzados con el backend, actividad reciente, aviso de rotaciones pendientes leídas del timelock y del pedido de rotación de S); activos (símbolo y decimales on-chain contra los fijados: error bloqueante); whitelist (`destinationsOf` + labels, alta con código y revisión de la dirección, cuenta regresiva de 24 h con la hora de la cadena, baja); envío (sólo destinos activos, montos con bigint, 2FA de alto valor); swap (cotización del backend y propia con QuoterV2, slippage ≤ 0,5 %, approve exacto + swap, allowance final 0, deadline con la hora de la cadena); actividad (operaciones con estado y transfers indexados, sólo links al explorer); rotaciones (pendientes on-chain, cancelar por relay o exportando la firma, ejecutar maduras), reemplazo de R, pedido de rotación de S de la plataforma (motivo + S′ atestada), co-firma soberana sin backend (archivo o QR, export en archivo y QR animado) y migración excepcional (Safe destino verificada on-chain). Toda SafeTx se reconstruye en la app y se compara campo por campo y por hash con la del backend; si difiere, no se firma. Tests: Vitest 48 archivos / 346 tests (umbrales de 90 % de líneas por directorio de lógica); Playwright 15 sin backend y 59 contra el stack aislado (22 archivos) (un spec por pantalla, más `security/`: prepares de envío y swap adulterados —otro monto, otro contrato, DELEGATECALL, approve ilimitado, mínimo de salida fuera del slippage—, asignación de S adulterada —incluida una S no atestada con todo lo demás coherente— y un contrato del sistema con otro codehash). Cambios respecto del planner: (1) backend: ruta `GET /wallets/:id/transfers` (transfers indexados para Actividad) y el pedido de rotación de S por la plataforma (CLI `executor:rotation-request`, borrador DRAFT con motivo y atestación de S′ expuestos en la vista de la rotación, email y notificación `EXECUTOR_ROTATION_REQUESTED`), que P18.T09.b necesitaba y no existían; (2) la app cancela en el backend lo preparado y no firmado (verificación fallida, review cancelado o abandonado) para liberar el nonce reservado [B-NONCE-02]; (3) el sobre de envío usa segundos Unix enteros con la hora alineada al servidor (`ServerAlignedClock`, desde `issuedAt` de la PlatformSession): el backend rechazaba el ISO; (4) plazos y madurez con la hora de la cadena (bloque), no la del dispositivo; (5) `/sovereign` es pública y no toca el backend; (6) la migración de prueba usa la Governance Safe del deploy impersonada en Anvil para autorizar en el PolicyRegistry (24 h); (7) los specs de navegador no recargan la página después de desbloquear (el desbloqueo vive sólo en memoria): navegan con los links de la app. P18.MAN según R-14: ver la fila «Checks manuales P17.MAN, P18.MAN y P20.MAN». |
| 2026-10-19 | CI de P16–P18 (GitHub) | Completado | `8c0324d`, `fa18279`, `ce9631d`, `3d62c49`, `febc707`, `cab9810`, `d01de20`, `ad9e356`, `3f34018`, `3d5c859`, `8d9ef95`, `9cb09a9` | Los workflows quedaron en verde después de corregir fallas intermitentes del fork compartido en CI (ninguna era del producto, salvo `febc707` y `8d9ef95`): presupuesto de CU/s del RPC del fork repartido entre jobs (`docs/CI.md#presupuesto-del-rpc-del-fork`) y log redactado de Anvil por archivo como artefacto; receipts consultados directo (viem dejaba de pedirlos); timeouts de los tests de fork a 3 min; `unrouteAll({behavior:'wait'})` en los specs que interceptan; copia de los ABIs de los frontends verificada contra `contracts/out-abi`. Correcciones del producto: (1) el gas tank recarga a una S trabada por falta de gas (`febc707`); (2) el signer reintenta las fallas transitorias del nodo en simulación y estimación (`3d5c859`), con un presupuesto total de 45 s por operación y un `SELECT 1` antes de cada lectura dentro de la transacción de co-firma, para que un RPC lento termine en `RPC_UNAVAILABLE` y nunca corte la transacción por `idle_in_transaction_session_timeout` (`8d9ef95`). Un intento de compartir un único Anvil upstream entre los tests del backend se descartó: forkear de un Anvil local cuelga el tag `safe` y no evitó las fallas de fetch del upstream. |
| 2026-10-18 | P19 — Frontend Recovery | Completado | `f5c49a5`, `3febbe2`, `f15cd44`, `0bf9100` | Recovery completa sobre la base de P16, sin compartir runtime con Wallet: cuenta y step-up (email OTP + TOTP) con PlatformSession `ENROLLMENT`/`RECOVERY` y session key propia; enrollment desde el link/QR con R interna (Password R de 5 palabras, sobre `R.enc` con AAD, backups en el Drive de Recovery, archivo, QR y 17 palabras) o wallet externa (chunk lazy), prueba de control EIP-712 con `eth_signTypedData_v4` y link de regreso [F-LNK-02]; recuperación de U (U′ completa a la vista, R+S proponen, cuenta regresiva on-chain y ejecución a las 48 h); rotaciones (pendientes on-chain; cancelar por relay del backend, con `cancelWithSignature` pagado por la wallet externa o exportando la firma para cualquier relayer; ejecutar maduras); modo soberano con la plataforma apagada (acciones tipificadas [W-05], nonce on-chain, firma de R, co-firma de U por archivo o QR, combinación ordenada y transmisión con una wallet externa o calldata para cualquier relayer); restauración de R (Drive en un dispositivo nuevo, archivo, QR o 17 palabras, verificada contra el rol R on-chain; Password R nueva y re-cifrado al restaurar por palabras); `/emergency` (quitar destinos, NoOp que ocupa el nonce de una operación firmada, revocar el permiso residual del SwapExecutor) y `/migration` (Safe destino verificada on-chain antes de firmar `MIGRATION_TRANSFER`). Herramienta de salida soberana `tools/sovereign-exit/` (P19.T09): un único HTML con JS y CSS inline y CSP por hashes, build reproducible y `SHA256SUMS` firmado con Ed25519; descifra `U.enc`/`R.enc` o restaura desde 17 palabras, arma la SafeTx soberana, firma con U y R, combina y emite la calldata o la transmite con la cuenta que elija el usuario. Tests: Vitest de Recovery 42 archivos / 256 tests (cobertura 95,44 % sentencias, 89,14 % ramas, 95,45 % funciones, 97,64 % líneas; umbral de 90 % de líneas por módulo de lógica); grafo del bundle 4/4; Drive real 3/3; Playwright 16 sin backend (headers, Trusted Types, requests) + 28 contra el stack aislado y el fork (enrollment interno y externo, recuperación de U con warp de 48 h, rotaciones ×4, emergencia ×4, migración, restauración ×5 incluida Drive real, modo soberano ×2 con el backend detenido de verdad, conectores ×6, WalletConnect real ×2 y terceros en todas las pantallas); herramienta: 36 tests (cobertura de líneas 91,93 %) y E2E en el fork con backend y frontends apagados (transferencia soberana U por sobre + R por 17 palabras). Conectores probados (P19.T07, `docs/CONNECTORS.md`): EIP-6963 genérico y MetaMask (`io.metamask`), `injected`, Coinbase Wallet sólo EOA con la extensión y WalletConnect por el relay real de Reown con QR propio; ninguno genera violaciones de CSP/TT ni requests a terceros fuera de los permitidos. P19.MAN (R-14): `test:browser -- walletconnect.live` en verde el 2026-10-18 — una wallet headless (`@reown/walletkit` 1.6.0) conectada por el relay real firmó la prueba de control (R de la Safe) y la cancelación de una rotación pedida por la plataforma en el fork. Cambios respecto del planner: (1) el conector `metaMask` (MetaMask Connect, `@metamask/connect-evm`) queda excluido: habla con la extensión por un transporte propio, lee del RPC público de Base y manda analítica, fuera de la CSP; MetaMask sigue soportada por EIP-6963 y WalletConnect (documentado en `CONNECTORS.md`, como pide P19.T07); (2) Coinbase Wallet por su SDK sólo con la extensión (sin ella abre un popup que la COOP `same-origin` corta); (3) WalletConnect sin el iframe de Verify (`frame-src 'none'` y COEP) y sin telemetría: en `connect-src` sólo el relay; (4) el Drive de prueba de Recovery usa las mismas credenciales `GOOGLE_DRIVE_TEST_*` que Wallet (cliente del proyecto de Google Cloud de Wallet): no hacen falta `GOOGLE_DRIVE_TEST_RECOVERY_*`; (5) `scripts/stack/stack.mjs` suma `backend-stop`/`backend-start` para probar el modo soberano con la API, el worker y el gas tank detenidos; (6) el test estático de requests admite la API de Recovery del entorno (el inicio consulta la sesión), nunca otro host; (7) grupo de `codeSplitting` de rolldown para que la entrada no cargue código de WalletConnect; (8) el commit de P19 no repite el nombre `feat(recovery): add independent recovery frontend`, que ya usó el scaffold de P16 (`e28c606`). |
| 2026-10-19 | P20 — Integridad de releases y pausa de cooperación de S | Completado (P20.MAN en la fila de checks manuales) | `0e2ad23`, `672f786`, `9cb09a9` | P20.T01: claves Ed25519 de release distintas por app y por entorno; públicas fijadas en `config/release-keys/` (producción y `staging/`), privadas sólo como `WALLET_RELEASE_SIGNING_KEY`/`RECOVERY_RELEASE_SIGNING_KEY` de los environments `wallet-staging`/`wallet-production` (tags `wallet-v*`) y, para los ensayos locales, en `~/.config/mtw/secrets/<entorno>/` (0600); `node scripts/check-release-keys.mjs` en el gate de seguridad. P20.T02: `backend/integrity-monitor` (contenedor propio, clave de atestación propia, sin credenciales de otros componentes): cada 60 s por app verifica firma del manifest con la clave fijada, JCS, cada archivo por SHA-256 y tamaño sin seguir redirecciones, `/` = `index.html` del manifest, SRI y recursos del documento con parse5 (sin scripts inline, `on*`, `<base>` ni embebidos), headers por ruta contra `security-headers.json` del release y 403 a service workers; emite `IntegrityAttestation` [W-03] (5 min); varias públicas por app para el solapamiento de una rotación. P20.T02.a: `wallet-integrity-offhost` (cada 15 min desde `main`, `check-once` con alerta por email/Mailgun y webhook); simulacro en el runner (`vite preview` de Recovery con un archivo alterado → MISMATCH y alerta enviada) en verde el 2026-10-19. P20.T03: el signer coopera sólo con atestaciones vigentes (≤ 5 min) de las dos apps; MISMATCH pausa en el acto y un OK anterior reenviado no la levanta; UNREACHABLE con 15 min de gracia desde el último OK; sin atestación → pausa (`COOPERATION_PAUSED`, reintentable); el backend adjunta las atestaciones verificadas a cada co-firma, registra `integrity_status`, audita `INTEGRITY_MISMATCH` y `COOPERATION_PAUSED/RESUMED` una sola vez aun con varios workers y expone `GET /platform/status`, que muestra el aviso de pausa en Wallet. P20.T04: reanudación sólo con el release otra vez OK y dos aprobaciones Ed25519 de operadores distintos para ese release exacto (vencen a la hora; pausa persistida en disco). Tests: monitor 34 (cobertura de líneas 95,4 %), compuerta del signer 32 (con el vector compartido) e integración de la pausa contra el fork, backend 7 (cliente, registro con Postgres real y ruta), spec del aviso en Wallet; runbook `docs/runbooks/integrity-mismatch.md`. Cambio respecto del planner: el backend obtiene las atestaciones del monitor y las adjunta a cada pedido de co-firma (el signer no tiene red hacia el monitor); con un atacante en el backend la pausa se demora a lo sumo la vigencia de un OK (5 min). |
| 2026-10-19 | CHECKPOINT P16 a P20 | Completado | `5113103`, `59b694e` | Marcados con evidencia: build, tests y security tests en verde en GitHub (wallet-frontend-wallet, wallet-frontend-recovery, wallet-backend, wallet-signer, wallet-sovereign-exit, wallet-contracts, wallet-security, wallet-repro-build sobre `01492fb`/`58e90af`), `node scripts/check-docs.mjs` → DOCS OK, `gitleaks git --redact` con la configuración del repo sin hallazgos y `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío, commits pusheados con su hash en las filas de cada fase. Pendiente: la casilla «integración anterior sigue funcionando: `pnpm ci:local`» de P16–P20 (las últimas corridas locales sobre `953af15` y `ce9631d` fallaron por las intermitencias del fork que corrigen `3d5c859`/`8d9ef95`). La corrida limpia sobre `27e5d9f` en un worktree falló por cómo armé el worktree, no por el producto: sin `.tools` tomó el Node y el pnpm del sistema (`packages field missing or empty`) y el Anvil efímero no levantó, así que el guard del deploy cortó con `NotAnvil()` sin transmitir nada. La corrida sobre `4e6ec3f` con la toolchain fijada (Node 26.12.0, pnpm 12.14.0, Foundry 1.8.5) pasó docs, contracts, signer, integrity-monitor y repro-build, y falló en otras cinco etapas. Las causas y sus arreglos: (1) backend: `env.test.ts` no traía en el fixture de producción la configuración del monitor que P20 volvió obligatoria. Por eso `wallet-backend` también estaba en rojo en GitHub desde P20 (`aa3b909`, con un test fail-closed nuevo). Además, el test de espera de un email inexistente no toleraba una máquina cargada (`333e831`, con el mismo criterio que el test vecino), y hubo timeouts del RPC upstream del fork; (2) security: `Math.random` en el jitter, frenado por la regla propia de Semgrep (`d083894`); (3) Recovery y sovereign-exit: el stack no arrancaba porque `db:migrate` fallaba ("lock o lectura de estado"). El healthcheck de Postgres probaba por el socket Unix y daba sano durante los scripts de init, antes de que el servidor final aceptara TCP. `0ae994c` lo pasa a TCP y `d7f29dd` hace que la CLI muestre la causa; (4) Wallet: una carrera del spec de decimales con un pedido al RPC que la app cancela al navegar (`407e10e`). Segunda corrida, sobre `fba8238` y con la máquina muy cargada (load average 70–96): pasaron docs, contracts, backend, signer, integrity-monitor, frontend-wallet, sovereign-exit, repro-build y security. Sólo falló frontend-recovery, en `rotations.spec.ts`: la CLI de operadores devolvió `TOTP_INVALID` porque el código se calculaba antes de lanzarla y vencía la ventana de ±30 s mientras arrancaba. `b9cd8ba` reintenta con un código nuevo sólo ante ese error, sin efectos porque la autenticación va primero (en Wallet y Recovery). **`pnpm ci:local` en verde (2026-10-19) sobre `59b694e`, con P17/P18 integrados, en un worktree limpio con la toolchain fijada: «CI LOCAL OK».** Por etapa: docs (tests del preflight 36/36, tests de CI 17/17, DOCS OK); contracts (dependencias idénticas a la fuente oficial, 290/290 en `POLICY_MODE=restricted`, 290/290 y 273 + 2 omitidos en los otros perfiles, Slither con baseline); backend 106 archivos y 1149 tests; signer 355; integrity-monitor 34; Wallet 420 unitarios, Drive real 3, navegador 19 y stack 61; Recovery 257 unitarios, Drive real 3, navegador 16 y stack 28; sovereign-exit 36 y su E2E con la plataforma apagada; repro-build de Wallet y Recovery reproducible y con firma verificable; security: gitleaks sin hallazgos, OSV sin problemas, `pnpm audit`, zizmor, Semgrep y P21.SEC. Marcada la casilla «`pnpm ci:local`» de los checkpoints P16, P17, P18, P19, P20 y P21. En GitHub, `wallet-backend` sobre `59b694e` falló dos veces en `gas-tank.test.ts`: el signer devolvió `RPC_UNAVAILABLE` al crear la Safe con el RPC upstream saturado, coincidiendo con otras corridas contra el mismo endpoint, y los demás tests del archivo fallaron en cascada. El tercer intento, sin contención, quedó en verde (corrida `39222028561`), igual que la suite local (1149/1149). |
| 2026-10-19 | P21 — Entorno local integrado y seed determinístico | Completado | `77f972a`, `f95df20`, `01492fb`, `cc6532d`, `4e6ec3f`, `d083894`, `f7a7802`, `fa014ba` | `pnpm install` → `scripts/install-all.mjs` (cada proyecto con su lockfile congelado + Soldeer verificado); `pnpm dev` (`scripts/dev.mjs`: preflight rápido, compose, migraciones, deploy-local, policy local firmada, shards, seed, procesos con prefijo y apagado ordenado); `pnpm dev:healthcheck`; `pnpm dev:fresh` (fork al bloque fijado, bases recreadas, deploy) probado en local el 2026-10-19 (`VerifyDeployment` con 123 verificaciones); seed completo off-chain sobre la Safe determinística (salt del producto para un walletId derivado de `LOCAL_SEED`, destino whitelisteado por U+S y activado con warp de 24 h, S importada en el shard de desarrollo con su atestación, wallet ACTIVE después de la verificación normal, OPAQUE de U, sobres `U.enc`/`R.enc` con el crypto de cada app) y `pnpm seed:check`; runbook `docs/runbooks/local-environment.md`. En la máquina de desarrollo `pnpm dev` no se pudo completar: el preflight falló sólo por red (Etherscan inaccesible) y los puertos 8090/8091 los tienen los shards de desarrollo previos (no se tocan); la validación desde un clon limpio corre en GitHub (`wallet-local-env`). Ojo: `pnpm dev:fresh` recreó las bases `mtw_signer_dev`/`mtw_signer_platform_dev` y los keystores locales de esos shards previos (son de desarrollo, sobre el fork). 2026-10-19: `wallet-local-env` sobre `cc6532d` se cortó en el preflight por HTTP 429 de Alchemy en PF-13…PF-16 (unos diez workflows a la vez contra el mismo RPC). Con `4e6ec3f` el preflight reintenta los 429/503 con backoff (Retry-After con tope de 10 s; tests nuevos en `scripts/preflight.d/__tests__/checks.test.mjs`) y la validación se relanzó. La corrida en verde sobre `8460606` no cuenta: se pidió con `localEnv: false` y salteó los pasos. Sobre `4e6ec3f` el clon limpio pasó preflight, install, `dev:fresh` (`VerifyDeployment` OK con 123 verificaciones), `pnpm dev` y `HEALTHCHECK OK` de los 12 servicios, pero `seed:check` recibió 403 en el login: no mandaba el token CSRF. `f7a7802` lo pide con `GET /auth/csrf` como el cliente de Wallet; relanzado. Además, `wallet-security` frenó el jitter del backoff por la regla propia `mtw-no-math-random` (Semgrep), y `d083894` lo pasa a `randomInt` de `node:crypto`. Sobre `8c612c3`, el login del seed ya pasa (wallet ACTIVE, Safe y saldos correctos), pero el destino de prueba no quedaba activo. Los `vm.rpc("evm_increaseTime")`/`evm_mine` de `SeedLocal.s.sol` corrían durante la simulación del script, antes del broadcast, así que el alta se minaba con el reloj ya adelantado y quedaba pendiente. `fa014ba` activa el destino desde `scripts/seed-local` después del broadcast (warp exacto hasta `activatesAt` y `evm_mine`, como el helper de los E2E, verificando `isWhitelisted`), y el script ya no reintenta el alta si el destino existe (pendiente o activo); relanzado. **P21.MAN (2026-10-19, agente, desde un clon limpio en GitHub, `wallet-local-env` corrida `39207770654` sobre `9e9fd48`):** `docker compose up -d` → `pnpm install` (los 6 proyectos con lockfile congelado, Soldeer con forge-std, OpenZeppelin y v3-core idénticos a la fuente oficial) → `pnpm preflight` (PREFLIGHT PASSED) → dos corridas de `dev:fresh` + `pnpm dev`. En las dos: `VerifyDeployment OK` (123 verificaciones), `HEALTHCHECK OK` de los 12 servicios y `seed-check OK` (el usuario seed inicia sesión, wallet ACTIVE con la Safe del seed, destino activo y 10.000 USDC / 5.000 USDT). Resultado: «LOCAL ENV OK: healthcheck y seed-check en verde en las dos corridas, mismos contratos, Safe y saldos». Con eso quedan marcados P21.T01–T04, P21.TST, P21.MAN y, del checkpoint, build y tests. P21.SEC y «security tests pasan»: `bash ci/scripts/ci-security.sh` en verde en `wallet-security` sobre `a7b6a83` (incluye «P21.SEC: seed-local se niega fuera de APP_ENV=local y si el RPC no es Anvil»). «git status revisado»: árbol limpio y todo pusheado, con hashes en esta fila. «`pnpm ci:local`»: en verde sobre `59b694e` (ver la fila del checkpoint P16 a P20). Marcados con evidencia el 2026-10-19: P21.T05 y «documentación actualizada» (`node scripts/check-docs.mjs` → DOCS OK, con el runbook `docs/runbooks/local-environment.md`), y «no secrets committed» (`gitleaks git --redact` con `wallet/.gitleaks.toml` sobre toda la historia sin hallazgos; `git ls-files wallet | grep -E '(^|/)\.env$|\.secrets/'` vacío). |
| 2026-10-19 | Checks manuales P17.MAN, P18.MAN y P20.MAN (R-14) | P20.MAN completado; P17.MAN y P18.MAN en curso (correcciones de las revisiones) | `8460606`, `4e6ec3f`, `8c612c3`, `f8d6f6b`, `948c5c8`, `e7c3486` | Corren en GitHub con `wallet/manual-checks.json` (`wallet-review-tours`). P17.MAN: recorrido de onboarding en verde en Chromium y Firefox (corrida `39198672655`, 17 capturas por navegador). Revisión independiente de los textos de advertencia (2026-10-19, agente revisor, las 34 capturas y el código de cada pantalla): **RECHAZADO**, con 3 hallazgos bloqueantes. B1: no se dice en ningún lado que perder U y R a la vez deja los fondos inmovilizados (RR-14). B2: la confirmación manual de R se puede pasar copiando la dirección que muestra la propia Wallet, lo que anula el control de [F-LNK-02] contra una R sustituida. B3: se llama "clave" a lo que es una dirección pública (Wallet y Recovery). Además 15 observaciones, entre ellas el step-up que dice "Vence en 15 minutos" cuando vence a los 10, y las 17 palabras que se ocultan con un clic sin vuelta atrás. Todo se corrige en P17 antes de marcar la casilla; después se repiten el recorrido y la revisión. Chromium y Firefox se ven iguales. **Correcciones integradas (2026-10-19, `7b3bb46` y `7564bdb`):** B1: aviso de que perder U y R a la vez inmoviliza los fondos, en los backups y en la activación de Recovery, más el camino de recuperación en 02 y 17. B2: la Wallet no muestra la R del backend hasta que lo tipeado coincide; compara los 10 grupos sin distinguir mayúsculas, indica qué grupos fallan sin revelar lo esperado, da 3 intentos por pedido y después lo aborta (con «Generar un pedido nuevo»). Un pedido abortado tampoco lo confirma un enlace de regreso que llegue después. Tiene tests unitarios, de navegador y del stack, y el helper del stack tipea la R desde el dato del test, nunca desde la pantalla de Wallet. B3: "dirección" en lugar de "clave" en Wallet y Recovery. Además las 15 observaciones, entre ellas: confirmación de 3 de las 17 palabras antes de darlas por anotadas; vencimiento real del código del step-up en Wallet y Recovery; fecha de la última verificación del backup en Drive; re-exportación del QR en Seguridad; opción de 128 MiB de [F-KEY-03] con su advertencia; `aria-current` en el paso actual; y capturas nuevas del recorrido. Recorrido de onboarding pedido otra vez en Chromium y Firefox (`6457845`); después, segunda revisión independiente. **Segunda revisión independiente de P17.MAN (2026-10-19, agente revisor nuevo, las 56 capturas de `59b694e` y el código): RECHAZADO por un bloqueante nuevo.** B1–B3 y O1–O15 de la primera revisión quedaron resueltos en el recorrido; de B3 y O15 quedan restos fuera de él. NB1 (bloqueante): en la app Recovery, el paso «Backups de tu clave R» dice que con el backup y la Password R se recupera la wallet sin la plataforma, y es falso (sin la plataforma también hace falta U). Esa pantalla nunca se capturó: el recorrido envía R por API. No bloqueantes que se corrigen igual: N1, los backups de R en Recovery repiten problemas ya corregidos en Wallet (QR animado que al imprimir sale incompleto, 17 palabras sin reingreso, impresión de la página entera, que incumple [F-KEY-06].4); N2 (seguridad, [F-LNK-02]/ESC-20), un backend comprometido podría falsificar el enlace de regreso con su R′, y se propone un secreto que genera la Wallet y que el backend nunca ve; N10, el aborto por no coincidencia es sólo del cliente, sin REJECTED, auditoría ni alerta en el backend; N3–N9 y N11 (textos y comportamiento de la confirmación de R, restos de "clave" por dirección y otros). Además, sumar al recorrido las pantallas de Recovery del onboarding y el camino del enlace de regreso. **Correcciones de la segunda revisión integradas (2026-10-19, `fc33587`, `c0fff63`, `5c07105` y `f8e89f2`):** NB1: texto veraz en los backups de R (archivo y QR con la Password R, las 17 palabras sin ella, y sin la plataforma hacen falta R y U). N1: backups de R a la par de los de Wallet (QR de cuadros quietos, impresión sólo de lo necesario con `@media print`, reingreso de 3 de las 17 palabras, «en inglés, letra por letra», casillas «(sin la Password R al lado)»). N2: ADR-033, secreto `k` de 128 bits por pedido en los fragmentos de ida y vuelta; la confirmación por enlace exige `k` (tiempo constante) y la R del backend, y el backend nunca ve `k`. Actualizados [F-LNK-01/02], ADR-010 y ESC-20 del threat model. N10: `POST /recovery/enrollments/{id}/reject` (REJECTED con motivo, migración 0009, auditoría, aviso, email «Posible sustitución de tu clave R», alerta y métrica), con la llamada de la Wallet al abortar; actualizados [B-API], [B-API-SCH], [B-DB] y [B-MAIL-03]. N3–N9, N11 y menores, más los restos de «clave» por dirección en las dos apps (incluidos el inicio y el restaurar de Wallet). Además, los avisos de la app leen el monto del backend con un parser de máquina (con el parser de lo que tipea el usuario, «500.125» se rechazaba) y un tipo desconocido ya no muestra el código interno. **Orden de despliegue (ADR-033): Recovery antes que Wallet**, porque una Recovery anterior no devuelve `k`. Se agrega al runbook de despliegue en P25/P26. Verificado: Wallet lint, typecheck y 521 tests; Recovery lint, typecheck y 259 tests; backend lint, typecheck y 161 tests (OpenAPI, emails, rechazo, migraciones y health); `check-docs` OK. El recorrido de onboarding ahora pasa por las pantallas reales de Recovery (pedidos completos, no coincidencia, pedido cancelado, confirmación manual, pestaña recargada y enlace de regreso con `k`). Pedido en Chromium y Firefox; después, tercera revisión independiente. Sobre `4c7d13a`: en verde security, repro-build, sovereign-exit y `wallet-frontend-wallet` (con los tests del stack de `k` y del rechazo), y el backend pasó 108 archivos y 1167 tests. Fallaron sólo los pasos que usan Google, porque los refresh tokens vencieron entre las 11:48 y las 12:00 UTC (ver la fila del bloqueo): el email real del backend, Drive en dos tests del stack de Recovery (los otros 25 pasaron) y el recorrido de onboarding, que pasa por el paso real de Drive (`DriveError: La conexión con Google Drive venció`). **P17.MAN queda esperando los tokens nuevos** para repetir el recorrido y hacer la tercera revisión. Mientras tanto corre una revisión de seguridad independiente del código de ADR-033. **Revisión de seguridad independiente de ADR-033 y del rechazo de enrollments (2026-10-19, agente revisor):** no hay forma de que un backend comprometido haga confirmar R′ por el enlace de regreso sin `k`, ni camino por el que `k` llegue a la API, a los logs o a otro origin. Hallazgos que se corrigen antes de cerrar P17: ALTO, rechazar un pedido de reemplazo de R con la rotación ya propuesta deja una fila que, cuando la rotación se ejecuta, viola el CHECK de la migración 0009 y traba el sync de rotaciones de todas las wallets (y con él las alertas de ESC-23); MEDIO, con un `k` válido una respuesta inconsistente del backend no aborta y su texto libre se muestra junto a los 10 grupos, un canal para mostrar R′; 6 BAJOS (`k` en el sessionStorage de Recovery durante el OAuth de Drive, historial del navegador, enlace en una pestaña sin el pedido, aviso de aborto frágil, rechazo desde otra pestaña, abuso del email) y huecos de tests. **Corregido (2026-10-19, `4f51f8c`, `5cdc237`, `d43daa1` y `e256885`):** ALTO: el rechazo de un reemplazo con la rotación hacia R′ en curso responde 409, en la misma transacción y con lock; la propuesta revalida el pedido con lock; el sync aplica EXECUTED aunque la fila esté REJECTED (la cadena manda, con alerta `RECOVERY_REJECTED_KEY_EXECUTED`) y cada evento se aplica aislado, con cuarentena, reintento exponencial, alerta y métricas, sin frenar a las otras Safes (migración 0010). MEDIO: con `k` válido, cualquier respuesta distinta de «SUBMITTED, mismo id y misma R» aborta, y regla nueva en las dos apps: ningún texto del backend (`title`, `detail`, `requestId`) llega a la pantalla, sólo textos locales por código o por status. BAJOS: el estado del OAuth de Drive en Recovery queda acotado y documentado como excepción de [F-KEY-07]; el historial del navegador es RR-17 en el threat model; la pestaña sin el pedido lo explica enseguida e informa con la sesión del propósito; los avisos de aborto pasan a una cola en memoria, con `fetch` keepalive firmado de antemano; la comparación manual relee el pedido; un email de seguridad por usuario por hora, con resumen. También los menores. Decisión: abandonar después de una comparación fallida se sigue informando como `MANUAL_COMPARISON_FAILED` (con email), porque ante una sustitución real el usuario puede abandonar creyendo que es un error; el tope de un email por hora acota la fatiga. Planner actualizado: [F-KEY-07], [F-LNK-02], [B-API], [B-MAIL-03], [B-DB] (incluida la fila `rotation_events`), alertas de [B-OBS] y fila de ADR-033. **Despliegue:** backend (migración 0010) y Recovery antes que Wallet. Verificado en local: Wallet 531 tests, Recovery 261, backend (`test/recovery`, `test/rotations`, migraciones, emails, OpenAPI y health) en verde salvo el email real de Gmail (token vencido). `check-docs` OK. P18.MAN: recorrido de operaciones en verde en Chromium sobre `8460606` (corrida `39201091145`; antes se colgaba al pasar al swap, ahora entra desde el inicio como en el resto de las pantallas). Revisión independiente de la legibilidad de los reviews (2026-10-19, agente revisor, las 17 capturas y el código): **APROBADO CON OBSERVACIONES**. No hay nada que haga firmar algo distinto de lo que se muestra; el review sale de la SafeTx verificada campo por campo y por hash. Pero aparecen defectos que se corrigen antes de marcar la casilla: el campo del código de la whitelist queda precargado con el nombre (React reutiliza el campo no controlado); la cotización del swap no se invalida al cambiar el formulario (se podría preparar con otro slippage); falta la alerta en la app de un destino en activación (§9.3, ADR-006, ESC-16); el review de Wallet no tiene estilos; y hay observaciones de formato y textos (separador decimal, umbral del segundo factor, estados finales, actividad). Después se repiten el recorrido y la revisión. **Correcciones integradas (2026-10-19, `180bc09` y `7ccf9ab`, más la resolución de los conflictos con P17):** los 15 hallazgos. Formularios del alta con `key` propio (el código arranca vacío; mismo arreglo en TOTP). Alerta en el inicio por cada destino en activación (cuenta regresiva con la hora de la cadena y «Quitarlo» directo) y avisos in-app de P15.T07 con texto para los 19 tipos. CSS del review portado de Recovery y direcciones con `AddressText`. La cotización del swap se descarta ante cualquier cambio del formulario, y el review muestra slippage y mínimo. El permiso nombra al contrato de swap de la plataforma. Formato es-AR, umbral del segundo factor tomado de la policy vigente (`PreparedOperation.twoFactorThreshold`) y estados finales con «ver transacción». Vencimiento «vence en 10 min (HH:MM:SS)» con el reloj de la cadena, y desplegable «Detalles técnicos». Actividad con la intención de cada operación (`OperationStatus.decoded`, ya guardada en `canonical_intent`) y el swap en una línea. Jerga reemplazada por castellano. Los dos campos nuevos de la API quedan en [B-API-SCH]. Wallet: lint, typecheck y 420 tests (54 archivos) en verde con los dos lotes integrados; backend: lint, typecheck, `openapi-coverage` y `operation-view` 14/14. Recorridos sobre `59b694e` (P17 y P18 integrados) en verde en `wallet-review-tours` (corrida `39222029074`): onboarding en Chromium y Firefox, con 28 capturas por navegador que incluyen las que faltaban, y operaciones en Chromium, con 18 capturas y la alerta del destino en activación. **P18.MAN APROBADO (2026-10-19, segunda revisión independiente; agente revisor nuevo, las 18 capturas de `59b694e` y el código): APROBADO CON OBSERVACIONES no bloqueantes.** Nada hace firmar algo distinto de lo que se muestra (el review sale de la SafeTx verificada contra la del backend con `verifyPrepared`/`verifySwapPair`). Las 15 observaciones de la primera revisión están resueltas; la 14 (Activos) se verificó en el código porque la captura salió cargando. Observaciones nuevas, que se corrigen antes de P22: M1, un swap vencido muestra «venció» pero el botón de firma sigue (el backend lo rechaza con DEADLINE_INVALID, sin riesgo para los fondos); M2, el email muestra «1000 USDC» y agrupa la dirección distinto que la app, cuando se pide compararlos; M3, la educación de ESC-16 tiene que pedir también comparar con la fuente original; M4, dos esperas del spec capturan antes de que termine la navegación y no hay captura de «Detalles técnicos». Más 8 menores (textos de actividad y pantallas finales, estilos de avisos, «1.000» interpretado como 1, labels que imitan nombres del sistema). **Correcciones de la segunda revisión de P18.MAN (2026-10-19, `6c567e2` y `deb803d`):** M1: el review deja de ofrecer la firma de un swap vencido o a menos de 1 minuto de vencer (hora de la cadena); «Volver a cotizar» cancela lo preparado y vuelve a cotizar, y los rechazos y motivos se muestran en texto. M2: los emails agrupan las direcciones como las apps y los montos van en es-AR (`amountUnits`), con un test que sigue el camino real (servicio → outbox → worker → texto) del email de 1.000 USDC; [B-MAIL-02] actualizado. M3: se pide comparar también con la fuente original, y las alertas suman «o si no es la dirección que esperabas». M4: el recorrido espera que carguen Activos y Actividad, y suma capturas de «Detalles técnicos», del swap vencido y de lo recibido. B1–B8: actividad sin «de», «Cancelada antes de firmar», hash de la transacción y ayuda de todos los estados; aviso de éxito; pantallas finales en pasado con lo recibido; alerta de activación ordenada; estilos de estado y avisos, sin huecos; «1.000» ambiguo se rechaza y bajo el campo se muestra cómo se interpretó; labels entre «» y nombres del sistema reservados; QuoterV2 y unidades mínimas explicados. Wallet: lint, typecheck y 503 tests (59 archivos); backend: lint, typecheck y 115 tests de email. Sobre `a224cae` los 9 workflows quedaron en verde, incluidos el recorrido de operaciones (corrida `39241766725`, 21 capturas) y los tests del stack de Wallet. Verificado en las capturas: el swap vencido ya no ofrece «Firmar» y sí «Volver a cotizar», y «Detalles técnicos» muestra contrato, valor, CALL, función, argumentos con unidades mínimas, nonce y hash. Detalle propio del fork: «venció a las …» usa la hora del dispositivo y el `deadline` técnico la de la cadena, que en el fork va dos días atrás; en mainnet coinciden. `wallet-frontend-wallet` con los tests del stack también en verde. Segunda revisión independiente de los dos en curso. P20.MAN: el simulacro falló porque las consultas al monitor nunca llegaban (`WALLET no quedó OK en el monitor: undefined`, corridas `39201091145` y `39204529562`). Con el log del monitor que guarda `4e6ec3f` se vio la causa: el monitor estaba arriba y daba OK a las dos apps en cada ciclo, pero el 4190 está en la lista de "bad ports" de Fetch y el `fetch` de Node (undici) se niega a conectarse (`bad port`). Le pasaba lo mismo al backend del stack. `8c612c3` lo mueve al 4192. Con eso el monitor respondió, pero la cooperación no llegó a ACTIVE en 90 s (corrida `39205580927`). El cliente del backend sí acepta las atestaciones del monitor real (verificado en local). Revisando el registrador apareció un bug real: guardaba un latido cada 10 min, pero una atestación vale 5 min, así que con todo estable `/platform/status` (y el banner) mostraban una pausa falsa la mitad del tiempo. `09d4df6` baja el latido a 2 min, con un test nuevo. `9e9fd48` hace que el simulacro sume a los timeouts el estado público y las líneas de integridad del log del worker (redactadas). Ese diagnóstico mostró que el worker sí reanudaba (`COOPERATION_RESUMED`), pero el spec consultaba `/api/v1/api/v1/platform/status` (la URL del stack ya trae el prefijo; corregido en `f8d6f6b`). Con eso el simulacro pasa los pasos 1 a 4: monitor OK, cooperación ACTIVE, alta y envío minados con la co-firma y pausa de Recovery en ≤ 2 ciclos al alterar un asset. Se corta en el paso 5 (corrida `39208600679`): la operación enviada durante la pausa no queda con `COOPERATION_PAUSED`. Causa probable y brecha real: el worker reutilizaba por 10 s las atestaciones del monitor, así que una co-firma justo después de la detección viajaba con el OK anterior, todavía vigente para el signer (≤ 5 min). `948c5c8` pide atestaciones frescas en cada co-firma (si el monitor no responde, las últimas obtenidas, y el signer decide por vencimiento), con un test nuevo. `e7c3486` suma al diagnóstico el estado de la operación y los logs de integridad del signer. **P20.MAN APROBADO (2026-10-19, agente; `wallet-review-tours` corrida `39210751007` sobre `e7c3486`, con el stack local completo de `scripts/stack` en un runner de GitHub, R-14):** monitor real cada 5 s contra Wallet y Recovery servidas con manifests firmados, signer y worker con `INTEGRITY_REQUIRED=true`. Cooperación ACTIVE, alta en la whitelist y envío minados con la co-firma. Al alterar `assets/AlertController-Cl_qBprF.js` de Recovery, la pausa llegó a los 2,0 s (≤ 2 ciclos). La operación enviada durante la pausa quedó retenida con `COOPERATION_PAUSED` y sin tx, `/platform/status` informó PAUSED y Wallet mostró el aviso (captura `aviso-de-pausa.png`). Con el archivo restaurado, el chequeo volvió a OK pero la pausa siguió hasta que aprobaron dos operadores distintos (ana y beto, release `recovery-ci-e7c3486ca72c`). Después, la misma operación se ejecutó sola (MINED, tx `0x7af4bd14886e568824398ca4900c1651649b9df5388161dc564c3e0cf1fa090b`) y la cooperación volvió a ACTIVE. Evidencia en el artefacto `review-wallet-0-39210751007`: `report.json`, la captura y el log del monitor. `wallet-backend` en verde sobre el mismo commit. |
| 2026-10-19 | Bloqueo: credenciales de Google de los tests reales (H-01) | Esperando acción del owner | `7cef08d` | A las 09:00 los dos refresh tokens del cliente `drive-tests` (proyecto `mtw-wallet-local`) responden `invalid_grant: Token has been expired or revoked`: `GOOGLE_DRIVE_TEST_REFRESH_TOKEN` (Drive real) y `EMAIL_TEST_GOOGLE_REFRESH_TOKEN` (Gmail de la casilla de prueba). A las 06:20 los tests de Drive real todavía pasaban en `ci:local`. Efecto: `wallet-backend` en GitHub (`4c7d13a`) pasa los 108 archivos y 1167 tests, pero falla el proyecto `live` (entrega real de email); también van a fallar los tests de Drive real de `ci:local` y de CI, y quedan bloqueados P22.T04 y P22.T06. Pedido al owner, con los pasos de `docs/SETUP_EXTERNAL_SERVICES.md`: confirmar que la app esté publicada (*In production*; en *Testing* Google vence los tokens a los 7 días) y regenerar los dos tokens en OAuth Playground, uno por scope, en `wallet/.env`. El agente los valida sin mostrarlos (PF-30/PF-31) y actualiza los secrets de GitHub. `7cef08d`: el test de email real ya no tapa la causa con un error del `afterAll`. Lo demás sigue sin esperar (P17.MAN). `pnpm ci:local` sobre `d8185bb` (P17/P18 integrados): todo en verde salvo los dos tests de Drive real (`test:drive-live` de Wallet y Recovery, `400 invalid_grant`). Docs, contratos (290/290 y 273 + 2 omitidos), backend 1167, signer 355, integrity-monitor 34, Wallet 521 unitarios, Recovery 259, sovereign-exit 36 y su E2E, repro-build y security pasaron: no hay regresiones ajenas a Google. |
| 2026-10-19 | **PAUSA (pedido del owner) — dónde estamos** | En pausa hasta que el owner renueve los tokens de Google | `cc0d4c5` | **Estado:** P00–P21 en `[x]` salvo **P17.MAN**; P22–P30 sin empezar (P22 no arranca hasta cerrar P17.MAN). Las correcciones de P17.MAN están integradas y pusheadas: dos revisiones independientes, la revisión de seguridad de ADR-033 con sus arreglos y la regla de «ningún texto del backend» en las dos apps. Falta repetir el recorrido de onboarding (Chromium y Firefox, ahora a través de la app Recovery) y la tercera revisión independiente, pero el recorrido pasa por el paso real de Drive. **Bloqueo:** vencieron los refresh tokens `GOOGLE_DRIVE_TEST_REFRESH_TOKEN` (PF-30) y `EMAIL_TEST_GOOGLE_REFRESH_TOKEN` (PF-31). El preflight de red del 2026-10-19 da todo lo demás OK (BASE_RPC_URL, BASE_RPC_URL_SECONDARY, WalletConnect, clientes OAuth de Wallet y Recovery, Mailgun y Etherscan). **Al retomar, en orden:** (1) validar los tokens sin mostrarlos y actualizar los secrets de GitHub (`EMAIL_TEST_*` en `wallet-ci-backend` y `wallet-ci-e2e`; `GOOGLE_DRIVE_TEST_*` en `wallet-ci-e2e`, `wallet-ci-frontend-wallet` y `wallet-ci-frontend-recovery`); (2) revisar el CI de `cc0d4c5`, que quedó lanzado (backend con los tests nuevos de rechazo y cuarentena; frontends con stack); (3) relanzar el recorrido de onboarding y hacer la tercera revisión independiente de P17.MAN; (4) si aprueba, marcar P17.MAN y correr `pnpm ci:local` completo sobre el HEAD; (5) recién ahí, P22. |
| 2026-10-24 | **PAUSA — reevaluación** | Sigue en pausa: los tokens de Google siguen vencidos | `f15a4cf` | Los dos refresh tokens del cliente `drive-tests` siguen dando `invalid_grant` (`pnpm preflight --only PF-30,PF-31`). `wallet/.env` no cambió desde el 2026-10-19 y los secrets de GitHub, desde el 2026-10-17. Paso (2) del retome, hecho: en el CI de `cc0d4c5` lo único que falla son los tests live que dependen de Google. En wallet-backend pasan los 109 archivos y 1181 tests y el build, y falla el proyecto `live` (Gmail `invalid_grant`, más la cuota diaria del sandbox de Mailgun, que se renovó el 2026-10-20 04:17 UTC). En wallet-frontend-wallet (531 tests unitarios) y wallet-frontend-recovery (261), `test:drive-live` da `400 invalid_grant` y corta el script. Por eso build, `test:browser` con el stack, SBOM, la regla de dependencias comunes y, en Wallet, la medición de Argon2id no corrieron en GitHub sobre ese commit: quedan para el `ci:local` del paso (4). wallet-contracts, wallet-signer, wallet-security, wallet-repro-build y wallet-sovereign-exit, en verde. El owner decidió no avanzar P22 en paralelo: la pausa sigue hasta que renueve los tokens con los pasos de `SETUP_EXTERNAL_SERVICES.md` (publicar la app y regenerar los dos tokens, uno por scope). Al retomar siguen los pasos (1), (3), (4) y (5) de la fila anterior. |
| 2026-10-25 | **Retome tras la pausa — P17.MAN** | Bloqueado: los tests revocaron los tokens nuevos (corregido); esperando que el owner los regenere | `dda93ba`, `a9a0658`, `8dfbe1e`, `c91a2f7`, `5b7d181` | El owner renovó los dos refresh tokens del cliente `drive-tests`: PF-30 y PF-31 en PASS, validados por el owner y por el agente sin mostrar valores. Secrets actualizados en `wallet-ci-backend`, `wallet-ci-e2e`, `wallet-ci-frontend-wallet` y `wallet-ci-frontend-recovery`. Google informaba `refresh_token_expires_in` ≈ 7 días: la app sigue en *Testing*. Re-ejecutados los jobs de `cc0d4c5` que habían fallado por Google, más el recorrido de onboarding sobre `dda93ba` (corrida `40172770770`). Resultado: wallet-frontend-wallet en verde completo, con Drive real, build, `test:browser` con el stack, SBOM y Argon2id (attempt 2). wallet-backend falló antes de los tests: el deploy del setup global no obtuvo respuesta del Anvil del runner (`operation timed out`, cuatro jobs pesados contra el mismo RPC). `a9a0658` reintenta ese deploy una vez con un Anvil nuevo ante fallas de red del fork, igual que `scripts/stack/stack.mjs`. wallet-frontend-recovery y el recorrido fallaron porque a las 07:44 UTC los tokens ya daban `invalid_grant` («expired or revoked»), apenas 25 minutos después de emitidos. **Causa raíz, que también explica la caída del 2026-10-19:** no fue un vencimiento. Las dos apps revocan el token de Drive en Google al cerrar sesión, y Recovery también al bloquear ([F-DRV-01], `src/drive/token.ts`). Los tests de navegador le entregan a la app un access token real de la cuenta de prueba (`answerGoogleConsent`) y no interceptaban esa revocación. Revocar un access token revoca su refresh token y el permiso entero del cliente para esa cuenta: por eso cayeron juntos Drive y Gmail, aunque el de Gmail no se usó. El 2026-10-19 coincidió con el recorrido nuevo a través de Recovery (`a224cae..4c7d13a`); hoy, con los tests de stack de Recovery y el recorrido. El diagnóstico anterior («vencieron por *Testing*») queda corregido. **Corrección (`8dfbe1e`):** `answerGoogleConsent` (Wallet y Recovery) intercepta `POST https://oauth2.googleapis.com/revoke` en todo el contexto, registra el token y responde como Google. El canary de Wallet y el enrollment de Recovery verifican que la app revoca exactamente ese token al cerrar sesión, y que antes no lo revocó. `test:drive-live` de las dos apps prueba contra el endpoint real que el pedido de revocación tiene el formato correcto, usando un token inválido: 400 `invalid_token`, mientras que un pedido mal armado da `invalid_request`. Verificado en local: la función real de las dos apps contra Google responde `invalid_token`; la intercepción atrapa el `fetch` keepalive en Chromium y en Firefox sin que salga nada a Google; lint, typecheck y unitarios en verde (Wallet 531, Recovery 261). `c91a2f7`: CI vuelve a correr `test:drive-live` después de `test:browser`, así una revocación futura hace fallar la corrida que la causa. `5b7d181`: advertencia en `SETUP_EXTERNAL_SERVICES.md`. **Pendiente del owner:** publicar la app (*Audience → Publish app*) y regenerar los dos tokens. Después: secrets, recorrido de onboarding, tercera revisión independiente, `ci:local` y P22. |
| 2026-10-25 | Mantenimiento: advisories de OSV, versiones de la tabla y CI | En curso: `fast-uri` espera la edad mínima (2026-10-26 23:05 UTC); `viem` de Recovery desde el 2026-10-28 | `a9a0658`, `6e19ae3`, `11e58be`, `6cd4c34`, `3b4f222`, `1e1f747`, `cec1b3c`, `93c49ee` | Mientras se esperan los tokens, en `5b7d181` fallaron dos workflows que no usan Google. (1) **wallet-contracts:** el deploy sobre el Anvil efímero no obtuvo respuesta de Anvil (`Failed to fetch fee history … operation timed out`), la misma falla de red del fork que había tenido el setup del backend. `6e19ae3` reintenta `deploy-ephemeral.sh` una vez con un Anvil nuevo ante fallas de red del fork, igual que `stack.mjs` y que el setup global del backend (`a9a0658`, ya en verde en GitHub sobre `5b7d181`). Verificado: el deploy local contra el fork real da `VerifyDeployment OK` (123 verificaciones), y la simulación con un `deploy-core` falso reintenta una falla transitoria, falla si se repite y no reintenta las demás, sin dejar procesos. (2) **wallet-security:** OSV-Scanner encontró advisories publicados después de fijar las versiones: zod GHSA-mrhx-c7xc-m3w5 (8.2), undici (7.5 y 5.9), nodemailer (6.5), ip-address (6.3), fast-uri (hasta 6.1) y fastify (3.7). `11e58be` aplica las correcciones elegibles por la política de 7 días (zod 4.6.7, undici 8.12.2, ip-address 10.7.4, fastify 5.12.7). En Recovery, un override fuerza zod 4.6.7 sobre las copias 3.x del stack de WalletConnect (`@reown/appkit-wallet`, `@coinbase/cdp-sdk`), que no tienen versión corregida; esos paquetes sólo usan APIs que zod 4 mantiene. Como es el primer cambio de dependencias desde que se habilitaron, se adoptan las versiones de la tabla de `VERSIONS.md` en los cinco proyectos, incluido `@playwright/test` 1.64.1 con su imagen fijada por digest. Por [F-SEC-09], `viem` sube sólo en Wallet; Recovery lo hace después de 72 h (check de CI en OK). Verificado en local: lint y typecheck de los cinco proyectos. Tests de integrity-monitor (34), signer (355), backend (109 archivos, 1181 tests), Wallet (531) y Recovery (261). Builds. Specs de navegador sin stack en Chromium (Wallet 15, Recovery 16). Política de pnpm, `check-docs` y el test de `VERSIONS.md`. Firefox y WebKit con la imagen 1.64.1 quedan para cuando termine de bajar (MCR cortó la primera descarga). Pendiente por edad mínima, sin excepción a la política: nodemailer 10.1.4 desde el 2026-10-25 11:59 UTC y fast-uri 3.1.9/4.2.3 desde el 2026-10-26 23:05 UTC; hasta entonces OSV-Scanner sigue fallando por ellos. Además, el daemon de Docker rootless no había vuelto a arrancar después del reinicio de WSL del 2026-10-24: se levantó con `~/bin/dockerd-rootless.sh`, igual que la auto-remediación del preflight. **Después, sobre `11e58be`:** wallet-backend y wallet-signer en verde en GitHub; el signer, en el reintento, porque el primer intento cayó por la misma falla de red del fork. wallet-frontend-recovery se cortaba antes de Drive, en el deploy efímero, y fallaba también al reintentar. Causa medida: el broadcast EIP-1559 de forge estima los fees con `eth_feeHistory` de los últimos 10 bloques; recién arrancado el fork, ese rango es anterior al fork, Anvil se lo pide al RPC de Base y forge corta a los 45 s. En un fork de prueba tardó 8 s y volvió con error. `6cd4c34`: `deploy-core` mina 10 bloques propios antes del broadcast, y la misma consulta responde en 40 ms con bloques locales. Además, forge espera hasta 300 s las lecturas que sí van a Base. Deploy local completo en verde. `3b4f222`: el test que garantiza que CI sólo transmite al Anvil efímero acepta el deploy con reintento y además rechaza cualquier otro valor para el RPC; se había roto con `6e19ae3` (17/17 en verde). `1e1f747`: nodemailer 10.1.4 apenas cumplió los 7 días (lint, typecheck y los 121 tests de email del backend en verde): OSV queda pendiente sólo de `fast-uri`. `pnpm audit --prod`, Semgrep y zizmor, corridos en local: sólo marcan lo pendiente de edad. Firefox y WebKit con la imagen 1.64.1: MCR corta la descarga, se reintenta. **Más fallas de red del fork en CI, ahora absorbidas por los tests:** `cec1b3c`: en el test de quórum del signer, el segundo nodo forkea del primero y usaba el timeout por defecto. Ahora reintenta con 180 s y el precalentamiento va nodo por nodo; signer en verde en GitHub y 355/355 en local. `93c49ee`: `signAndExecute` (backend) corría el pipeline una sola vez y exigía MINED. Ante `RPC_UNAVAILABLE`, `RPC_TIMEOUT` o `SIGNER_UNAVAILABLE` ahora deja que el scheduler real la reencole al vencer el backoff, como en producción; cualquier otro resultado falla enseguida y muestra `last_error_code`. Los diez archivos que lo usan, en verde en local (47 tests). |

### 13.1 Fuera del planner: despliegue final y servicios

Para ejecutar el planner de punta a punta sólo hace falta lo de `wallet/.env` (H-01; desde el 2026-10-19 hay que renovar los dos refresh tokens de Google). Todo lo demás es el despliegue final, manual, guiado por `docs/runbooks/go-live.md` (P30.T06):

| ID | Acción | Cuándo | Estado |
|---|---|---|---|
| H-01 | Credenciales de los tests contra servicios reales: `GOOGLE_DRIVE_TEST_CLIENT_ID`, `GOOGLE_DRIVE_TEST_CLIENT_SECRET`, `GOOGLE_DRIVE_TEST_REFRESH_TOKEN`, `EMAIL_TEST_ADDRESS`, `EMAIL_TEST_GOOGLE_CLIENT_ID`, `EMAIL_TEST_GOOGLE_CLIENT_SECRET` y `EMAIL_TEST_GOOGLE_REFRESH_TOKEN` (pasos en `SETUP_EXTERNAL_SERVICES.md`) | antes de P00 | Renovar: provistas y validadas el 2026-10-17; los dos refresh tokens vencieron el 2026-10-19 (filas «Bloqueo» y «PAUSA» de §13) |
| H-02 | Dominios de Wallet y Recovery. Decisión del owner (2026-10-17): subdominios que apuntan a servidores distintos (ADR-010). Gate de CF-11: dominios registrables con cuentas de DNS distintas para Wallet y Recovery, o la aceptación escrita del owner de RR-11 (con una sola cuenta de DNS, quien la controle puede redirigir ambas apps); sin cambios de código en ninguno de los dos casos | despliegue final | Pendiente |
| H-03 | Servicios de staging/producción para esos dominios: clientes Google OAuth (publicación con verificación de marca), proyectos Reown, apps de Alchemy y endpoints de QuickNode por componente, Mailgun (dominio de envío propio por entorno verificado con SPF/DKIM) y `ALERT_EMAIL` | despliegue final | Pendiente |
| H-04 | Claves reales para Base mainnet (deployer, owners de la Governance Safe —hardware wallets recomendadas— y guardianes independientes); nunca las de ensayo del fork | despliegue final | Pendiente |
| H-05 | Aprobación escrita del owner y ETH real para el deploy y el gas tank | despliegue final | Pendiente |
| H-06 | Servidores: VPS del backend y servidores de Wallet y de Recovery (distintos entre sí, en cuentas de hosting distintas, CF-11), DNS, reverse proxy y TLS de cada uno, custodia offline de las credenciales de desbloqueo del signer (dos custodios) y destino off-host de los backups | despliegue final | Pendiente |

Ya resuelto: credenciales de local provistas el 2026-10-17 (`BASE_RPC_URL`, `BASE_RPC_URL_SECONDARY`, `WALLETCONNECT_PROJECT_ID`, `GOOGLE_CLIENT_ID_WALLET`, `GOOGLE_CLIENT_ID_RECOVERY`, `ETHERSCAN_API_KEY` y Mailgun con dominio sandbox); CI usa la misma `BASE_RPC_URL` como secret; claves de ensayo de staging/producción generadas por el agente en `~/.config/mtw/` (fuera del repo); push del tag de release aprobado (2026-10-17); archivos de CI en la raíz aprobados (2026-10-16); representación de USDT verificada (§3.3); separación física de repositorios (no bloqueante, P26.T17.b); toolchain con auto-remediación (P00); sin dependencias cloud.
