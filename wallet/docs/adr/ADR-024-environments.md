# ADR-024 — Entornos local, staging y producción

- **Estado:** Aceptada
- **Fecha:** 2026-10-16 · Actualizada: 2026-10-17 (instrucción del owner: staging y producción se despliegan y prueban completos sobre el fork durante el planner, con claves de ensayo fuera del repositorio)
- **Fuentes:** planner §4 (ADR-024), §0.1 (R-09, R-14), §6.12 ([C-SCR-04]), §13 (entrada del 2026-10-17), §13.1 (H-02 a H-05), P25, P30; prompt §37, §39

## Contexto

El prompt §37 exige separar los entornos local, staging y producción y no reutilizar entre staging y producción bases de datos, clientes OAuth, claves del signer, secretos de sesión, configuración de email ni claves de RPC. El prompt §39 pide preparar los scripts de despliegue para Base mainnet sin desplegar en mainnet durante la ejecución automática sin aprobación explícita.

R-09 establece que ninguna fase despliega en Base mainnet ni mueve fondos reales: staging y producción se despliegan y prueban completos sobre el fork de Anvil (P25 y P30), y el despliegue real es el despliegue final, manual, fuera del planner y con aprobación escrita del owner. R-14 (2026-10-17) exige un producto final sin pendientes, probado contra servicios reales, y deja fuera del planner sólo el despliegue final y la configuración de los servicios de staging y producción para los dominios reales. El registro del 2026-10-17 (§13) asienta ese cambio: staging y producción sobre el fork y claves de ensayo generadas fuera del repositorio.

Las testnets públicas no tienen USDT ni liquidez equivalentes a las de Base mainnet, mientras que el fork reproduce contratos y tokens reales (§4).

## Decisión

Entornos: `local` (fork de Anvil), `staging` y `production`. Durante la ejecución del planner, staging y producción se despliegan y prueban completos **sobre el fork** con su configuración propia (Governance Safe, guardianes, deployer y claves de policy de ensayo generados en `~/.config/mtw/`, fuera del repositorio, que nunca se reutilizan en Base mainnet). Su despliegue real (contratos en Base mainnet; servicios como proyectos Docker Compose separados en la VPS) es el despliegue final, manual y con aprobación del owner. Nada se reutiliza entre staging y producción: DB, OAuth, keystores y credenciales del signer, secretos de sesión, email, RPC ni claves de gobernanza.

Detalle:

- **Matriz de entornos** (`docs/ENVIRONMENTS.md`, P25.T01): por entorno, proyecto de Docker Compose y directorio de secrets propios, DB y volúmenes, Valkey, clientes OAuth (proyectos de Google distintos), shards del signer con keystores y credenciales de desbloqueo propios, secretos de sesión, CSRF, OPAQUE, pepper, field key y audit key, dominio de Mailgun, claves de RPC, dominios, Governance Safe, guardianes, y claves de release y de policy. Si staging y producción conviven en un mismo host, lo hacen como proyectos Compose separados (decisión de despliegue).
- **Artefactos sobre el fork:** `contracts/deployments/fork/staging.json` (P25.T06) y `contracts/deployments/fork/production.json` (P30.T02); snapshots de policy de staging y producción firmados con la clave de policy de cada entorno, generada en `~/.config/mtw/secrets/<entorno>/` (P25.T07); `system-contracts.<env>.json` para los builds de los frontends (P25.T08). Los `base-mainnet*.json` se crean en el despliegue final.
- **Script de deploy** ([C-SCR-04]): `DeployBase.s.sol` firma con keystore cifrado (`--keystore` + `--password-file`) o con hardware wallet (`--ledger`/`--trezor`), nunca con una private key en variables de entorno, y requiere `--broadcast` explícito. Durante la ejecución sólo transmite al fork; contra Base mainnet, sólo en el despliegue final, con claves nuevas y aprobación escrita del owner.
- **Claves de ensayo:** las usadas en el fork (incluidas las de `~/.config/mtw/keys/`) nunca se reutilizan en Base mainnet, porque el fork conserva el chainId 8453 y una transacción firmada en el fork sería válida en mainnet (P25.T03).
- **Configuración por entorno:** el schema de configuración depende de `APP_ENV` (`local`, `staging`, `production`); en staging y producción todo secreto se lee por `<VAR>_FILE` y se rechazan valores de ejemplo (P08.T02, ADR-030). Las herramientas sólo locales se niegan a correr fuera de local: `secrets-local` (P00.T04), `dev:session` (P10.T07), el seed (P21.SEC) y `DevelopmentSignerProvider` (P11.T01).

## Alternativas consideradas

- **Testnets públicas como staging:** descartadas; no tienen USDT ni la liquidez necesaria, y el fork de Base mainnet ofrece contratos y tokens reales (§4).
- **Desplegar staging o producción en Base mainnet durante el planner:** excluido por R-09 (ninguna fase despliega en mainnet ni mueve fondos reales).
- **Compartir configuración o secretos entre staging y producción:** prohibido por el prompt §37.

## Consecuencias

- Staging y producción se ensayan de punta a punta sobre contratos y tokens reales del fork, con su propia gobernanza y sus propias claves, antes de cualquier despliegue real.
- Las claves de ensayo se descartan en el go-live: el despliegue final usa claves nuevas para Base mainnet (hardware wallets recomendadas), Governance Safe y guardianes reales, re-firma offline del snapshot de policy, build de los frontends con los dominios reales y verificación pública en BaseScan (P30.T06, H-04).
- El riesgo de confundir claves de ensayo con claves reales se acota marcando las de ensayo como no reutilizables en mainnet y guardándolas fuera del repositorio (P25.SEC).
- Quedan fuera del planner, como acciones del despliegue final, los dominios, los servicios de staging y producción para esos dominios, las claves reales y la aprobación escrita del owner con ETH real (H-02 a H-05).

## Verificación

- P25.T01 — matriz de entornos en `docs/ENVIRONMENTS.md`, revisada por un agente revisor independiente.
- P25.T02 y P25.T03 — `DeployBase.s.sol` con JSON de deployment válido y ensayo con `VerifyDeployment.s.sol`.
- P25.T05 y P25.T06 — Governance Safe de staging en el fork y deploy de staging verificado contra `deployments/fork/staging.json`.
- P25.T07 y P25.T08 — snapshots de policy de staging y producción firmados y `system-contracts.staging.json` embebido.
- P25.TST, P25.SEC y P25.MAN — schema del JSON, RESTRICTED con el set V1, ninguna private key en env y revisión de cada transacción de deploy en el fork.
- P30.T02, P30.T03, P30.T04 y P30.T05 — deploy de producción sobre el fork, policy RESTRICTED, ensayo completo y smoke automatizado.
- P30.T06 — `go-live.md` con el despliegue final paso a paso.
- P08.T02 — configuración por `APP_ENV` con `_FILE` obligatorio en staging y producción.
- P00.SEC y P21.SEC — `secrets-local` y el seed se niegan fuera de local.
- Trazabilidad: RQ-67, RQ-69, RQ-98.
