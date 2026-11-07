#!/usr/bin/env bash
# L1 install: runs once at snapshot build. Builds the pinned ripgrep release.
set -euo pipefail
curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz" \
  | tar -xz -C /tmp
install -m 0755 /tmp/ripgrep-14.1.1-x86_64-unknown-linux-musl/rg /usr/local/bin/rg
