"""Build a Modrinth .mrpack from a list of project slugs.

The point: a server built from hand-picked mods is useless to a player unless
their client runs the same set. A .mrpack opens straight in the Modrinth app
(and PrismLauncher, ATLauncher, MultiMC) and installs exactly these files, so
"what the server runs" and "what I install" cannot drift apart.

Format: a zip with modrinth.index.json at the root, listing each file with its
CDN url and hashes. The launcher downloads them itself - nothing is mirrored
here, so mod authors keep their download counts.
"""
import asyncio
import io
import json
import zipfile

import httpx

MODRINTH_API = "https://api.modrinth.com/v2"
FABRIC_META = "https://meta.fabricmc.net/v2/versions/loader"
NEOFORGE_META = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"
UA = {"User-Agent": "RamCraft/1.0 (self-hosted panel)"}

# modrinth.index.json calls the loaders these names, which are not the same as
# the labels used elsewhere.
LOADER_KEY = {
    "fabric": "fabric-loader",
    "quilt": "quilt-loader",
    "forge": "forge",
    "neoforge": "neoforge",
}


async def _pick_version(client: httpx.AsyncClient, slug: str, mc_version: str, loader: str):
    """Newest release of `slug` that fits this MC version and loader."""
    r = await client.get(
        f"{MODRINTH_API}/project/{slug}/version",
        params={"game_versions": json.dumps([mc_version]), "loaders": json.dumps([loader])},
    )
    if r.status_code != 200:
        return None
    versions = r.json()
    if not versions:
        return None
    # Prefer a stable release; fall back to whatever is newest.
    releases = [v for v in versions if v.get("version_type") == "release"]
    return (releases or versions)[0]


async def _fabric_loader_version(client: httpx.AsyncClient) -> str:
    try:
        r = await client.get(FABRIC_META)
        r.raise_for_status()
        for entry in r.json():
            if entry.get("stable"):
                return entry["version"]
        return r.json()[0]["version"]
    except Exception:
        return "0.16.9"


async def _neoforge_version(client: httpx.AsyncClient, mc_version: str) -> str:
    """NeoForge versions are <mcMinor>.<mcPatch>.<build>, so 1.21.1 -> 21.1.x."""
    try:
        parts = mc_version.split(".")
        prefix = f"{parts[1]}.{parts[2] if len(parts) > 2 else '0'}."
        r = await client.get(NEOFORGE_META)
        r.raise_for_status()
        import re
        candidates = [v for v in re.findall(r"<version>([^<]+)</version>", r.text)
                      if v.startswith(prefix) and "beta" not in v]
        return candidates[-1] if candidates else ""
    except Exception:
        return ""


async def build(name: str, mc_version: str, loader: str, slugs: list[str]) -> tuple[bytes, dict]:
    """Returns (zip bytes, report). The report names anything that was skipped
    so the UI can say so rather than quietly shipping an incomplete pack."""
    files, skipped = [], []
    async with httpx.AsyncClient(timeout=30, headers=UA, follow_redirects=True) as client:
        picked = await asyncio.gather(
            *(_pick_version(client, s, mc_version, loader) for s in slugs),
            return_exceptions=True,
        )
        for slug, version in zip(slugs, picked):
            if isinstance(version, Exception) or not version:
                skipped.append({"slug": slug, "why": f"no build for {loader} {mc_version}"})
                continue
            primary = next((f for f in version["files"] if f.get("primary")), None) \
                or (version["files"][0] if version["files"] else None)
            if not primary:
                skipped.append({"slug": slug, "why": "no downloadable file"})
                continue
            files.append({
                "path": "mods/" + primary["filename"],
                "hashes": primary.get("hashes", {}),
                "env": {"client": "required", "server": "required"},
                "downloads": [primary["url"]],
                "fileSize": primary.get("size", 0),
            })

        deps = {"minecraft": mc_version}
        key = LOADER_KEY.get(loader)
        if loader in ("fabric", "quilt"):
            deps[key] = await _fabric_loader_version(client)
        elif loader == "neoforge":
            v = await _neoforge_version(client, mc_version)
            if v:
                deps[key] = v
        elif loader == "forge":
            deps[key] = ""

    index = {
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": "1.0.0",
        "name": name,
        "summary": f"Built with RamCraft - {len(files)} mods for {loader} {mc_version}",
        "files": files,
        "dependencies": {k: v for k, v in deps.items() if v},
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("modrinth.index.json", json.dumps(index, indent=2))
        z.writestr("overrides/.gitkeep", "")
    return buf.getvalue(), {"included": len(files), "skipped": skipped}
