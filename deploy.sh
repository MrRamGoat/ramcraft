#!/usr/bin/env bash
# Push the panel source from the workstation into LXC 105 and rebuild it.
# The image bakes the source in (COPY . .), so a rebuild is always required -
# a plain --force-recreate silently reuses the previous code.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."
tar czf /tmp/ramcraft.tar.gz ramcraft
scp -q /tmp/ramcraft.tar.gz pve:/tmp/ramcraft.tar.gz
ssh pve "pct push 105 /tmp/ramcraft.tar.gz /root/ramcraft.tar.gz"
ssh pve "pct exec 105 -- bash -c 'cd /opt && rm -rf ramcraft && tar xzf /root/ramcraft.tar.gz && chown -R root:root ramcraft'"
ssh pve "pct exec 105 -- bash -c 'cd /opt/ramcraft && docker compose up -d --build'"
echo "deployed - http://192.168.1.63:8110"
