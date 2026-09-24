#!/bin/sh
# Split DNS for RamCraft.
#
# The house router has no NAT loopback, so from inside, the public hostname
# resolves to the WAN IP and the connection dies at the router. This answers
# the RamCraft domain with the box's LAN address instead, so the SAME address
# works indoors and out - mc-router still reads the hostname from the Minecraft
# handshake and picks the right server exactly as it does for outside players.
set -eu

DOMAIN="${RAMCRAFT_ROUTER_DOMAIN:-mc.ramflix.xyz}"
TARGET="${RAMCRAFT_LAN_HOST:-192.168.1.63}"
UPSTREAM1="${RAMCRAFT_DNS_UPSTREAM1:-1.1.1.1}"
UPSTREAM2="${RAMCRAFT_DNS_UPSTREAM2:-8.8.8.8}"

cat > /etc/dnsmasq.conf <<CONF
# Wildcard: matches ${DOMAIN} and every name under it.
address=/${DOMAIN}/${TARGET}

# Everything else is forwarded untouched.
no-resolv
server=${UPSTREAM1}
server=${UPSTREAM2}

domain-needed
bogus-priv
no-hosts
cache-size=1000
log-queries=no
CONF

echo "ramcraft-dns: *.${DOMAIN} -> ${TARGET}, forwarding to ${UPSTREAM1} ${UPSTREAM2}"
exec dnsmasq -k -C /etc/dnsmasq.conf
