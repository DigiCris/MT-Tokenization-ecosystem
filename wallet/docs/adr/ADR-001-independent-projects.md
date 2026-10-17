# ADR-001 — Proyectos independientes bajo `wallet/`

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-001), §0.1 (R-02, R-13), §1, §2.2, §5.1 (reglas de separación), §5.2, §7 (introducción); V9 §2, §17; prompt §1, §4 y nota final; CF-01, CF-06

## Contexto

La especificación V9 exige que los tres trust domains (Wallet → U, Recovery → R, Backend/Signer → S) sean administrativamente independientes y que Wallet y Recovery mantengan supply chains separadas, para que una única dependencia o un único pipeline no comprometa U y R a la vez (V9 §2). V9 §17 detalla esa separación: repositorio, árbol de dependencias, lockfile, runner de CI, pipeline de build, hosting/DNS, OAuth, claves de release y appDataFolder separados.

El owner, en cambio, pidió que todo el producto viva dentro de `wallet/` de este repositorio (prompt, nota final; R-02): `documentacion/` es de sólo lectura y el mock comercial de la raíz no se toca (§1). El prompt §4 exige además que `contracts/`, `backend/`, `frontend/wallet` y `frontend/recovery` estén completamente separados, que Wallet y Recovery se puedan ejecutar y desplegar por separado y que no se comparta código con acceso a U o R en runtime.

De ahí surgen dos conflictos registrados en §2.2:

- **CF-01:** V9 §17 pide repositorio separado para Wallet y Recovery; el owner pide todo en `wallet/`.
- **CF-06:** GitHub Actions sólo lee workflows desde la raíz del repositorio, mientras el owner pide todo dentro de `wallet/`.

La inspección del repositorio (§1) mostró que la raíz es un mock de UI en React + Vite con JavaScript y npm, sin requisitos de seguridad.

## Decisión

Todo el producto se construye bajo `wallet/` como **proyectos independientes**: `contracts` (Foundry), `backend/app`, `backend/signer`, `frontend/wallet`, `frontend/recovery` y `e2e`. No hay pnpm workspace común: cada proyecto tiene su propio lockfile (`pnpm-lock.yaml`, o `soldeer.lock` en contratos: Soldeer en lugar de submódulos, porque `.gitmodules` tendría que vivir en la raíz del repositorio, P03.T02). `wallet/package.json` sólo orquesta (scripts) y no declara dependencias de runtime.

Detalle de la separación (CF-01, §5.1, §5.2):

- Cada frontend tiene `package.json`, lockfile, build, workflow de CI, secretos, claves de release y proyecto de Google OAuth propios; no hay workspace compartido ni imports cruzados, y la frontera se verifica con tests.
- Lo único compartible entre frontends es look & feel estático: `wallet/frontend/design-tokens/tokens.css` (sólo CSS, sin JS), copiado en build con verificación de hash; no es una dependencia npm.
- Ningún código con acceso a U o R en runtime se comparte entre `frontend/wallet`, `frontend/recovery` y el backend: cada frontend implementa por separado su capa criptográfica mínima.
- El signer no importa código del backend: su decodificación y su política son una implementación independiente; ambos se contrastan contra los mismos vectores generados por los contratos (`wallet/contracts/test/vectors/*.json`, copiados a cada consumidor).
- El integrity monitor (`wallet/backend/integrity-monitor`) también es un proyecto propio (§7, ADR-023).
- La lógica de CI vive en `wallet/ci/` (scripts y composite actions); en la raíz sólo van `.github/workflows/wallet-*.yml` y `.github/CODEOWNERS`, aprobados por el owner el 2026-10-16 (CF-06, R-02).
- `CODEOWNERS` por trust domain y branch protection con revisión del equipo del dominio, "include administrators" y commits firmados (CF-01).
- Cada fase que crea o modifica un proyecto actualiza su script `wallet/ci/scripts/ci-<área>.sh` (R-13).

## Alternativas consideradas

- **pnpm workspace único con un lockfile compartido:** descartado, porque un lockfile común mezcla en un mismo árbol las dependencias del dominio de U y las del dominio de R, contra la separación de supply chain de V9 §17 (§4).
- **Repositorios separados para Wallet, Recovery y backend (lectura literal de V9 §17):** no se adopta en V1 por la instrucción del owner. No es blocker: antes de producción, P26.T17.b registra la evaluación de si conviene extraer repositorios (CF-01).
- **Reutilizar el código del mock de la raíz:** descartado, porque es un mock de UI sin seguridad; sólo se reutiliza la elección tecnológica (Vite + React), en TypeScript y dentro de proyectos independientes (§1).

## Consecuencias

- Cada trust domain tiene su propio árbol de dependencias y su propio pipeline: un bump en un proyecto no arrastra a los demás, y los workflows se disparan sólo por cambios en el path de su área.
- Los secretos de CI se separan por GitHub Environment y por área: el workflow de Recovery no puede leer los secretos de Wallet y viceversa (P02.T03).
- La capa criptográfica mínima queda duplicada a propósito en cada frontend y se revisa por separado; eso suma mantenimiento (lint, configuración y lockfile por proyecto, P01.T04).
- La instalación local recorre los proyectos uno por uno con su lockfile congelado (`scripts/install-all.mjs`, P21.T01).
- Una actualización de una dependencia criptográfica común (`@noble/*`, `viem`, `@scure/*`) no se publica en Wallet y Recovery en la misma ventana: mínimo 72 h entre ambos releases y aprobación de revisores de cada dominio ([F-SEC-09]).
- Riesgo residual: compartir un repositorio no da independencia administrativa total (mismos administradores de GitHub). Se compensa con `CODEOWNERS`, branch protection y commits firmados (P26.T17.a), y la decisión sobre CF-01 queda entre los riesgos residuales de la auditoría (P28.T03).

## Verificación

- P01.T03 — estructura de directorios de §5.2 (`tree -d wallet -L 2`).
- P02.T01 — workflows `wallet-*.yml` por área y `CODEOWNERS` por trust domain.
- P02.T03 — un PR de prueba dispara sólo los workflows del área tocada; secretos por Environment separado por área.
- P16.T01 — `tokens.css` copiado en build con verificación de SHA-256 (`sync-design-tokens.mjs --check`).
- P16.T02 — scaffold independiente de cada app; test de dependencias (Wallet sin wagmi).
- P16.T03 — ESLint prohíbe imports fuera del directorio de la app, salvo el CSS de tokens.
- P16.T10 — check de dependencias comunes entre lockfiles de Wallet y Recovery.
- P19.T02 — módulo `crypto/` de Recovery implementado y revisado por separado del de Wallet.
- P21.T01 — `pnpm install` en un clon limpio instala cada proyecto con su lockfile congelado.
- P26.T17.a y P26.T17.b — gates de `CODEOWNERS`/branch protection y evaluación documentada de repositorios propios.
- P28.T03 — riesgos residuales, incluida la decisión registrada sobre CF-01.
- Check de preflight PF-25 — lockfiles presentes y consistentes en cada proyecto.
- Trazabilidad: RQ-08, RQ-20, RQ-92.
