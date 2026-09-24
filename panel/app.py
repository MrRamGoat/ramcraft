"""RamCraft - one-click Minecraft server hosting panel."""
import asyncio
import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Body, UploadFile, File
from fastapi.responses import StreamingResponse, FileResponse, PlainTextResponse, Response, HTMLResponse
from fastapi.staticfiles import StaticFiles

import mrpack
import rcon
import servers as S

app = FastAPI(title="RamCraft", docs_url="/api/docs", redoc_url=None)
STATIC = Path(__file__).parent / "static"
SETTINGS_FILE = S.DATA_ROOT / "_ramcraft-settings.json"

MODRINTH_API = "https://api.modrinth.com/v2"
MOJANG_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
UA = {"User-Agent": "RamCraft/1.0 (self-hosted panel)"}

_version_cache = {"at": 0.0, "data": None}


# --- settings --------------------------------------------------------------

def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text())
        except Exception:
            pass
    return {"cf_api_key": "", "default_memory_gb": 4}


def save_settings(data: dict):
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, indent=2))


@app.get("/api/settings")
def get_settings():
    s = load_settings()
    return {
        "default_memory_gb": s.get("default_memory_gb", 4),
        "router_domain": S.ROUTER_DOMAIN,
        "cf_api_key_set": bool(s.get("cf_api_key")),
    }


@app.put("/api/settings")
def put_settings(body: dict = Body(...)):
    s = load_settings()
    for key in ("default_memory_gb",):
        if key in body:
            s[key] = body[key]
    # An empty string means "leave the stored key alone", not "erase it".
    if body.get("cf_api_key"):
        s["cf_api_key"] = str(body["cf_api_key"]).strip()
    if body.get("clear_cf_api_key"):
        s["cf_api_key"] = ""
    save_settings(s)
    return {"ok": True}


# --- catalogue -------------------------------------------------------------

@app.get("/api/search/modrinth")
async def search_modrinth(q: str = "", limit: int = 24, offset: int = 0, version: str = ""):
    facets = [["project_type:modpack"]]
    if version:
        facets.append(["versions:" + version])
    params = {
        "query": q,
        "limit": min(limit, 60),
        "offset": offset,
        "index": "relevance" if q else "downloads",
        "facets": json.dumps(facets),
    }
    async with httpx.AsyncClient(timeout=20, headers=UA) as c:
        r = await c.get(MODRINTH_API + "/search", params=params)
        r.raise_for_status()
        data = r.json()
    hits = [{
        "slug": h["slug"],
        "title": h["title"],
        "description": h.get("description", ""),
        "icon": h.get("icon_url"),
        "downloads": h.get("downloads", 0),
        "follows": h.get("follows", 0),
        "categories": h.get("categories", []),
        "versions": h.get("versions", [])[-6:],
    } for h in data.get("hits", [])]
    return {"hits": hits, "total": data.get("total_hits", 0)}


@app.get("/api/modrinth/{slug}/versions")
async def modrinth_versions(slug: str):
    async with httpx.AsyncClient(timeout=20, headers=UA) as c:
        r = await c.get(MODRINTH_API + "/project/" + slug + "/version")
        if r.status_code == 404:
            raise HTTPException(404, "modpack not found on Modrinth")
        r.raise_for_status()
        data = r.json()
    out = []
    for v in data[:40]:
        out.append({
            "id": v["id"],
            "name": v.get("name"),
            "version_number": v.get("version_number"),
            "game_versions": v.get("game_versions", []),
            "loaders": v.get("loaders", []),
            "type": v.get("version_type"),
            "date": v.get("date_published"),
        })
    return {"versions": out}


@app.get("/api/search/mods")
async def search_mods(q: str = "", limit: int = 24, offset: int = 0,
                      version: str = "", loader: str = ""):
    """Individual mods, not modpacks - the building blocks for a custom pack."""
    facets = [["project_type:mod"]]
    if version:
        facets.append(["versions:" + version])
    if loader:
        facets.append(["categories:" + loader])
    params = {
        "query": q,
        "limit": min(limit, 60),
        "offset": offset,
        "index": "relevance" if q else "downloads",
        "facets": json.dumps(facets),
    }
    async with httpx.AsyncClient(timeout=20, headers=UA) as c:
        r = await c.get(MODRINTH_API + "/search", params=params)
        r.raise_for_status()
        data = r.json()
    return {"hits": [{
        "slug": h["slug"],
        "title": h["title"],
        "description": h.get("description", ""),
        "icon": h.get("icon_url"),
        "downloads": h.get("downloads", 0),
        "categories": h.get("categories", []),
        # server_side "unsupported" means it is a client-only mod and putting it
        # on the server does nothing - worth showing.
        "server_side": h.get("server_side"),
        "client_side": h.get("client_side"),
    } for h in data.get("hits", [])], "total": data.get("total_hits", 0)}


