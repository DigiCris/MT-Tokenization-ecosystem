# shellcheck shell=bash
# Funciones comunes de los scripts de wallet/. Se usa con: source "$WALLET_ROOT/scripts/lib/common.sh"
# Nunca imprime valores de variables de entorno ni secretos.

WALLET_ROOT="${WALLET_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export WALLET_ROOT
WALLET_TOOLS="${WALLET_TOOLS:-$WALLET_ROOT/.tools}"
export WALLET_TOOLS
VERSIONS_JSON="$WALLET_ROOT/scripts/tools/versions.json"

if [ -t 2 ]; then _c_red=$'\033[31m'; _c_yel=$'\033[33m'; _c_grn=$'\033[32m'; _c_off=$'\033[0m'; else _c_red=; _c_yel=; _c_grn=; _c_off=; fi

info() { printf '%s\n' "$*" >&2; }
ok()   { printf '%s%s%s\n' "$_c_grn" "$*" "$_c_off" >&2; }
warn() { printf '%sWARN:%s %s\n' "$_c_yel" "$_c_off" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$_c_red" "$_c_off" "$*" >&2; exit 1; }

require_cmd() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "falta el comando '$c' en el sistema"; done
}

# Plataforma soportada por la toolchain: linux-x64 | darwin-arm64
detect_platform() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os/$arch" in
    Linux/x86_64) echo linux-x64 ;;
    Darwin/arm64) echo darwin-arm64 ;;
    *) die "plataforma no soportada: $os/$arch (soportadas: linux-x64, darwin-arm64)" ;;
  esac
}

# Lee un valor de un JSON por ruta con puntos (a.b.c). Usa python3 o, si no hay, node.
json_get() {
  local file="$1" path="$2"
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json,sys
v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    v=v[k]
print(v if not isinstance(v,(dict,list)) else json.dumps(v))' "$file" "$path"
  elif command -v node >/dev/null 2>&1; then
    node -e 'let v=require(process.argv[1]);for(const k of process.argv[2].split("."))v=v[k];console.log(typeof v==="object"?JSON.stringify(v):v)' "$file" "$path"
  else
    die "se necesita python3 o node para leer $file"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Aborta (y borra el archivo) si el SHA-256 no coincide con el esperado.
verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(sha256_of "$file")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$file"
    die "checksum inválido para $(basename "$file") (esperado ${expected:0:16}…, obtenido ${actual:0:16}…): descarga abortada"
  fi
}

# Verifica integridad SRI sha512 (formato npm "sha512-<base64>").
verify_sri_sha512() {
  local file="$1" expected="$2" actual
  actual="sha512-$(openssl dgst -sha512 -binary "$file" | openssl base64 -A)"
  if [ "$actual" != "$expected" ]; then
    rm -f "$file"
    die "integridad inválida para $(basename "$file"): descarga abortada"
  fi
}

download() {
  local url="$1" out="$2"
  mkdir -p "$(dirname "$out")"
  curl -fsSL --retry 3 --retry-delay 2 --proto '=https' --tlsv1.2 -o "$out.part" "$url" || die "no se pudo descargar $url"
  mv "$out.part" "$out"
}

# Compara versiones x.y[.z]: devuelve 0 si $1 >= $2
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}
