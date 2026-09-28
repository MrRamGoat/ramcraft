"""CurseForge: browse modpacks and worlds, and work out what a pick installs.

Every call goes through the panel, never the browser, so the API key stays on
this machine. Answers are cached for a few minutes - the browser searches on
every pause in typing, and CurseForge throttles keys that hammer it.

Not every project can be installed this way. An author can switch off
third-party distribution, and then the API hands out no download URL at all -
for the pack or for any of its files. Those are flagged `auto: False` so the UI
can send the user to download the server pack themselves instead of letting
the install die halfway through.
"""
import hashlib
import json
import re
import shutil
import time
import zipfile
from pathlib import Path

import httpx

import nbt
import settings

API = "https://api.curseforge.com/v1"
MINECRAFT = 432
CLASS = {"modpack": 4471, "world": 17}
# CurseForge's modLoaderType enum. 2 and 3 (Cauldron, LiteLoader) are dead.
LOADERS = {1: "forge", 4: "fabric", 5: "quilt", 6: "neoforge"}
LOADER_IDS = {v: k for k, v in LOADERS.items()}
SORTS = {"popular": 2, "downloads": 6, "updated": 3, "new": 11, "name": 4}
RELEASE = {1: "release", 2: "beta", 3: "alpha"}
UA = "RamCraft/1.0 (self-hosted panel)"
# gameVersions mixes Minecraft versions with loader names, "Client", "Java 21"...
MC_VERSION = re.compile(r"^\d+\.\d+(?:\.\d+)?$")
# The search API refuses any page that reaches past this many results.
MAX_WINDOW = 10_000

KEY_REJECTED = (
    "CurseForge rejected the API key. Use the key from your approval email - it "
    "starts with $2a$10$. A token starting cfc_pat_ is not an API key and is refused."
)


class CurseForgeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


_cache: dict[str, tuple[float, object]] = {}


async def _get(path: str, params: dict | None = None, ttl: int = 300, key: str | None = None):
    key = settings.cf_api_key() if key is None else key.strip()
    if not key:
        raise CurseForgeError(409, "No CurseForge API key yet - add it under Settings.")
    cache_key = path + "?" + "&".join(f"{k}={v}" for k, v in sorted((params or {}).items()))
    hit = _cache.get(cache_key)
    if ttl and hit and time.time() - hit[0] < ttl:
        return hit[1]

    headers = {"x-api-key": key, "Accept": "application/json", "User-Agent": UA}
    try:
        async with httpx.AsyncClient(timeout=20, headers=headers) as c:
            r = await c.get(API + path, params=params)
    except httpx.HTTPError as e:
        raise CurseForgeError(502, f"Could not reach CurseForge ({type(e).__name__}).")
    if r.status_code in (401, 403):
        raise CurseForgeError(502, KEY_REJECTED)
    if r.status_code == 404:
        raise CurseForgeError(404, "CurseForge has no such project or file.")
    if r.status_code >= 400:
        raise CurseForgeError(502, f"CurseForge answered {r.status_code}.")

    data = r.json()
    if ttl:
        if len(_cache) > 500:
            _cache.clear()
        _cache[cache_key] = (time.time(), data)
    return data


async def check_key(key: str) -> bool:
    """True if CurseForge accepts this key. Network trouble raises instead, so
    a flaky connection is never reported as a bad key."""
    try:
        await _get(f"/games/{MINECRAFT}", ttl=0, key=key)
        return True
    except CurseForgeError as e:
        if str(e) == KEY_REJECTED:
            return False
        raise


# --- shaping -----------------------------------------------------------------

def _vkey(v: str) -> tuple:
    return tuple(int(x) for x in v.split("."))


def _mc_versions(values) -> list[str]:
    return sorted({v for v in values if v and MC_VERSION.match(v)}, key=_vkey, reverse=True)


def _project(m: dict) -> dict:
    idx = m.get("latestFilesIndexes") or []
    return {
        "id": m["id"],
        "slug": m["slug"],
        "title": (m.get("name") or m["slug"]).strip(),
        "description": m.get("summary", ""),
        "icon": (m.get("logo") or {}).get("thumbnailUrl"),
        "downloads": m.get("downloadCount", 0),
        "categories": [c["name"] for c in (m.get("categories") or [])][:4],
        "versions": _mc_versions(i.get("gameVersion") for i in idx)[:6],
        "loaders": sorted({LOADERS[i["modLoader"]] for i in idx if i.get("modLoader") in LOADERS}),
        "url": (m.get("links") or {}).get("websiteUrl"),
        # Missing on some old projects; only an explicit False blocks downloads.
        "auto": m.get("allowModDistribution") is not False,
        "updated": m.get("dateModified"),
    }


def _file(f: dict) -> dict:
    gv = f.get("gameVersions") or []
    mcs = _mc_versions(gv)
    return {
        "id": f["id"],
        "name": f.get("displayName") or f.get("fileName"),
        "file_name": f.get("fileName"),
        "mc": mcs[0] if mcs else None,
        "loader": next((v.lower() for v in gv if v.lower() in LOADER_IDS), None),
        "type": RELEASE.get(f.get("releaseType"), "release"),
        "date": f.get("fileDate"),
        "size_mb": round((f.get("fileLength") or 0) / 1048576, 1),
        "server_pack_id": f.get("serverPackFileId"),
        "download_url": f.get("downloadUrl"),
        "auto": bool(f.get("downloadUrl")) and f.get("isAvailable", True) is not False,
    }


