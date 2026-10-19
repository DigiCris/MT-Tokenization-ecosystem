#!/usr/bin/env bash
# Entorno local desde un clon limpio (P21.MAN, P21.TST; workflow wallet-local-env): arma wallet/.env con las variables
# del owner que llegan del environment de CI (sin imprimirlas), y corre lo que haría una persona nueva:
# `docker compose up -d && pnpm install && pnpm preflight && pnpm dev`, con `pnpm dev:healthcheck` y `pnpm seed:check`.
# Después repite `pnpm dev:fresh` + `pnpm dev` y exige el mismo reporte del seed (direcciones y saldos).
source "$(dirname "$0")/lib.sh"
cd "$WALLET_ROOT"
OUT="${MTW_LOCAL_ENV_OUT:-$WALLET_ROOT/.local-env-run}"
mkdir -p "$OUT"
cp .env.example .env
node -e '
  const fs = require("node:fs");
  const names = process.argv.slice(1);
  let text = fs.readFileSync(".env", "utf8");
  for (const name of names) {
    const value = process.env[name];
    if (!value) continue;
    const line = new RegExp(`^${name}=.*$`, "m");
    text = line.test(text) ? text.replace(line, () => `${name}=${value}`) : `${text}\n${name}=${value}\n`;
  }
  fs.writeFileSync(".env", text, { mode: 0o600 });
' BASE_RPC_URL BASE_RPC_URL_SECONDARY EMAIL_PROVIDER_API_KEY EMAIL_PROVIDER_DOMAIN EMAIL_PROVIDER_BASE_URL \
  GOOGLE_CLIENT_ID_WALLET GOOGLE_CLIENT_ID_RECOVERY WALLETCONNECT_PROJECT_ID ETHERSCAN_API_KEY \
  GOOGLE_DRIVE_TEST_CLIENT_ID GOOGLE_DRIVE_TEST_CLIENT_SECRET GOOGLE_DRIVE_TEST_REFRESH_TOKEN \
  EMAIL_TEST_ADDRESS EMAIL_TEST_GOOGLE_CLIENT_ID EMAIL_TEST_GOOGLE_CLIENT_SECRET EMAIL_TEST_GOOGLE_REFRESH_TOKEN
section "pnpm secrets:local (secretos locales nuevos)"
bash scripts/secrets-local
section "docker compose up -d"
docker compose up -d --wait --wait-timeout 600
section "pnpm install (scripts/install-all.mjs)"
pnpm install
section "pnpm preflight (completo)"
bash scripts/preflight

run_dev() { # <n>
  pnpm dev:fresh
  (pnpm dev > "$OUT/dev-$1.log" 2>&1) &
  dev_pid=$!
  for _ in $(seq 1 120); do
    if grep -q "entorno local arriba" "$OUT/dev-$1.log" 2>/dev/null && pnpm -s dev:healthcheck > "$OUT/healthcheck-$1.txt" 2>&1; then break; fi
    if ! kill -0 "$dev_pid" 2>/dev/null; then tail -50 "$OUT/dev-$1.log" >&2; echo "pnpm dev terminó antes de tiempo" >&2; exit 1; fi
    sleep 10
  done
  cat "$OUT/healthcheck-$1.txt"
  grep -q "HEALTHCHECK OK" "$OUT/healthcheck-$1.txt"
  pnpm -s seed:check --report "$OUT/seed-report-$1.json"
  kill -INT "$dev_pid"; wait "$dev_pid" || true
}
section "corrida 1: dev:fresh + dev"
run_dev 1
section "corrida 2: dev:fresh + dev (mismo escenario)"
run_dev 2
diff "$OUT/seed-report-1.json" "$OUT/seed-report-2.json"
echo "LOCAL ENV OK: healthcheck y seed-check en verde en las dos corridas, mismos contratos, Safe y saldos"
