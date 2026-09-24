"""Server lifecycle: metadata on disk, one itzg/minecraft-server container each."""
import json
import os
import re
import secrets
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import docker
from docker.errors import NotFound

DATA_ROOT = Path(os.environ.get("RAMCRAFT_DATA", "/srv/mc"))
BACKUP_ROOT = DATA_ROOT / "_backups"
UPLOAD_ROOT = DATA_ROOT / "_uploads"
# Where UPLOAD_ROOT is mounted inside each Minecraft container.
PACKS_MOUNT = "/modpacks"
NETWORK = os.environ.get("RAMCRAFT_NETWORK", "ramcraft")
# 25565 is mc-router's; the per-server LAN ports start above it.
PORT_BASE = int(os.environ.get("RAMCRAFT_PORT_BASE", "25566"))
PORT_MAX = int(os.environ.get("RAMCRAFT_PORT_MAX", "25640"))
LAN_HOST = os.environ.get("RAMCRAFT_LAN_HOST", "192.168.1.63")
ROUTER_DOMAIN = os.environ.get("RAMCRAFT_ROUTER_DOMAIN", "")
ROUTER_API = os.environ.get("RAMCRAFT_ROUTER_API", "http://mc-router:8080")

CONTAINER_PREFIX = "mc-"
WORLD_DIRS = ("world", "world_nether", "world_the_end")
KEEP_FILES = ("server.properties", "ops.json", "whitelist.json", "banned-players.json")

docker_client = docker.from_env()


# --- helpers ---------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:40] or f"server-{secrets.token_hex(3)}"


def pick_image(mc_version: str | None, override: str | None = None) -> str:
    """The itzg image cannot switch JVMs at runtime, so the tag has to match
    the Minecraft version or old modpacks fail to boot."""
    if override:
        return f"itzg/minecraft-server:{override}"
    if not mc_version:
        return "itzg/minecraft-server:java21"
    m = re.match(r"1\.(\d+)(?:\.(\d+))?", str(mc_version))
    if not m:
        return "itzg/minecraft-server:java21"
    minor, patch = int(m.group(1)), int(m.group(2) or 0)
    if minor <= 16:
        return "itzg/minecraft-server:java8"
    if minor < 20 or (minor == 20 and patch < 5):
        return "itzg/minecraft-server:java17"
    return "itzg/minecraft-server:java21"


def ensure_network():
    try:
        docker_client.networks.get(NETWORK)
    except NotFound:
        docker_client.networks.create(NETWORK, driver="bridge")


def server_dir(sid: str) -> Path:
    return DATA_ROOT / sid


def meta_path(sid: str) -> Path:
    return server_dir(sid) / "ramcraft.json"


def load_meta(sid: str) -> dict | None:
    p = meta_path(sid)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def save_meta(sid: str, meta: dict):
    meta_path(sid).write_text(json.dumps(meta, indent=2))


def all_ids() -> list[str]:
    if not DATA_ROOT.exists():
        return []
    return sorted(
        d.name for d in DATA_ROOT.iterdir()
        if d.is_dir() and not d.name.startswith("_") and (d / "ramcraft.json").exists()
    )


def used_ports() -> set[int]:
    ports = set()
    for sid in all_ids():
        meta = load_meta(sid)
        if meta and meta.get("port"):
            ports.add(int(meta["port"]))
    return ports


def next_port() -> int:
    taken = used_ports()
    for p in range(PORT_BASE, PORT_MAX + 1):
        if p not in taken:
            return p
    raise RuntimeError("no free port in the RamCraft range")


def hostname_for(meta: dict) -> str:
    """The public name players type. Defaults to <id>.<router domain> but a
    server can carry its own subdomain label."""
    if not ROUTER_DOMAIN:
        return ""
    sub = (meta.get("subdomain") or meta["id"]).strip().strip(".")
    return f"{sub}.{ROUTER_DOMAIN}"


def router_hosts(meta: dict) -> list[str]:
    """Hostnames mc-router should route to this server. A server flagged as the
    default also answers on the bare domain."""
    host = hostname_for(meta)
    if not host:
        return []
    hosts = [host]
    if meta.get("is_default"):
        hosts.append(ROUTER_DOMAIN)
    return hosts


