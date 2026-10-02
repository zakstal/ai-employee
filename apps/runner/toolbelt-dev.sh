#!/usr/bin/env bash
# Minimal toolbelt for the `dev` runner image: git, gh, ripgrep, jq, curl. Run as root.
set -euo pipefail
ARCH="${1:?usage: toolbelt-dev.sh <amd64|arm64>}"
case "$ARCH" in amd64|arm64) ;; *) echo "unsupported arch $ARCH" >&2; exit 1;; esac
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends git curl ca-certificates jq ripgrep unzip gnupg openssh-client less python3 \
  postgresql postgresql-client   # a real server, so an agent can run a throwaway DB in its workspace (see pg-scratch)
install -d -m 0755 /etc/apt/keyrings
# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y --no-install-recommends gh
apt-get clean && rm -rf /var/lib/apt/lists/*
