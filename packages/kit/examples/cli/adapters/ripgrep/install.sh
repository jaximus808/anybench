#!/usr/bin/env bash
# L1 install: runs once at snapshot build. Installs the pinned ripgrep 14.1.1 release binary for
# this machine's arch, checked against the sha256 published next to it on the release.
set -euo pipefail
case "$(uname -m)" in
  x86_64 | amd64)
    asset=ripgrep-14.1.1-x86_64-unknown-linux-musl
    sha=4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e
    ;;
  aarch64 | arm64)
    asset=ripgrep-14.1.1-aarch64-unknown-linux-gnu
    sha=c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f
    ;;
  *) echo "install.sh: no ripgrep 14.1.1 build for $(uname -m)" >&2; exit 1 ;;
esac
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/rg.tar.gz" "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/$asset.tar.gz"
echo "$sha  $tmp/rg.tar.gz" | sha256sum -c - > /dev/null
tar -xzf "$tmp/rg.tar.gz" -C "$tmp"
install -m 0755 "$tmp/$asset/rg" /usr/local/bin/rg
