"""Minimal async Source RCON client - avoids pulling in another dependency."""
import asyncio
import struct

SERVERDATA_AUTH = 3
SERVERDATA_EXECCOMMAND = 2


class RconError(Exception):
    pass


def _pack(req_id: int, kind: int, body: str) -> bytes:
    payload = struct.pack("<ii", req_id, kind) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


async def _read_packet(reader: asyncio.StreamReader):
    raw_len = await reader.readexactly(4)
    (length,) = struct.unpack("<i", raw_len)
    if length < 10 or length > 8192:
        raise RconError(f"bogus packet length {length}")
    payload = await reader.readexactly(length)
    req_id, kind = struct.unpack("<ii", payload[:8])
    body = payload[8:-2].decode("utf-8", errors="replace")
    return req_id, kind, body


async def execute(host: str, port: int, password: str, command: str, timeout: float = 8.0) -> str:
    """Connect, authenticate, run one command, return the reply text."""

    async def _run() -> str:
        reader, writer = await asyncio.open_connection(host, port)
        try:
            writer.write(_pack(1, SERVERDATA_AUTH, password))
            await writer.drain()
            req_id, _, _ = await _read_packet(reader)
            # The server answers a failed login with request id -1.
            if req_id == -1:
                raise RconError("RCON authentication failed")

            writer.write(_pack(2, SERVERDATA_EXECCOMMAND, command))
            await writer.drain()
            # Responses over 4096 bytes arrive split across several packets, so
            # keep reading until the socket goes quiet.
            chunks = []
            while True:
                try:
                    _, _, body = await asyncio.wait_for(_read_packet(reader), timeout=0.4)
                except (asyncio.TimeoutError, asyncio.IncompleteReadError):
                    break
                chunks.append(body)
                if len(body) < 4096:
                    break
            return "".join(chunks)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    return await asyncio.wait_for(_run(), timeout=timeout)
