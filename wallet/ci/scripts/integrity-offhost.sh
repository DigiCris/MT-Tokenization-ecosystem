#!/usr/bin/env bash
# Chequeo de integridad off-host (P20.T02.a; workflow wallet-integrity-offhost): las mismas verificaciones que el
# integrity monitor (`check-once` de backend/integrity-monitor) contra las URLs públicas de Wallet y Recovery, con las
# claves públicas de release del repositorio. No depende del host de producción ni pausa al signer; ante una discrepancia
# alerta por email (Mailgun) y webhook, y sale 1.
#   INTEGRITY_OFFHOST_TARGETS=WALLET=https://…,RECOVERY=https://…  (vacío: todavía no hay despliegue, no se chequea)
#   MTW_INTEGRITY_SELFTEST=1: simulacro en el runner — compila Recovery, firma su manifest con una clave efímera, la sirve
#   con `vite preview`, verifica OK, altera un archivo y exige MISMATCH con la alerta enviada.
source "$(dirname "$0")/lib.sh"
monitor="$WALLET_ROOT/backend/integrity-monitor"
section "backend/integrity-monitor: pnpm install --frozen-lockfile"
(cd "$monitor" && pnpm install --frozen-lockfile)

der_base64() { openssl pkey -pubin -in "$1" -outform DER | base64 -w0; }

if [ "${MTW_INTEGRITY_SELFTEST:-}" = 1 ]; then
  recovery="$WALLET_ROOT/frontend/recovery"
  work="$(mktemp -d)"
  trap 'kill "${preview_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
  frontend_ci_inputs
  section "simulacro: build de Recovery firmado con una clave efímera"
  (cd "$recovery" && pnpm install --frozen-lockfile && pnpm run -s build)
  openssl genpkey -algorithm ed25519 -out "$work/release.pem" 2>/dev/null
  chmod 600 "$work/release.pem"
  openssl pkey -in "$work/release.pem" -pubout -out "$work/release.pub"
  (cd "$recovery" && MTW_RELEASE_KEY_FILE="$work/release.pem" node build/sign-manifest.ts --allow-dirty)
  (cd "$recovery" && pnpm exec vite preview --port 4179 --strictPort >"$work/preview.log" 2>&1) &
  preview_pid=$!
  for _ in $(seq 1 60); do curl -fsS -o /dev/null http://localhost:4179/ && break; sleep 1; done
  export APP_ENV=local MONITOR_MANIFEST_ENVIRONMENT=ci MONITOR_TARGETS=RECOVERY=http://localhost:4179
  RECOVERY_RELEASE_PUBLIC_KEY="$(der_base64 "$work/release.pub")"
  export RECOVERY_RELEASE_PUBLIC_KEY ALERT_SOURCE="simulacro del chequeo off-host"
  section "simulacro: release intacto → OK"
  (cd "$monitor" && pnpm run -s check:once >"$work/ok.json")
  section "simulacro: un archivo alterado → MISMATCH y alerta"
  asset="$(cd "$recovery/dist" && ls assets/*.js | head -1)"
  printf '\n// alterado por el simulacro\n' >> "$recovery/dist/$asset"
  set +e
  (cd "$monitor" && pnpm run -s check:once >"$work/mismatch.json" 2>"$work/mismatch.err")
  code=$?
  set -e
  cat "$work/mismatch.err" >&2
  [ "$code" = 1 ] || { echo "simulacro: se esperaba salida 1 (MISMATCH), fue $code" >&2; exit 1; }
  grep -q '"status": "MISMATCH"' "$work/mismatch.json" || { echo "simulacro: el reporte no dice MISMATCH" >&2; exit 1; }
  grep -q "$asset: el contenido no coincide con el manifest" "$work/mismatch.json" || { echo "simulacro: no detectó $asset" >&2; exit 1; }
  grep -Eq 'alerta enviada por (email|webhook)' "$work/mismatch.err" || { echo "simulacro: la alerta no salió por ningún canal" >&2; exit 1; }
  echo "simulacro OK: MISMATCH detectado en $asset y alerta enviada"
  exit 0
fi

if [ -z "${INTEGRITY_OFFHOST_TARGETS:-}" ]; then
  echo "::notice::INTEGRITY_OFFHOST_TARGETS vacío: todavía no hay Wallet ni Recovery publicados (se configura en el despliegue final, go-live.md)"
  exit 0
fi
export APP_ENV=production MONITOR_TARGETS="$INTEGRITY_OFFHOST_TARGETS" ALERT_SOURCE="chequeo off-host programado"
WALLET_RELEASE_PUBLIC_KEY="$(der_base64 "$WALLET_ROOT/config/release-keys/wallet.pub")"
RECOVERY_RELEASE_PUBLIC_KEY="$(der_base64 "$WALLET_ROOT/config/release-keys/recovery.pub")"
export WALLET_RELEASE_PUBLIC_KEY RECOVERY_RELEASE_PUBLIC_KEY
section "chequeo de integridad contra las URLs públicas"
(cd "$monitor" && pnpm run -s check:once)
