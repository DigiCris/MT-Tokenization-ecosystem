# Integrity monitor (P20)

Proyecto independiente (contenedor propio, clave de atestación propia, sin credenciales de otros componentes) que
verifica que Wallet y Recovery sirvan exactamente su release firmado y emite `IntegrityAttestation` ([W-03]) que el
backend adjunta a cada co-firma y el signer exige (`INTEGRITY_REQUIRED`). Runbook: `docs/runbooks/integrity-mismatch.md`.

## Qué verifica (cada `MONITOR_INTERVAL_SECONDS`, por app)

1. `/.well-known/release-manifest.json` y `.sig`: firma Ed25519 con la clave pública de release **fijada** de la app
   (`config/release-keys/`), manifest en JSON canónico (JCS), app y entorno esperados.
2. Cada archivo del manifest: SHA-256 y tamaño (sin seguir redirecciones).
3. El documento de `/` es el `index.html` del manifest; con parse5, cada script y cada hoja de estilo o modulepreload
   tiene `integrity` (SRI sha384) igual a su contenido, todo recurso es del mismo origin y figura en el manifest, sin
   scripts inline, manejadores `on*`, `<base>` ni contenido embebido.
4. Headers de seguridad por ruta contra `.well-known/security-headers.json` del release y 403 a los scripts de service
   worker.

Resultado: `OK`, `MISMATCH` o `UNREACHABLE`. Un `MISMATCH` pausa la app (pegajoso y persistido en `MONITOR_STATE_FILE`)
hasta que el release vuelve a verificar **y** dos operadores distintos aprueban reanudar ese release exacto (firmas
Ed25519 con claves propias fijadas en `MONITOR_OPERATOR_KEYS`, vencen a la hora).

## API interna (red `backend`, sin puertos publicados)

| Ruta | Uso |
|---|---|
| `GET /v1/attestations` | atestaciones vigentes por app (el worker del backend las adjunta a cada co-firma) |
| `GET /v1/status` | estado por app para los operadores (problemas encontrados, pausa, aprobaciones) |
| `POST /v1/resume-approvals` | aprobación de reanudación firmada por un operador (`pnpm resume:approve`) |
| `GET /health`, `GET /metrics` | health y métricas Prometheus (`mtw_integrity_status`, `mtw_integrity_paused`, …) |

## Comandos

- `pnpm start` / `pnpm dev`: el monitor (`node src/main.ts serve`).
- `pnpm check:once`: una pasada contra `MONITOR_TARGETS` con alerta por email (Mailgun) y webhook; la usa el chequeo
  off-host programado (`.github/workflows/wallet-integrity-offhost.yml`).
- `pnpm resume:approve --operator <id> --key-file <archivo> …`: aprobación de reanudación de un operador.
- `pnpm keys:generate --out <archivo>`: clave Ed25519 nueva (atestación del monitor o de un operador); la privada queda en
  un archivo 0600 y sólo se muestra la pública.
- `pnpm test` (cobertura ≥ 90 % de líneas), `pnpm lint`, `pnpm typecheck`, `pnpm build`.

La configuración (variables y `_FILE`) está documentada al principio de `src/config.ts`.