@app.get("/api/versions/minecraft")
async def minecraft_versions():
    if _version_cache["data"] and time.time() - _version_cache["at"] < 3600:
        return _version_cache["data"]
    async with httpx.AsyncClient(timeout=20, headers=UA) as c:
        r = await c.get(MOJANG_MANIFEST)
        r.raise_for_status()
        m = r.json()
    releases = [v["id"] for v in m["versions"] if v["type"] == "release"]
    out = {"latest": m["latest"]["release"], "releases": releases[:80]}
    _version_cache["at"] = time.time()
    _version_cache["data"] = out
    return out


# --- servers ---------------------------------------------------------------

def _server_payload(sid: str, with_stats: bool = True) -> dict:
    meta = S.load_meta(sid)
    if not meta:
        raise HTTPException(404, "unknown server")
    payload = {
        "id": sid,
        "name": meta["name"],
        "kind": meta["kind"],
        "port": meta["port"],
        "memory_gb": meta["memory_gb"],
        "mc_version": meta.get("mc_version"),
        "icon": meta.get("icon"),
        "source": meta.get("source"),
        "created": meta.get("created"),
        "notes": meta.get("notes", ""),
        "public_address": meta.get("public_address", ""),
        "subdomain": meta.get("subdomain") or sid,
        "is_default": bool(meta.get("is_default")),
        "spec": meta.get("spec", {}),
        "status": S.status_of(sid),
        "connect": S.connect_info(meta),
    }
    if with_stats:
        payload["stats"] = S.stats_of(sid)
    return payload


@app.get("/api/servers")
def list_servers():
    return {"servers": [_server_payload(sid) for sid in S.all_ids()]}


@app.get("/api/servers/{sid}")
def get_server(sid: str):
    payload = _server_payload(sid)
    payload["disk_mb"] = S.disk_of(sid)
    payload["backups"] = S.list_backups(sid)
    return payload


UPLOAD_DIR = S.UPLOAD_ROOT


@app.post("/api/uploads")
async def upload_pack(file: UploadFile = File(...)):
    """Accept a server pack zip so CurseForge-only packs can be installed
    without an API key - the user downloads the server pack from the website
    themselves and drops it here."""
    name = os.path.basename(file.filename or "pack.zip")
    if not name.lower().endswith(".zip"):
        raise HTTPException(400, "that is not a .zip - use the server pack zip")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / name
    size = 0
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            out.write(chunk)
    return {"ok": True, "path": str(dest), "name": name, "size_mb": round(size / 1048576, 1)}


@app.get("/api/uploads")
def list_uploads():
    if not UPLOAD_DIR.exists():
        return {"uploads": []}
    return {"uploads": [
        {"name": p.name, "path": str(p), "size_mb": round(p.stat().st_size / 1048576, 1)}
        for p in sorted(UPLOAD_DIR.glob("*.zip"))
    ]}


@app.post("/api/servers")
def create_server(spec: dict = Body(...)):
    if not spec.get("name"):
        raise HTTPException(400, "a name is required")
    spec.setdefault("kind", "vanilla")
    spec.setdefault("memory_gb", load_settings().get("default_memory_gb", 4))
    if spec["kind"] == "curseforge" and not spec.get("cf_api_key"):
        key = load_settings().get("cf_api_key")
        if not key:
            raise HTTPException(400, "CurseForge needs an API key - add one in Settings")
        spec["cf_api_key"] = key
    try:
        meta = S.create_server(spec)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, type(e).__name__ + ": " + str(e))
    return {"ok": True, "server": _server_payload(meta["id"])}


async def _rcon(meta: dict, sid: str, cmd: str, timeout: float = 20.0):
    return await rcon.execute(S.CONTAINER_PREFIX + sid, 25575, meta["rcon_password"], cmd, timeout)


