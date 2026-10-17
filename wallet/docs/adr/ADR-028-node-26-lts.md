# ADR-028 — Runtime Node 26 LTS

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-028), §0.1 (R-10), §1, §3.5 (Node 26 y Corepack), §3.6, P00.T01, P01.T02, P26.T17.d; prompt §5

## Contexto

El prompt §5 prohíbe fijar versiones de memoria y pide verificar las versiones estables vigentes en fuentes oficiales antes de fijarlas exactas (también R-10). La máquina de desarrollo inspeccionada tenía Node v22.22.1 (§1).

Hechos verificados el 2026-10-16 (§3.6): la línea Node 26 estaba en 26.12.0, pasa a LTS el 2026-10-28 y tiene EOL el 2029-04-30; Node 24 (24.22.0) entra en Maintenance el 2026-10-20. La documentación de Corepack existe para Node 24 y no para Node 26: Corepack dejó de distribuirse con Node a partir de la línea 25 (§3.5).

## Decisión

Runtime **Node 26 LTS** (LTS desde el 2026-10-28, EOL el 2029-04-30) para el backend, el signer, el integrity monitor, el tooling y las imágenes.

Detalle:

- `wallet/.node-version` contiene la versión exacta de Node 26: 26.12.0, o la primera 26.x LTS si ya fue publicada (P00.T01); `wallet/package.json` declara `"engines": {"node": "<versión exacta de .node-version>"}`.
- pnpm 12.14.0 se instala con el npm del Node fijado, porque Node 26 no incluye Corepack (ADR-032).
- La versión se re-verifica contra fuentes oficiales y se fija en `docs/VERSIONS.md` y en `scripts/preflight.d/versions.json` (P01.T01, P01.T02).

## Alternativas consideradas

- **Node 24:** descartado; entra en Maintenance el 2026-10-20, y un proyecto nuevo arranca en la línea con mayor ventana de soporte (§4).

## Consecuencias

- El proyecto queda en la línea con mayor ventana de soporte (hasta el 2029-04-30).
- A la fecha de la decisión Node 26 todavía no es LTS (pasa a serlo el 2026-10-28): `.node-version` arranca en 26.12.0 y se actualiza a la primera 26.x LTS cuando esté publicada, registrando el motivo si cambia (P00.T01, P01.T01).
- Sin Corepack, pnpm se instala y verifica por el toolchain local del proyecto (ADR-032).
- Antes de producción se exige Node 26 LTS fijado en todos los proyectos e imágenes (P26.T17.d).

## Verificación

- P00.T01 — `wallet/.node-version` y `scripts/preflight.d/versions.json` con la versión exacta.
- P00.T01.a — `scripts/tools/bootstrap` instala Node 26 desde el tarball oficial verificado con `SHASUMS256.txt` y `node -v` devuelve exactamente la versión fijada.
- Check de preflight PF-02 — Node igual a `.node-version`, con auto-remediación por bootstrap.
- P01.T01 y P01.T02 — versiones exactas en `docs/VERSIONS.md` y `.node-version` confirmada (Node 26 LTS exacta).
- P26.T17.d — gate: Node 26 LTS fijado en todos los proyectos e imágenes.
- Trazabilidad: RQ-21.