def container_for(sid: str):
    try:
        return docker_client.containers.get(CONTAINER_PREFIX + sid)
    except NotFound:
        return None


# --- status ----------------------------------------------------------------

def _health_of(c) -> str | None:
    try:
        return c.attrs["State"]["Health"]["Status"]
    except (KeyError, TypeError):
        return None


def status_of(sid: str) -> dict:
    """Map docker state + the image's own healthcheck onto something a human
    can read: a modpack server is 'running' long before it accepts players."""
    c = container_for(sid)
    if c is None:
        return {"state": "missing", "health": None, "since": None}
    c.reload()
    state = c.attrs["State"]["Status"]          # running / exited / created ...
    health = _health_of(c)
    if state == "running":
        if health == "healthy":
            label = "online"
        elif health == "starting" or health is None:
            label = "starting"
        else:
            label = "unhealthy"
    elif state == "exited":
        code = c.attrs["State"].get("ExitCode", 0)
        label = "stopped" if code in (0, 130, 137, 143) else "crashed"
    else:
        label = state
    return {
        "state": label,
        "docker_state": state,
        "health": health,
        "since": c.attrs["State"].get("StartedAt"),
        "exit_code": c.attrs["State"].get("ExitCode"),
    }


def stats_of(sid: str) -> dict:
    c = container_for(sid)
    if c is None or c.status != "running":
        return {}
    try:
        s = docker_client.api.stats(c.id, stream=False)
        mem = s.get("memory_stats", {})
        usage = mem.get("usage", 0) - mem.get("stats", {}).get("inactive_file", 0)
        limit = mem.get("limit", 0)
        cpu = s.get("cpu_stats", {})
        pre = s.get("precpu_stats", {})
        cpu_delta = cpu.get("cpu_usage", {}).get("total_usage", 0) - pre.get("cpu_usage", {}).get("total_usage", 0)
        sys_delta = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
        ncpu = cpu.get("online_cpus") or 1
        pct = (cpu_delta / sys_delta) * ncpu * 100 if sys_delta > 0 else 0.0
        return {
            "mem_used_mb": round(usage / 1048576),
            "mem_limit_mb": round(limit / 1048576),
            "cpu_pct": round(pct, 1),
        }
    except Exception:
        return {}


def disk_of(sid: str) -> int:
    """Size on disk in MB - du is far faster than walking it in Python."""
    try:
        out = subprocess.run(
            ["du", "-sm", str(server_dir(sid))],
            capture_output=True, text=True, timeout=25,
        )
        return int(out.stdout.split()[0]) if out.returncode == 0 else 0
    except Exception:
        return 0


# --- creation --------------------------------------------------------------

BASE_TYPES = {
    "vanilla": "VANILLA",
    "paper": "PAPER",
    "purpur": "PURPUR",
    "fabric": "FABRIC",
    "forge": "FORGE",
    "neoforge": "NEOFORGE",
    "quilt": "QUILT",
    "spigot": "SPIGOT",
}