# Declared before the /actions/{action} catch-all below, which would otherwise
# swallow it - the same shadowing that silently broke /command.
@app.post("/api/servers/{sid}/actions/backup")
async def backup_action(sid: str):
    meta = S.load_meta(sid)
    if not meta:
        raise HTTPException(404, "unknown server")

    # A live server keeps the world in memory, so tarring it without flushing
    # first archives a half-written world - level.dat and regions simply absent.
    online = S.status_of(sid)["state"] == "online"
    flushed = False
    if online:
        try:
            await _rcon(meta, sid, "save-off")
            await _rcon(meta, sid, "save-all flush", timeout=120)
            flushed = True
        except Exception:
            pass  # fall through and archive what is on disk

    try:
        result = await asyncio.to_thread(S.backup, sid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, type(e).__name__ + ": " + str(e))
    finally:
        # Never leave a running server with saving disabled, even if tar blew up.
        if flushed:
            try:
                await _rcon(meta, sid, "save-on")
            except Exception:
                pass

    result["flushed"] = flushed
    return {"ok": True, "backup": result}


# Namespaced under /actions/ on purpose: a bare /{action} catch-all shadows
# every sibling route declared after it.
@app.post("/api/servers/{sid}/actions/{action}")
def server_action(sid: str, action: str):
    if action not in ("start", "stop", "restart", "recreate"):
        raise HTTPException(404, "unknown action")
    if not S.load_meta(sid):
        raise HTTPException(404, "unknown server")
    try:
        if action == "start":
            S.start(sid)
        elif action == "stop":
            S.stop(sid)
        elif action == "restart":
            S.restart(sid)
        elif action == "recreate":
            S.recreate_container(sid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, type(e).__name__ + ": " + str(e))
    return {"ok": True, "status": S.status_of(sid)}


@app.patch("/api/servers/{sid}")
def update_server(sid: str, body: dict = Body(...)):
    meta = S.load_meta(sid)
    if not meta:
        raise HTTPException(404, "unknown server")
    needs_recreate = False
    for key in ("name", "public_address", "notes", "icon"):
        if key in body:
            meta[key] = body[key]
    if "memory_gb" in body and int(body["memory_gb"]) != meta["memory_gb"]:
        meta["memory_gb"] = int(body["memory_gb"])
        needs_recreate = True
    if "subdomain" in body:
        sub = re.sub(r"[^a-z0-9-]+", "-", str(body["subdomain"]).lower()).strip("-")
        if not sub:
            raise HTTPException(400, "the subdomain cannot be empty")
        for other in S.all_ids():
            if other == sid:
                continue
            om = S.load_meta(other) or {}
            if (om.get("subdomain") or other) == sub:
                raise HTTPException(400, f"'{sub}' is already used by {om.get('name', other)}")
        if sub != (meta.get("subdomain") or sid):
            meta["subdomain"] = sub
            needs_recreate = True

    if "is_default" in body and bool(body["is_default"]) != bool(meta.get("is_default")):
        meta["is_default"] = bool(body["is_default"])
        needs_recreate = True
        # Only one server can own the bare domain, so demote whoever held it.
        if meta["is_default"]:
            for other in S.all_ids():
                if other == sid:
                    continue
                om = S.load_meta(other)
                if om and om.get("is_default"):
                    om["is_default"] = False
                    S.save_meta(other, om)
                    try:
                        S.recreate_container(other)
                    except Exception:
                        pass

    if "port" in body and int(body["port"]) != meta["port"]:
        new_port = int(body["port"])
        if new_port in (S.used_ports() - {meta["port"]}):
            raise HTTPException(400, f"port {new_port} is already used by another server")
        if not (S.PORT_BASE <= new_port <= S.PORT_MAX):
            raise HTTPException(400, f"port must be between {S.PORT_BASE} and {S.PORT_MAX}")
        meta["port"] = new_port
        needs_recreate = True
    for key in ("motd", "difficulty", "max_players", "gamemode", "pvp",
                "view_distance", "simulation_distance", "online_mode", "ops", "whitelist"):
        if key in body:
            meta.setdefault("spec", {})[key] = body[key]
            needs_recreate = True
    S.save_meta(sid, meta)
    if needs_recreate and body.get("apply_now", True):
        try:
            S.recreate_container(sid)
        except Exception as e:
            raise HTTPException(500, "saved, but rebuilding the container failed: " + str(e))
    return {"ok": True, "recreated": needs_recreate, "server": _server_payload(sid)}


