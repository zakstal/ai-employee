#!/usr/bin/env bash
# `ops` runner image additions on top of `dev`: Azure CLI. Run as root.
set -euo pipefail
ARCH="${1:?usage: toolbelt-ops.sh <amd64|arm64>}"
case "$ARCH" in amd64|arm64) ;; *) echo "unsupported arch $ARCH" >&2; exit 1;; esac
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends lsb-release gnupg ca-certificates curl
install -d -m 0755 /etc/apt/keyrings
CODENAME="$(lsb_release -cs)"
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg
chmod go+r /etc/apt/keyrings/microsoft.gpg
cat > /etc/apt/sources.list.d/azure-cli.sources <<SRC
Types: deb
URIs: https://packages.microsoft.com/repos/azure-cli/
Suites: ${CODENAME}
Components: main
Architectures: ${ARCH}
Signed-by: /etc/apt/keyrings/microsoft.gpg
SRC
apt-get update && apt-get install -y --no-install-recommends azure-cli
apt-get clean && rm -rf /var/lib/apt/lists/*