def build_env(spec: dict, rcon_password: str) -> dict:
    """Translate a panel spec into itzg/minecraft-server environment."""
    kind = spec["kind"]
    env = {
        "EULA": "TRUE",
        "TZ": spec.get("tz", "Asia/Jerusalem"),
        "MEMORY": f"{spec['memory_gb']}G",
        "USE_AIKAR_FLAGS": "true",
        "ENABLE_RCON": "true",
        "RCON_PASSWORD": rcon_password,
        "RCON_PORT": "25575",
        "SERVER_NAME": spec["name"],
        "MOTD": spec.get("motd") or spec["name"],
        "DIFFICULTY": spec.get("difficulty", "normal"),
        "MAX_PLAYERS": str(spec.get("max_players", 10)),
        "ONLINE_MODE": "true" if spec.get("online_mode", True) else "false",
        "VIEW_DISTANCE": str(spec.get("view_distance", 10)),
        # The single biggest TPS lever. View distance only sends chunks;
        # SIMULATION distance is what the server actually ticks - mobs, redstone,
        # crops, hoppers. Leaving it equal to view distance makes the server do
        # far more work than players can perceive.
        "SIMULATION_DISTANCE": str(
            spec.get("simulation_distance") or min(int(spec.get("view_distance", 10)), 6)
        ),
        "OVERRIDE_SERVER_PROPERTIES": "true",
        "STOP_SERVER_ANNOUNCE_DELAY": "10",
        "EXEC_DIRECTLY": "true",
    }
    if spec.get("gamemode"):
        env["MODE"] = spec["gamemode"]
    if spec.get("ops"):
        env["OPS"] = spec["ops"]
    if spec.get("whitelist"):
        env["WHITELIST"] = spec["whitelist"]
        env["ENFORCE_WHITELIST"] = "true"
    if spec.get("pvp") is not None:
        env["PVP"] = "true" if spec["pvp"] else "false"

    if kind == "modrinth":
        env["TYPE"] = "MODRINTH"
        env["MODRINTH_MODPACK"] = spec["modpack"]
        if spec.get("modpack_version"):
            env["MODRINTH_VERSION"] = spec["modpack_version"]
        env["MODRINTH_DOWNLOAD_DEPENDENCIES"] = "required"
    elif kind == "curseforge":
        env["TYPE"] = "AUTO_CURSEFORGE"
        env["CF_API_KEY"] = spec["cf_api_key"]
        if spec.get("cf_page_url"):
            env["CF_PAGE_URL"] = spec["cf_page_url"]
        elif spec.get("cf_slug"):
            env["CF_SLUG"] = spec["cf_slug"]
            if spec.get("cf_file_id"):
                env["CF_FILE_ID"] = str(spec["cf_file_id"])
    elif kind == "serverpack":
        # The legacy TYPE=CURSEFORGE path takes a server pack zip directly, by
        # URL or local file - no API key at all. This is how CurseForge-only
        # packs (All the Mods, etc.) get installed without an approved key.
        env["TYPE"] = "CURSEFORGE"
        pack = spec["server_pack"]
        # An uploaded zip sits in _uploads on the host, which the Minecraft
        # container cannot see - it only mounts its own data dir. Rewrite the
        # path to where _uploads is mounted inside the container.
        if not pack.startswith(("http://", "https://")):
            pack = f"{PACKS_MOUNT}/{Path(pack).name}"
        env["CF_SERVER_MOD"] = pack
        # The image warns that LATEST is unreliable here, so pin the version.
        if spec.get("mc_version"):
            env["VERSION"] = spec["mc_version"]
    elif kind == "ftb":
        env["TYPE"] = "FTBA"
        env["FTB_MODPACK_ID"] = str(spec["ftb_id"])
        if spec.get("ftb_version_id"):
            env["FTB_MODPACK_VERSION_ID"] = str(spec["ftb_version_id"])
    elif kind == "custom":
        # A pack the user assembled themselves: a plain loader plus a list of
        # Modrinth project slugs. The image resolves each to the right file for
        # this MC version and loader, and pulls required dependencies too.
        env["TYPE"] = BASE_TYPES.get(spec.get("loader", "fabric"), "FABRIC")
        env["VERSION"] = spec.get("mc_version") or "LATEST"
        env["MODRINTH_PROJECTS"] = ",".join(spec.get("mods") or [])
        env["MODRINTH_DOWNLOAD_DEPENDENCIES"] = "required"
        # Client-only mods in the list would otherwise abort the whole install.
        env["MODRINTH_ALLOWED_VERSION_TYPE"] = spec.get("channel", "release")
    else:
        env["TYPE"] = BASE_TYPES.get(kind, "VANILLA")
        env["VERSION"] = spec.get("mc_version") or "LATEST"

    # An adventure map is just a world zip dropped on top of whatever server
    # type was chosen above - that trick works for every type.
    if spec.get("world_url"):
        world = spec["world_url"]
        # Same rewrite as the server pack: an uploaded map sits in _uploads on
        # the host, which the container only sees at PACKS_MOUNT.
        if not world.startswith(("http://", "https://")):
            world = f"{PACKS_MOUNT}/{Path(world).name}"
        env["WORLD"] = world
    if spec.get("datapack_urls"):
        env["DATAPACKS"] = spec["datapack_urls"]
    if spec.get("mod_urls"):
        env["MODS"] = spec["mod_urls"]
    # A heavy modpack routinely blows past the 60s watchdog while generating
    # chunks, and the watchdog's response is to kill the server - which reads
    # as a random crash. Vanilla keeps its watchdog; it is a real signal there.
    if kind in ("modrinth", "curseforge", "serverpack", "ftb", "forge", "neoforge", "fabric", "quilt"):
        env["MAX_TICK_TIME"] = "-1"

    if spec.get("extra_env"):
        env.update(spec["extra_env"])
    return env


