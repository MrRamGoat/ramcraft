#!/usr/bin/env python3
"""Minecraft Server List Ping - used to prove hostname routing really works.

Connects the way a real client does: the handshake carries the hostname that
was dialled, which is exactly what mc-router reads to choose a backend.

Usage: python3 mcping.py <router-host> <port> <hostname-to-claim>
"""
import json
import socket
import struct
import sys


def varint(value: int) -> bytes:
    out = b""
    while True:
        byte = value & 0x7F
        value >>= 7
        out += struct.pack("B", byte | (0x80 if value else 0))
        if not value:
            return out


def read_varint(sock) -> int:
    num = shift = 0
    for _ in range(5):
        (b,) = struct.unpack("B", sock.recv(1))
        num |= (b & 0x7F) << shift
        if not b & 0x80:
            return num
        shift += 7
    raise ValueError("varint too long")


def packet(pid: int, payload: bytes) -> bytes:
    body = varint(pid) + payload
    return varint(len(body)) + body


def ping(router_host: str, port: int, claim_host: str, timeout: float = 10.0) -> dict:
    with socket.create_connection((router_host, port), timeout=timeout) as s:
        s.settimeout(timeout)
        addr = claim_host.encode("utf-8")
        handshake = (
            varint(767)                       # protocol version (1.21.x)
            + varint(len(addr)) + addr        # the hostname the "client" dialled
            + struct.pack(">H", 25565)        # port field
            + varint(1)                       # next state: status
        )
        s.sendall(packet(0x00, handshake))
        s.sendall(packet(0x00, b""))          # status request

        read_varint(s)                        # total length
        pid = read_varint(s)
        if pid != 0x00:
            raise ValueError(f"unexpected packet id {pid}")
        length = read_varint(s)
        buf = b""
        while len(buf) < length:
            chunk = s.recv(length - len(buf))
            if not chunk:
                break
            buf += chunk
        return json.loads(buf.decode("utf-8"))


def knock_login(router_host: str, port: int, claim_host: str, timeout: float = 10.0) -> str:
    """Start a LOGIN handshake (next state 2) rather than a status ping.

    mc-router deliberately only wakes a sleeping server on a real join - waking
    on status pings would mean every server-list refresh started every server.
    """
    with socket.create_connection((router_host, port), timeout=timeout) as s:
        s.settimeout(timeout)
        addr = claim_host.encode("utf-8")
        s.sendall(packet(0x00, (
            varint(767)
            + varint(len(addr)) + addr
            + struct.pack(">H", 25565)
            + varint(2)                       # next state: login
        )))
        name = b"RamCraftProbe"
        s.sendall(packet(0x00, varint(len(name)) + name))
        try:
            s.recv(256)
        except Exception:
            pass
    return "login handshake sent"


if __name__ == "__main__":
    if sys.argv[1] == "--wake":
        print(knock_login(sys.argv[2], int(sys.argv[3]), sys.argv[4]))
        sys.exit(0)
    host, port, claim = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    try:
        data = ping(host, port, claim)
    except Exception as e:
        print(f"FAIL  {claim} -> {type(e).__name__}: {e}")
        sys.exit(1)
    desc = data.get("description")
    if isinstance(desc, dict):
        desc = desc.get("text") or "".join(p.get("text", "") for p in desc.get("extra", []))
    players = data.get("players", {})
    print(f"OK    {claim}")
    print(f"      motd    : {desc!r}")
    print(f"      version : {data.get('version', {}).get('name')}")
    print(f"      players : {players.get('online')}/{players.get('max')}")
