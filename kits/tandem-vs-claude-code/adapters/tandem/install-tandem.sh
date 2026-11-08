#!/usr/bin/env bash
# L1 install (snapshot build), Tandem half (TDM-41): the pinned Tandem server binary and the pinned
# MCP gateway, under TANDEM_HOME (default ~/.anybench/tandem), so trials never download anything.
#
#   $TANDEM_HOME/bin/tandem                          server  (TANDEM_VERSION, GitHub release asset)
#   $TANDEM_HOME/mcp/node_modules/.bin/tandem-mcp    gateway (TANDEM_MCP_VERSION, npm)
#
# The server binary is checked against the sha256 pinned below for the default version (and against
# the release's SHA256SUMS for any other). Needs curl or node, npm, network. Idempotent.
set -euo pipefail
version="${TANDEM_VERSION:-0.2.0}"
mcp_version="${TANDEM_MCP_VERSION:-3.2.0}"
home_dir="${TANDEM_HOME:-$HOME/.anybench/tandem}"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) asset=tandem_linux_amd64 ;;
  Linux/aarch64 | Linux/arm64) asset=tandem_linux_arm64 ;;
  Darwin/arm64) asset=tandem_darwin_arm64 ;;
  Darwin/x86_64) asset=tandem_darwin_amd64 ;;
  *) echo "no Tandem release binary for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
pinned_sha() { # SHA256SUMS of release v0.2.0
  case "$1" in
    tandem_linux_amd64) echo 5f06c0e2a7d77424054435ea6c1ebba6b100baeec68ef0ef924b86715c9182a3 ;;
    tandem_linux_arm64) echo 2b5f2aaded3f992ba47884b81e7f1d69d28abdf8b80d0f137035f06b04f1626c ;;
    tandem_darwin_arm64) echo b9b983e943193b39a610a0f98a04c6e832413e27bfb36f7c8a52f730d001d0ef ;;
    tandem_darwin_amd64) echo 154d268f5c73be697c111b3150a6b71aed0ffb405cde49a4f16608762e022e3e ;;
  esac
}
fetch() { # fetch <url> <file>
  if command -v curl > /dev/null; then curl -fsSL --retry 3 -o "$2" "$1"; return; fi
  node -e 'fetch(process.argv[1]).then(async r=>{if(!r.ok)throw new Error("HTTP "+r.status);require("fs").writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(String(e));process.exit(1)})' "$1" "$2"
}
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

mkdir -p "$home_dir/bin" "$home_dir/mcp"
bin="$home_dir/bin/tandem"
base="https://github.com/jaximus808/tandem/releases/download/v$version"
if [[ -f "$home_dir/bin/VERSION" && "$(cat "$home_dir/bin/VERSION")" == "$version" && -x "$bin" ]]; then
  echo "tandem $version already installed at $bin"
else
  tmp="$(mktemp -d)"
  fetch "$base/$asset" "$tmp/$asset"
  want=""
  [[ "$version" == 0.2.0 ]] && want="$(pinned_sha "$asset")"
  if [[ -z "$want" ]]; then
    fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
    want="$(awk -v a="$asset" '$2 == a {print $1}' "$tmp/SHA256SUMS")"
  fi
  got="$(sha256 "$tmp/$asset")"
  [[ -n "$want" && "$got" == "$want" ]] || { echo "tandem $version $asset: sha256 $got, want ${want:-none}" >&2; exit 1; }
  install -m 0755 "$tmp/$asset" "$bin"
  echo "$version" > "$home_dir/bin/VERSION"
  rm -rf "$tmp"
fi

if [[ ! -x "$home_dir/mcp/node_modules/.bin/tandem-mcp" ]] \
  || [[ "$("$home_dir/mcp/node_modules/.bin/tandem-mcp" --version)" != "@jaximus/tandem-mcp $mcp_version" ]]; then
  [[ -f "$home_dir/mcp/package.json" ]] || echo '{"private":true}' > "$home_dir/mcp/package.json"
  npm install --prefix "$home_dir/mcp" --no-audit --no-fund --save-exact "@jaximus/tandem-mcp@$mcp_version"
fi
"$home_dir/mcp/node_modules/.bin/tandem-mcp" --version