@app.delete("/api/servers/{sid}")
def delete_server(sid: str, wipe: bool = True, drop_backups: bool = True, prune: bool = False):
    """Deleting a server removes its world AND its backups - the backups live
    outside the server directory, so wiping only that left them behind forever.

    Base images are deliberately NOT pruned by default: they are shared between
    servers and only ~1.2 GB each, so dropping one just forces a re-download on
    the next create. Clean those up explicitly via /api/maintenance/cleanup.
    """
    if not S.load_meta(sid):
        raise HTTPException(404, "unknown server")
    result = S.delete(sid, wipe=wipe, drop_backups=drop_backups)
    if prune:
        pruned = S.prune_docker()
        result["freed_mb"] += pruned["freed_mb"]
        result["images_removed"] = pruned["images_removed"]
    return {"ok": True, **result}


@app.get("/api/maintenance")
def maintenance_info():
    o = S.orphans()
    return {
        "orphans": o,
        "orphan_mb": sum(i["size_mb"] for i in o["dirs"] + o["backups"]),
    }


@app.post("/api/maintenance/cleanup")
def maintenance_cleanup():
    purged = S.purge_orphans()
    pruned = S.prune_docker()
    return {
        "ok": True,
        "freed_mb": purged["freed_mb"] + pruned["freed_mb"],
        "removed": purged["removed"],
        "images_removed": pruned["images_removed"],
    }


# --- console ---------------------------------------------------------------

@app.get("/api/servers/{sid}/logs", response_class=PlainTextResponse)
def server_logs(sid: str, tail: int = 400):
    if not S.load_meta(sid):
        raise HTTPException(404, "unknown server")
    return S.logs(sid, tail=tail)


@app.get("/api/servers/{sid}/stream")
async def server_stream(sid: str):
    if not S.load_meta(sid):
        raise HTTPException(404, "unknown server")

    async def gen():
        loop = asyncio.get_running_loop()
        stream = await loop.run_in_executor(None, S.log_stream, sid)
        try:
            while True:
                chunk = await loop.run_in_executor(None, next, stream, None)
                if chunk is None:
                    break
                text = chunk.decode("utf-8", errors="replace").rstrip("\n")
                for line in text.split("\n"):
                    yield "data: " + line + "\n\n"
        except Exception:
            pass
        yield "event: end\ndata: closed\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/servers/{sid}/command")
async def send_command(sid: str, body: dict = Body(...)):
    meta = S.load_meta(sid)
    if not meta:
        raise HTTPException(404, "unknown server")
    cmd = (body.get("command") or "").strip().lstrip("/")
    if not cmd:
        raise HTTPException(400, "empty command")
    if S.status_of(sid)["state"] not in ("online", "starting"):
        raise HTTPException(409, "the server is not running")
    try:
        reply = await rcon.execute(S.CONTAINER_PREFIX + sid, 25575, meta["rcon_password"], cmd)
    except Exception as e:
        raise HTTPException(502, "RCON failed: " + type(e).__name__ + ": " + str(e))
    return {"ok": True, "reply": reply.strip()}


PLAYER_RE = re.compile(r"There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)", re.I)
COLOR_RE = re.compile("§.")


@app.get("/api/servers/{sid}/players")
async def players(sid: str):
    meta = S.load_meta(sid)
    if not meta:
        raise HTTPException(404, "unknown server")
    blank = {"online": 0, "max": 0, "names": [], "available": False}
    if S.status_of(sid)["state"] != "online":
        return blank
    try:
        reply = await rcon.execute(
            S.CONTAINER_PREFIX + sid, 25575, meta["rcon_password"], "list", timeout=5
        )
    except Exception:
        return blank
    m = PLAYER_RE.search(COLOR_RE.sub("", reply))
    if not m:
        return blank
    names = [n.strip() for n in m.group(3).split(",") if n.strip()]
    return {"online": int(m.group(1)), "max": int(m.group(2)), "names": names, "available": True}


# --- backups ---------------------------------------------------------------