def create_server(spec: dict) -> dict:
    ensure_network()
    sid = slugify(spec["name"])
    if sid in all_ids():
        raise ValueError(f"a server called '{sid}' already exists")

    port = int(spec.get("port") or next_port())
    if port in used_ports():
        raise ValueError(f"port {port} is already taken")

    d = server_dir(sid)
    (d / "data").mkdir(parents=True, exist_ok=True)
    rcon_password = secrets.token_urlsafe(16)

    meta = {
        "id": sid,
        "name": spec["name"],
        "kind": spec["kind"],
        "port": port,
        "memory_gb": spec["memory_gb"],
        "mc_version": spec.get("mc_version"),
        "image": pick_image(spec.get("mc_version"), spec.get("java")),
        "rcon_password": rcon_password,
        "created": now_iso(),
        "source": spec.get("source_label") or spec.get("modpack") or spec.get("cf_page_url") or spec["kind"],
        "icon": spec.get("icon"),
        "subdomain": (spec.get("subdomain") or sid).strip().strip("."),
        "is_default": bool(spec.get("is_default")),
        "public_address": spec.get("public_address", ""),
        "notes": spec.get("notes", ""),
        "spec": {k: v for k, v in spec.items() if k != "cf_api_key"},
    }
    save_meta(sid, meta)

    try:
        _run_container(meta, build_env(spec, rcon_password), start=spec.get("start_now", True))
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    return meta


def _labels_for(meta: dict) -> dict:
    labels = {
        "ramcraft.id": meta["id"],
        "ramcraft.name": meta["name"],
        "ramcraft.managed": "true",
    }
    # mc-router watches Docker events for this label and wires the route the
    # moment the container appears - no API call and no restart of the router.
    hosts = router_hosts(meta)
    if hosts:
        labels["mc-router.host"] = ",".join(hosts)
        labels["mc-router.port"] = "25565"
    return labels


def _run_container(meta: dict, env: dict, start: bool = True):
    sid = meta["id"]
    docker_client.containers.run(
        meta["image"],
        name=CONTAINER_PREFIX + sid,
        detach=True,
        tty=True,
        stdin_open=True,
        environment=env,
        volumes={
            str(server_dir(sid) / "data"): {"bind": "/data", "mode": "rw"},
            # Uploaded server packs, read-only - CF_SERVER_MOD points in here.
            str(UPLOAD_ROOT): {"bind": PACKS_MOUNT, "mode": "ro"},
        },
        ports={"25565/tcp": meta["port"], "25565/udp": meta["port"]},
        network=NETWORK,
        restart_policy={"Name": "unless-stopped"},
        # Headroom above the JVM heap for metaspace, direct buffers and GC.
        # 1G is not enough for a big modpack - the container gets OOM-killed
        # and it reads as a random crash rather than a memory limit.
        mem_limit=f"{meta['memory_gb'] + 2}g",
        labels=_labels_for(meta),
    )
    if not start:
        c = container_for(sid)
        if c:
            c.stop(timeout=30)


def recreate_container(sid: str):
    """Used after changing memory or version - keeps the world, rebuilds the box."""
    meta = load_meta(sid)
    if not meta:
        raise ValueError("unknown server")
    c = container_for(sid)
    was_running = c is not None and c.status == "running"
    if c:
        c.stop(timeout=120)
        c.remove(force=True)
    spec = dict(meta.get("spec") or {})
    spec.update({"name": meta["name"], "kind": meta["kind"], "memory_gb": meta["memory_gb"]})
    meta["image"] = pick_image(meta.get("mc_version"), spec.get("java"))
    save_meta(sid, meta)
    _run_container(meta, build_env(spec, meta["rcon_password"]), start=was_running)
    return meta