# --- browsing ----------------------------------------------------------------

async def search(kind: str = "modpack", q: str = "", version: str = "", loader: str = "",
                 category: int = 0, sort: str = "popular", offset: int = 0, limit: int = 24) -> dict:
    if kind not in CLASS:
        raise CurseForgeError(400, "unknown project type")
    limit = max(1, min(int(limit), 50))
    offset = max(0, min(int(offset), MAX_WINDOW - limit))
    params = {
        "gameId": MINECRAFT,
        "classId": CLASS[kind],
        "sortField": SORTS.get(sort, SORTS["popular"]),
        "sortOrder": "asc" if sort == "name" else "desc",
        "index": offset,
        "pageSize": limit,
    }
    if q:
        params["searchFilter"] = q
    if version:
        params["gameVersion"] = version
    if loader in LOADER_IDS:
        params["modLoaderType"] = LOADER_IDS[loader]
    if category:
        params["categoryId"] = int(category)
    data = await _get("/mods/search", params)
    total = (data.get("pagination") or {}).get("totalCount", 0)
    return {"hits": [_project(m) for m in data.get("data", [])], "total": min(total, MAX_WINDOW)}


async def categories(kind: str = "modpack") -> list[dict]:
    data = await _get("/categories", {"gameId": MINECRAFT, "classId": CLASS[kind]}, ttl=86400)
    cats = [{"id": c["id"], "name": c["name"]} for c in data.get("data", []) if not c.get("isClass")]
    return sorted(cats, key=lambda c: c["name"].lower())


async def project(mod_id: int) -> dict:
    return _project((await _get(f"/mods/{int(mod_id)}", ttl=600))["data"])


async def files(mod_id: int, limit: int = 40) -> list[dict]:
    """Newest first. Server packs are separate files in the same list and are
    dropped - the picker is choosing a pack version, not an archive."""
    data = await _get(f"/mods/{int(mod_id)}/files", {"pageSize": 50})
    out = [_file(f) for f in data.get("data", []) if not f.get("isServerPack")]
    out.sort(key=lambda f: f["date"] or "", reverse=True)
    return out[:limit]


async def file(mod_id: int, file_id: int) -> dict:
    return _file((await _get(f"/mods/{int(mod_id)}/files/{int(file_id)}", ttl=600))["data"])


async def resolve(mod_id: int, file_id: int | None = None, kind: str = "modpack") -> tuple[dict, dict]:
    """(project, file) for an install. With no file picked, the newest stable
    release - the same thing the website's big Install button gives you."""
    proj = await project(mod_id)
    if file_id:
        f = await file(mod_id, file_id)
    else:
        candidates = await files(mod_id)
        if not candidates:
            raise CurseForgeError(404, f"{proj['title']} has no files to install.")
        f = next((c for c in candidates if c["type"] == "release"), candidates[0])
    return proj, f


# --- client pack ---------------------------------------------------------------

async def client_pack(dest_dir: Path, f: dict, pack_name: str, address: str) -> Path:
    """The author's own CurseForge pack zip with this server added to it.

    Import it in the CurseForge app (or Prism) and the world is already in the
    Multiplayer list - the same trick as the .mrpack for Modrinth servers. A
    big pack is hundreds of MB, so it is streamed to disk rather than held in
    memory, and kept until the pack version or the address changes.
    """
    if not f.get("download_url"):
        raise CurseForgeError(409, "The author does not allow this pack to be downloaded "
                                   "automatically - install it from the CurseForge app.")
    stamp = hashlib.sha1(f"{f['id']}|{address}|{pack_name}".encode()).hexdigest()[:10]
    out = dest_dir / f"client-pack-{stamp}.zip"
    if out.exists():
        return out
    for old in dest_dir.glob("client-pack-*.zip"):
        old.unlink(missing_ok=True)

    part = out.with_suffix(".part")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120), follow_redirects=True,
                                     headers={"User-Agent": UA}) as c:
            async with c.stream("GET", f["download_url"]) as r:
                r.raise_for_status()
                with part.open("wb") as fh:
                    async for chunk in r.aiter_bytes(1 << 20):
                        fh.write(chunk)
        _add_server(part, pack_name, address)
        part.rename(out)
    except Exception:
        part.unlink(missing_ok=True)
        raise
    return out


def _add_server(path: Path, pack_name: str, address: str):
    if not address:
        return
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        overrides = "overrides"
        if "manifest.json" in names:
            overrides = json.loads(z.read("manifest.json")).get("overrides") or "overrides"
    target = f"{overrides}/servers.dat"
    blob = nbt.servers_dat([{"name": pack_name, "ip": address}])
    if target not in names:
        # Appending is instant; rewriting a 200 MB zip is not.
        with zipfile.ZipFile(path, "a", zipfile.ZIP_DEFLATED) as z:
            z.writestr(target, blob)
        return
    # The author shipped their own server list (often a sponsor's). Ours
    # replaces it - two entries with one name would be read unpredictably.
    tmp = path.with_suffix(".rewrite")
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            if item.filename == target:
                continue
            with src.open(item) as i, dst.open(item, "w") as o:
                shutil.copyfileobj(i, o, 1 << 20)
        dst.writestr(target, blob)
    tmp.replace(path)
