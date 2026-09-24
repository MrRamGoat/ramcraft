#!/usr/bin/env bash
#
# Push this source to a remote host and rebuild there.
#
# This is how I deploy to a Proxmox LXC; adapt or ignore it. If you run
# RamCraft on the machine you edit it on, you do not need this at all -
# `docker compose up -d --build` is the whole story.
#
#   RAMCRAFT_SSH_HOST   ssh target that can run the commands  (default: pve)
#   RAMCRAFT_CT_ID      Proxmox container id; empty = run directly over ssh
#   RAMCRAFT_DEST       where the source lands  (default: /opt/ramcraft)
#
# Always rebuilds: the image bakes the source in with COPY, so a plain
# --force-recreate silently keeps running the old code.
set -euo pipefail

HOST="${RAMCRAFT_SSH_HOST:-pve}"
CT="${RAMCRAFT_CT_ID:-105}"
DEST="${RAMCRAFT_DEST:-/opt/ramcraft}"

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$HERE")"
cd "$HERE/.."

# .env is gitignored but must travel with the source - it holds the addresses.
tar czf /tmp/ramcraft.tar.gz "$NAME"
scp -q /tmp/ramcraft.tar.gz "$HOST:/tmp/ramcraft.tar.gz"

if [ -n "$CT" ]; then
  run() { ssh "$HOST" "pct exec $CT -- bash -c '$1'"; }
  ssh "$HOST" "pct push $CT /tmp/ramcraft.tar.gz /root/ramcraft.tar.gz"
  SRC=/root/ramcraft.tar.gz
else
  run() { ssh "$HOST" "bash -c '$1'"; }
  SRC=/tmp/ramcraft.tar.gz
fi

run "mkdir -p $(dirname "$DEST") && cd $(dirname "$DEST") && rm -rf $NAME && tar xzf $SRC && chown -R root:root $NAME"
run "cd $DEST && docker compose up -d --build"

echo "deployed"