@app.get("/api/servers/{sid}/mrpack")
async def client_pack(sid: str):
    """A .mrpack of this server's mods, so a player's client matches it.
    Opens directly in the Modrinth app, PrismLauncher, ATLauncher, MultiMC."""
    meta = S.load_meta(sid)
    if not meta:
        raise HTTPException(404, "unknown server")
    spec = meta.get("spec") or {}
    mods = spec.get("mods") or []
    if not mods:
        raise HTTPException(400, "this server was not built from a hand-picked mod list")

    data, report = await mrpack.build(
        meta["name"], meta.get("mc_version") or spec.get("mc_version") or "",
        spec.get("loader", "fabric"), mods,
    )
    return Response(
        content=data,
        media_type="application/x-modrinth-modpack+zip",
        headers={
            "Content-Disposition": f'attachment; filename="{sid}.mrpack"',
            "X-Pack-Included": str(report["included"]),
            "X-Pack-Skipped": str(len(report["skipped"])),
        },
    )


@app.get("/api/servers/{sid}/backups")
def server_backups(sid: str):
    return {"backups": S.list_backups(sid)}


@app.post("/api/servers/{sid}/backups/{filename}/restore")
def restore(sid: str, filename: str):
    try:
        S.restore_backup(sid, filename)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True}


@app.delete("/api/servers/{sid}/backups/{filename}")
def drop_backup(sid: str, filename: str):
    try:
        S.delete_backup(sid, filename)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.get("/api/servers/{sid}/backups/{filename}/download")
def download_backup(sid: str, filename: str):
    try:
        p = S.safe_backup_path(sid, filename)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return FileResponse(p, filename=sid + "-" + filename, media_type="application/gzip")


# --- host ------------------------------------------------------------------

@app.get("/api/host")
def host_info():
    # /proc/meminfo inside an LXC reports the *hypervisor's* RAM, not this
    # container's budget, so the real ceiling has to be handed in explicitly.
    budget_mb = int(os.environ.get("RAMCRAFT_MEM_BUDGET_GB", "0")) * 1024
    if not budget_mb:
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        budget_mb = int(line.split()[1]) // 1024
                        break
        except Exception:
            budget_mb = 0

    du = shutil.disk_usage(str(S.DATA_ROOT)) if S.DATA_ROOT.exists() else None
    ids = S.all_ids()
    running = committed_mb = 0
    for sid in ids:
        if S.status_of(sid)["state"] in ("online", "starting", "unhealthy"):
            running += 1
            meta = S.load_meta(sid) or {}
            committed_mb += int(meta.get("memory_gb", 0)) * 1024
    return {
        "mem_total_mb": budget_mb,
        "mem_used_mb": committed_mb,
        "mem_is_committed": True,
        "cpu_count": os.cpu_count(),
        "disk_total_gb": round(du.total / 1073741824, 1) if du else 0,
        "disk_free_gb": round(du.free / 1073741824, 1) if du else 0,
        "servers": len(ids),
        "running": running,
        "lan_host": S.LAN_HOST,
        "router_domain": S.ROUTER_DOMAIN,
        "router": S.router_routes(),
        "port_range": [S.PORT_BASE, S.PORT_MAX],
    }


@app.get("/api/health")
def health():
    return {"ok": True}


# --- static, with cache busting ---------------------------------------------

def _asset_version() -> str:
    """Changes whenever a static file changes, so the URL changes with it."""
    try:
        stamp = "".join(
            f"{p.name}{p.stat().st_mtime_ns}"
            for p in sorted(STATIC.iterdir()) if p.is_file()
        )
        return hashlib.sha1(stamp.encode()).hexdigest()[:10]
    except Exception:
        return str(int(time.time()))


@app.get("/", include_in_schema=False)
def index():
    """Served by hand rather than by StaticFiles so the CSS and JS URLs carry a
    version. Behind a CDN the HTML would otherwise come back fresh while
    style.css stayed cached for hours - which renders the new markup with the
    old stylesheet and looks utterly broken rather than merely stale.
    """
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    v = _asset_version()
    html = html.replace('href="style.css"', f'href="style.css?v={v}"')
    html = html.replace('src="app.js"', f'src="app.js?v={v}"')
    return HTMLResponse(html, headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
    })


@app.middleware("http")
async def asset_cache_headers(request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if path.endswith((".css", ".js")):
        # Versioned URLs make these safe to cache hard; without the version
        # they must revalidate.
        resp.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if request.url.query.startswith("v=")
            else "no-cache, must-revalidate"
        )
    elif path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


app.mount("/", StaticFiles(directory=str(STATIC), html=True), name="static")