# --- lifecycle -------------------------------------------------------------

def start(sid: str):
    c = container_for(sid)
    if c is None:
        meta = load_meta(sid)
        if not meta:
            raise ValueError("unknown server")
        spec = dict(meta.get("spec") or {})
        spec.update({"name": meta["name"], "kind": meta["kind"], "memory_gb": meta["memory_gb"]})
        _run_container(meta, build_env(spec, meta["rcon_password"]), start=True)
        return
    c.start()


def stop(sid: str, timeout: int = 120):
    """Long timeout on purpose: a big modded world takes a while to save, and
    killing it early is how worlds get corrupted."""
    c = container_for(sid)
    if c is None:
        raise ValueError("no container for that server")
    c.stop(timeout=timeout)


def restart(sid: str, timeout: int = 120):
    c = container_for(sid)
    if c is None:
        return start(sid)
    c.restart(timeout=timeout)


def delete(sid: str, wipe: bool = True, drop_backups: bool = True) -> dict:
    """Remove every trace of a server. Backups live outside the server
    directory, so wiping only that leaves them behind forever."""
    freed_mb = 0
    if wipe:
        freed_mb += disk_of(sid)
    if drop_backups:
        freed_mb += _dir_size_mb(BACKUP_ROOT / sid)

    c = container_for(sid)
    if c:
        try:
            c.stop(timeout=60)
        except Exception:
            pass
        c.remove(force=True, v=True)      # v=True drops anonymous volumes too

    if wipe:
        shutil.rmtree(server_dir(sid), ignore_errors=True)
    if drop_backups:
        shutil.rmtree(BACKUP_ROOT / sid, ignore_errors=True)
    return {"freed_mb": freed_mb}


