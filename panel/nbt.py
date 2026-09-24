"""Just enough NBT to write a Minecraft servers.dat.

Why this exists: a client pack that installs the right mods still leaves the
player typing an address into Multiplayer. Shipping a servers.dat inside the
pack's overrides/ means the server is already in their list when the pack
finishes installing - install, open Minecraft, click the server, play.

servers.dat is UNCOMPRESSED NBT (unlike level.dat, which is gzipped), big
endian throughout.
"""
import struct

TAG_END = 0
TAG_STRING = 8
TAG_LIST = 9
TAG_COMPOUND = 10


def _string(value: str) -> bytes:
    raw = value.encode("utf-8")
    return struct.pack(">H", len(raw)) + raw


def _named_string(name: str, value: str) -> bytes:
    return bytes([TAG_STRING]) + _string(name) + _string(value)


def servers_dat(servers: list[dict]) -> bytes:
    """servers is a list of {"name": ..., "ip": ...} in list order."""
    entries = b""
    for s in servers:
        entries += _named_string("name", s.get("name", "Server"))
        entries += _named_string("ip", s.get("ip", ""))
        entries += bytes([TAG_END])          # end of this server compound

    # TAG_List named "servers", holding TAG_Compound elements.
    body = (
        bytes([TAG_LIST]) + _string("servers")
        + bytes([TAG_COMPOUND]) + struct.pack(">i", len(servers))
        + entries
    )

    # Root is an unnamed TAG_Compound wrapping that list.
    return bytes([TAG_COMPOUND]) + struct.pack(">H", 0) + body + bytes([TAG_END])
