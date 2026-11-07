# Shared helpers for recipe scripts (bash). Sourced as `. "$RECIPE_LIB"` after
# `set -euo pipefail`. Every function keeps its variables `local`, so it never clobbers the
# calling script's (a `dest=` here once overwrote install.sh's own `dest`).
# The runner sets RECIPE_NAME, RECIPE_VERSION, RECIPE_ARCH (x64|arm64), RECIPE_DIR, RECIPE_LIB,
# and RECIPE_URL / RECIPE_SHA256 when recipe.json pins a download for this arch.

# Everything a recipe installs system-wide lives under here, one dir per name@version.
ANYBENCH_OPT=/opt/anybench

log() { printf '[%s] %s\n' "${RECIPE_NAME:-recipe}" "$*" >&2; }
die() { log "error: $*"; exit 1; }

# Run as root: directly when we are root (docker-local exec), else through passwordless sudo.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo -n -E "$@"
  else die "need root for: $* (not root and no sudo)"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# apt-get with a once-per-hour index refresh. Fails clearly on a non-apt OS.
APT_STAMP=/var/lib/apt/periodic/anybench-update-stamp
apt_install() {
  have apt-get || die "this recipe needs apt-get (Debian/Ubuntu); found none"
  if [ ! -f "$APT_STAMP" ] || [ -n "$(find "$APT_STAMP" -mmin +60 2>/dev/null)" ]; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    as_root mkdir -p "$(dirname "$APT_STAMP")"
    as_root touch "$APT_STAMP"
  fi
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
}

# Install apt packages only when one of the named commands is missing.
# usage: need_cmds "curl:curl ca-certificates" "xz:xz-utils"
need_cmds() {
  local pkgs="" spec cmd p
  for spec in "$@"; do
    cmd=${spec%%:*}; p=${spec#*:}
    have "$cmd" || pkgs="$pkgs $p"
  done
  # ca-certificates has no command; make sure TLS roots exist whenever we fetch.
  [ -s /etc/ssl/certs/ca-certificates.crt ] || pkgs="$pkgs ca-certificates"
  # shellcheck disable=SC2086
  [ -z "$pkgs" ] || apt_install $pkgs
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# fetch_verified <url> <sha256> <dest>: download over https and refuse a checksum mismatch.
fetch_verified() {
  local url=$1 want=$2 dest=$3 got
  [ -n "$url" ] && [ -n "$want" ] || die "no pinned download for ${RECIPE_ARCH:-this arch}"
  need_cmds "curl:curl"
  log "fetching $url"
  curl -fsSL --retry 3 --retry-delay 2 --proto '=https' --tlsv1.2 -o "$dest.part" "$url"
  got=$(sha256_of "$dest.part")
  if [ "$got" != "$want" ]; then
    rm -f "$dest.part"
    die "sha256 mismatch for $url: want $want, got $got"
  fi
  mv "$dest.part" "$dest"
  log "sha256 ok $want"
}

# A scratch dir removed on exit.
scratch() {
  SCRATCH=$(mktemp -d)
  trap 'rm -rf "$SCRATCH"' EXIT
}

# link_bin <target> <name>: /usr/local/bin/<name> -> target
link_bin() { as_root ln -sfn "$1" "/usr/local/bin/$2"; }

# expect_eq <what> <want> <got>
expect_eq() { [ "$2" = "$3" ] || die "$1: want '$2', got '$3'"; }