def _dir_size_mb(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        out = subprocess.run(["du", "-sm", str(path)],
                             capture_output=True, text=True, timeout=60)
        return int(out.stdout.split()[0]) if out.returncode == 0 else 0
    except Exception:
        return 0


def prune_docker() -> dict:
    """Reclaim space from images no server references any more. Deleting a
    server does not free the several-GB Java image its modpack pulled in."""
    keep = set()
    for sid in all_ids():
        meta = load_meta(sid)
        if meta and meta.get("image"):
            keep.add(meta["image"])
    removed, freed = [], 0
    try:
        for img in docker_client.images.list(name="itzg/minecraft-server"):
            tags = img.tags or []
            if not tags or any(t in keep for t in tags):
                continue
            size = img.attrs.get("Size", 0)
            try:
                docker_client.images.remove(img.id, force=False)
                removed.append(tags[0])
                freed += size
            except Exception:
                pass          # still referenced by a stopped container
    except Exception:
        pass
    try:
        docker_client.volumes.prune()
    except Exception:
        pass
    return {"images_removed": removed, "freed_mb": round(freed / 1048576)}


def orphans() -> dict:
    """Directories and backups with no matching server - the residue of any
    delete that half-failed."""
    ids = set(all_ids())
    stray_dirs, stray_backups = [], []
    if DATA_ROOT.exists():
        for d in DATA_ROOT.iterdir():
            if d.is_dir() and not d.name.startswith("_") and d.name not in ids:
                stray_dirs.append({"name": d.name, "size_mb": _dir_size_mb(d)})
    if BACKUP_ROOT.exists():
        for d in BACKUP_ROOT.iterdir():
            if d.is_dir() and d.name not in ids:
                stray_backups.append({"name": d.name, "size_mb": _dir_size_mb(d)})
    return {"dirs": stray_dirs, "backups": stray_backups}


def purge_orphans() -> dict:
    o = orphans()
    freed = 0
    for item in o["dirs"]:
        freed += item["size_mb"]
        shutil.rmtree(DATA_ROOT / item["name"], ignore_errors=True)
    for item in o["backups"]:
        freed += item["size_mb"]
        shutil.rmtree(BACKUP_ROOT / item["name"], ignore_errors=True)
    return {"freed_mb": freed, "removed": len(o["dirs"]) + len(o["backups"])}


def logs(sid: str, tail: int = 300) -> str:
    c = container_for(sid)
    if c is None:
        return "(no container yet)"
    return c.logs(tail=tail, timestamps=False).decode("utf-8", errors="replace")


def log_stream(sid: str):
    c = container_for(sid)
    if c is None:
        return iter(())
    # tail=0: the panel already draws the backlog with a plain logs fetch, so a
    # backlog here would duplicate every one of those lines.
    return c.logs(stream=True, follow=True, tail=0)


# --- backups ---------------------------------------------------------------

def backup(sid: str) -> dict:
    meta = load_meta(sid)
    if not meta:
        raise ValueError("unknown server")
    dest_dir = BACKUP_ROOT / sid
    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = dest_dir / f"{stamp}.tar.gz"
    data = server_dir(sid) / "data"
    if not data.exists():
        raise ValueError("no data directory yet")

    targets = [p.name for p in data.iterdir() if p.name in WORLD_DIRS or p.name in KEEP_FILES]
    if not targets:
        raise ValueError("nothing to back up yet - has the world generated?")

    out = subprocess.run(["tar", "-czf", str(dest), "-C", str(data)] + targets,
                         capture_output=True, text=True, timeout=3600)
    if out.returncode != 0:
        dest.unlink(missing_ok=True)
        raise RuntimeError(out.stderr[-400:] or "tar failed")
    return {
        "file": dest.name,
        "size_mb": round(dest.stat().st_size / 1048576, 1),
        "created": now_iso(),
        "contents": targets,
    }


def list_backups(sid: str) -> list[dict]:
    d = BACKUP_ROOT / sid
    if not d.exists():
        return []
    items = []
    for f in sorted(d.glob("*.tar.gz"), reverse=True):
        st = f.stat()
        items.append({
            "file": f.name,
            "size_mb": round(st.st_size / 1048576, 1),
            "created": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(timespec="seconds"),
        })
    return items


def safe_backup_path(sid: str, filename: str) -> Path:
    if "/" in filename or "\\" in filename or ".." in filename:
        raise ValueError("bad filename")
    p = BACKUP_ROOT / sid / filename
    if not p.exists():
        raise ValueError("no such backup")
    return p


def restore_backup(sid: str, filename: str):
    src = safe_backup_path(sid, filename)
    c = container_for(sid)
    was_running = c is not None and c.status == "running"
    if was_running:
        c.stop(timeout=120)
    data = server_dir(sid) / "data"
    for wd in WORLD_DIRS:
        shutil.rmtree(data / wd, ignore_errors=True)
    out = subprocess.run(["tar", "-xzf", str(src), "-C", str(data)],
                         capture_output=True, text=True, timeout=3600)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[-400:] or "tar extract failed")
    if was_running:
        container_for(sid).start()


def delete_backup(sid: str, filename: str):
    safe_backup_path(sid, filename).unlink(missing_ok=True)


def router_routes() -> dict:
    """What mc-router currently believes. Purely diagnostic - the labels are
    the source of truth and discovery is event-driven."""
    try:
        import urllib.request
        with urllib.request.urlopen(f"{ROUTER_API}/routes", timeout=5) as r:
            return {"ok": True, "routes": json.loads(r.read().decode())}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "routes": {}}


def connect_info(meta: dict) -> dict:
    """The public name never carries a port: mc-router listens on 25565 for
    every server and picks the backend from the handshake hostname. The LAN
    address still needs one, because it hits the container directly."""
    port = meta["port"]
    out = {
        "lan": f"{LAN_HOST}:{port}",
        "port": port,
        "hostname": hostname_for(meta),
        "is_default": bool(meta.get("is_default")),
    }
    # A per-server override wins: tunnels like playit.gg hand out their own
    # host AND port per tunnel, which no formula can derive.
    if meta.get("public_address"):
        out["public"] = meta["public_address"]
    elif out["hostname"]:
        out["public"] = out["hostname"]
    if meta.get("is_default") and ROUTER_DOMAIN:
        out["also"] = ROUTER_DOMAIN
    return out
