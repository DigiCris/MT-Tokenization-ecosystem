# ADR-032 — Toolchain reproducible local al proyecto

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Fuentes:** planner §4 (ADR-032), §0.1 (R-10, R-11), §1, §3.5 (Node 26 y Corepack), §3.6, P00 (P00.T01.a, P00.T05, PF-01 a PF-08), P01.T01, P01.T09; prompt §5, §25

## Contexto

El prompt §5 exige versiones exactas verificadas en fuentes oficiales, y el §25 pide un preflight que verifique Node, el package manager, Foundry (forge, cast, anvil), Docker y el resto de los binarios requeridos, y que se detenga explicando qué falta si algo obligatorio no está. R-11 agrega que, antes de frenar, hay que intentar autodiscovery y auto-remediación (por ejemplo, instalar la herramienta fijada en `wallet/.tools/`), y R-10 prohíbe fijar versiones de memoria.

La inspección del 2026-10-16 (§1) encontró en la máquina local Node v22.22.1, npm 10.9.4, pnpm 9.15.9, Foundry 1.5.1-stable, Docker 29.6.2, Slither 0.10.4, gitleaks 8.30.1 y Python 3.10, mientras que las versiones fijadas son Node 26 LTS, pnpm 12.14.0, Foundry v1.8.5, Slither 0.11.6 y gitleaks 8.30.1. Node 26 ya no incluye Corepack (§3.5).

## Decisión

Toolchain reproducible **local al proyecto** (`wallet/.tools/`, gitignored): `scripts/tools/bootstrap` instala sin sudo Node 26 (tarball oficial verificado con `SHASUMS256`), pnpm 12.14.0 (con el npm de ese Node y verificación de integridad del registry, porque Node 26 ya no trae Corepack), Foundry v1.8.5 (release oficial + `.sha256`), gitleaks 8.30.1 (release + checksums) y Slither 0.11.6 (venv de Python local, o imagen Docker fijada si no hay Python ≥ 3.10); los escáneres de seguridad corren en imágenes Docker fijadas por digest. P00 detecta, auto-remedia y verifica, y sólo frena si la remediación es imposible (Docker ausente o sin permisos, sin red, plataforma no soportada).

Detalle:

- **Instalación** (P00.T01.a): `scripts/tools/bootstrap` + `scripts/tools/versions.json` (URL oficial + SHA-256 por plataforma); `scripts/env.sh` antepone `wallet/.tools/*/bin` al `PATH` y todos los scripts del proyecto lo usan. Plataformas soportadas: linux-x64 y darwin-arm64.
- **Preflight** (P00.T05): ciclo detect → auto-remediar → verificar para el toolchain (PF-02 a PF-04, PF-06, PF-07), imágenes de seguridad faltantes con `docker pull` por digest (PF-08) y Docker Engine + Compose v2, que intenta iniciar sin sudo y es la única dependencia de sistema obligatoria (PF-05); PF-01 exige bash ≥ 4, git ≥ 2.34 (firma SSH de commits; ajustado el 2026-10-17 desde 2.40, porque ninguna función usada requiere una versión mayor), curl, openssl, tar, xz y python3 ≥ 3.10 (si falta Python, Slither usa la imagen Docker fijada); no es auto-remediable sin privilegios y, si falla, termina en STOP con la instrucción. Si todo pasa imprime exactamente `PREFLIGHT PASSED`; cada FAIL indica qué falta, la variable, cómo obtenerla y el documento interno.
- **Escáneres por imagen fijada** (§3.6): Semgrep 1.181.0, OSV-Scanner 2.7.0, zizmor 1.31.1, syft 1.54.1 y Trivy 0.76.0.
- **Versiones registradas:** `docs/VERSIONS.md` (herramienta, versión, URL, fecha, digest de imágenes) y `scripts/tools/versions.json` (P01.T01).
- **Hook de pre-commit:** lo instala `scripts/tools/bootstrap` y corre gitleaks sobre lo staged (P01.T09).

## Alternativas consideradas

- **Exigir que cada desarrollador instale a mano las versiones fijadas en su sistema:** descartado; así las versiones locales no se convierten en blockers manuales y todas las máquinas y CI usan la misma toolchain (§4).
- **Instalar pnpm con Corepack:** no es posible, porque Corepack dejó de distribuirse con Node a partir de la línea 25 (§3.5); pnpm se instala con el npm del Node fijado.

## Consecuencias

- Todas las máquinas y CI usan exactamente la misma toolchain, con descargas verificadas por checksum: una descarga alterada aborta la instalación.
- La única dependencia de sistema obligatoria es Docker (con permisos para el usuario); sin Docker, sin red o en una plataforma no soportada, el preflight frena con STOP y la instrucción concreta.
- Las plataformas soportadas quedan limitadas a linux-x64 y darwin-arm64.
- `wallet/.tools/` ocupa disco local y queda fuera del repositorio (gitignored).
- `jq` y `redis-cli` no son requisitos: el preflight usa Node y Docker (§1).

## Verificación

- P00.T01 — `wallet/package.json` de orquestación con `packageManager` `pnpm@12.14.0`, `.node-version` y `scripts/preflight.d/versions.json`.
- P00.T01.a — en un shell sin las herramientas en el `PATH`, `bootstrap` deja exactamente las versiones fijadas de Node, pnpm, forge, Slither y gitleaks; una descarga con checksum distinto aborta.
- P00.T05 y P00.T06 — preflight con detect → auto-remediar → verificar, y sus tests (`node --test scripts/preflight.d/__tests__/`).
- P00.T09 — `PREFLIGHT PASSED` registrado en §13.
- P00.TST — tests del preflight.
- P01.T01 y P01.T02 — versiones exactas en `docs/VERSIONS.md` y sincronización con `scripts/preflight.d/versions.json`.
- P01.T09 — hook de pre-commit instalado por `bootstrap` que detecta un secreto de prueba.
- Checks de preflight PF-01 a PF-08.
- Trazabilidad: RQ-96.
