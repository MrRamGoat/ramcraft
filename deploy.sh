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

# .env is gitignored, so a fresh clone has none. A local one travels with the
# source; otherwise the one already on the host is kept. Wiping it on redeploy
# is what silently reverted the stack to placeholder addresses.
if [ -f "$HERE/.env" ]; then
  echo "using the local .env"
else
  echo "no local .env - keeping the one in $DEST"
fi

# The directory's contents, not the directory, so the clone's folder name
# does not have to match $DEST.
tar czf /tmp/ramcraft.tar.gz -C "$HERE" .
scp -q /tmp/ramcraft.tar.gz "$HOST:/tmp/ramcraft.tar.gz"

if [ -n "$CT" ]; then
  run() { ssh "$HOST" "pct exec $CT -- bash -c '$1'"; }
  ssh "$HOST" "pct push $CT /tmp/ramcraft.tar.gz /root/ramcraft.tar.gz"
  SRC=/root/ramcraft.tar.gz
else
  run() { ssh "$HOST" "bash -c '$1'"; }
  SRC=/tmp/ramcraft.tar.gz
fi

# Unpack beside the live copy and swap only once .env is in place, so a
# missing .env aborts here and leaves the running deployment untouched.
NEW="$DEST.new"
run "rm -rf $NEW && mkdir -p $NEW && tar xzf $SRC -C $NEW \
  && if [ ! -f $NEW/.env ] && [ -f $DEST/.env ]; then cp $DEST/.env $NEW/.env; fi \
  && if [ ! -f $NEW/.env ]; then echo \"no .env here or in $DEST - copy .env.example to .env and fill it in\" >&2; exit 1; fi \
  && rm -rf $DEST && mv $NEW $DEST && chown -R root:root $DEST"
run "cd $DEST && docker compose up -d --build"

echo "deployed"
