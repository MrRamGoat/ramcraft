# RamCraft

One-click Minecraft server hosting with a web GUI — modpacks, adventure maps and plain
servers, each in its own Docker container, started and stopped from a browser.

Built 2026-09-21. Source of truth lives here on the workstation; `deploy.sh` pushes it to the box.

---

## Where it runs

| | |
|---|---|
| **Host** | LXC **105** `ramflix-craft` on the Proxmox node `ramflix` (192.168.1.58) |
| **IP** | **192.168.1.63** |
| **Panel** | **http://192.168.1.63:8110** |
| **Resources** | 6 cores · 24 GB RAM · 200 GB rootfs on `local-lvm` · `onboot: 1` |
| **Server data** | `/srv/mc/<server-id>/data` (bind-mounted into each container) |
| **Backups** | `/srv/mc/_backups/<server-id>/*.tar.gz` |
| **Settings** | `/srv/mc/_ramcraft-settings.json` |
| **Game ports** | 25565–25640, auto-assigned; first server gets 25565 |

Nothing here touches the media stack on LXC 101. It is a separate container with its own
Docker daemon.

## What it does

- **Modpacks** — searches the live Modrinth catalogue in the panel. Pick a pack, pick a
  version, press Create. It downloads the pack, the right mod loader and the right Java,
  then boots. CurseForge packs work too (needs a free API key in Settings).
- **Adventure maps** — drop in a world `.zip` (or a direct link); it is unpacked as the world
  and served on whichever server type/version you choose.
- **CurseForge packs with no API key** — upload the pack's **Server Pack** zip.
- **Plain servers** — Vanilla, Paper, Purpur, Fabric, Forge, NeoForge, Quilt, Spigot.
- **Start / Stop / Restart** per server from the card.
- **Console** with live log streaming and a command box (over RCON).
- **Backups** — manual button plus a nightly cron, world-only, with restore and download.
- **Players online** per server, read live over RCON.

## Architecture

```
LXC 105  ─┬─ ramcraft (FastAPI panel, :8110)  ── docker.sock ──┐
          │                                                    │
          ├─ mc-<id>   itzg/minecraft-server  :25565 ──────────┘
          ├─ mc-<id2>  itzg/minecraft-server  :25566
          └─ ...          all on the `ramcraft` docker network
```

The panel talks to the Docker daemon directly — every Minecraft server is one
`itzg/minecraft-server` container. `/srv/mc` is mounted at the **same path** inside the
panel container so the bind mounts it creates resolve correctly on the host.

RCON is reachable panel→server by container name on the shared network; it is never
published to the LAN.

### Files

| File | Purpose |
|---|---|
| `panel/app.py` | FastAPI routes: servers, catalogue, console, backups, settings |
| `panel/servers.py` | Container lifecycle, metadata, status, backups, port allocation |
| `panel/rcon.py` | Minimal async Source RCON client |
| `panel/static/` | The UI (vanilla JS, no build step) |
| `panel/mcping.py` | Server List Ping client — proves hostname routing from the CLI |
| `docker-compose.yml` | The panel + mc-router + the `ramcraft` network |
| `deploy.sh` | Sync source → LXC 105 → rebuild |

Verify routing without a Minecraft client:

```bash
ssh pve "pct exec 105 -- python3 /opt/ramcraft/panel/mcping.py 192.168.1.63 25565 create-oneblock.mc.ramflix.xyz"
```

## Deploying changes

```bash
bash deploy.sh
```

This always rebuilds the image. The Dockerfile bakes the source in with `COPY . .`, so a
plain `--force-recreate` would silently keep running the old code.

## Things that bit us, keep in mind

- **Java version must match the Minecraft version.** The itzg image cannot switch JVMs at
  runtime, so `pick_image()` chooses the tag: `java8` for ≤1.16, `java17` up to 1.20.4,
  `java21` above. Old modpacks fail to boot on the wrong one.
- **Backups must flush first.** A running server keeps the world in memory. Tarring without
  `save-off` + `save-all flush` produces an archive with no `level.dat` and no region files —
  it looks like it worked. `save-on` runs in a `finally` so a failed tar never leaves saving
  disabled.
- **Route order in FastAPI is real.** A `POST /servers/{sid}/{action}` catch-all shadows every
  sibling route declared after it — it silently swallowed `/command`. Actions are namespaced
  under `/actions/` now, and `/actions/backup` is declared *before* the catch-all.
- **Container memory limit is heap + 2 GB.** Modded servers use well over 1 GB of non-heap
  (metaspace, direct buffers, GC). Too tight a limit gets the container OOM-killed, which
  reads as a random crash.
- **`/proc/meminfo` inside an LXC reports the hypervisor's RAM**, not the container's. The
  panel is told its budget via `RAMCRAFT_MEM_BUDGET_GB` and reports *committed* RAM.
- **`pct restart` is not a Proxmox command** — it prints usage and does nothing. Use
  `pct reboot`.
- **Stop timeout is 120 s on purpose.** A big modded world takes a while to save; killing it
  early corrupts worlds.
- **mc-router runs as uid 65532** and cannot read the `0660 root:docker` socket. It is given
  `group_add: ["991"]` (the docker gid inside LXC 105) rather than being run as root. If the
  gid ever changes, `stat -c '%g' /var/run/docker.sock` and update compose, or the router
  crash-loops with `permission denied` on the socket.
- **CSS attribute selectors miss bare `<input>`.** A selector list of `input[type=text]`,
  `input[type=search]` … silently leaves `<input id="x">` (no `type`) on the browser's default
  white background. The rule matches `input:not([type=checkbox]):not([type=radio])` now.
- **Never rebuild the card grid with `innerHTML` on a timer.** The 5 s poll destroyed whatever
  button the cursor was over, so a click landing in that window hit a detached node and did
  nothing — it read as "the UI is stuck". Cards are built once and patched in place.
- **Appending log lines one at a time froze the tab for ~29 s.** Each `appendLog` read
  `scrollHeight` and wrote `scrollTop`, forcing a reflow per line; 250 + streamed lines on a
  growing console blocked the main thread. Lines are buffered and flushed in one batch with a
  single layout read and a single write.
- **Do not schedule that flush with `requestAnimationFrame`.** rAF is paused entirely while
  the window is hidden or minimised, so the buffer never drains and the console sits empty.
  `setTimeout` fires regardless.
- **The log stream must use `tail=0`.** The panel draws the backlog with a plain `logs` fetch;
  a backlog on the SSE stream too renders every one of those lines twice.
- **Deleting a server must also delete its backups.** They live in `_backups/<id>/`, outside
  the server directory, so wiping only the server directory left them behind forever.
  `/api/maintenance` reports orphans; `/api/maintenance/cleanup` removes them.

## Addressing — one name per server, automatically

Every server is reachable at **`<subdomain>.mc.ramflix.xyz`** with **no port**, from the
moment it starts. Nothing is configured per server.

This works because a Minecraft client puts the hostname it dialled inside its handshake.
**`itzg/mc-router`** owns port 25565, reads that hostname, and forwards to the right backend.
The panel writes an `mc-router.host` label onto each server container; mc-router watches
Docker events and wires the route the instant the container appears — no API call, no restart.

```
player types  skyblock.mc.ramflix.xyz
      │
      ▼  (wildcard DNS → home IP, router forwards 25565)
  mc-router :25565  ── reads handshake hostname ──┐
                                                  ├─ mc-skyblock:25565
                                                  └─ mc-oneblock:25565
```

Consequences worth knowing:

- **25565 belongs to mc-router**, so per-server LAN ports start at **25566**. A server's own
  port is only ever needed as a direct fallback — the hostname does not use it.
- Ports are assigned lowest-free at creation, so they are not contiguous after deletions.
  Change one in Manage → Settings.
- The LAN address (`192.168.1.63:25566`) hits the container directly, bypassing the router.

### Split DNS — the hostname indoors too

The house router has **no NAT loopback**, so from inside, `<server>.mc.ramflix.xyz` resolves to
the WAN IP and the connection dies at the router. The `ramcraft-dns` service (dnsmasq, port 53)
answers that domain with `192.168.1.63` instead, so the *same address works indoors and out* —
mc-router still reads the hostname from the handshake exactly as it does for outside players.

Everything outside the RamCraft domain is forwarded to 1.1.1.1 / 8.8.8.8 untouched, so
`watch.ramflix.xyz` and the rest are unaffected.

**There are two resolvers, deliberately mirrored:**

| | |
|---|---|
| Primary | `192.168.1.63` — `ramcraft-dns` container on LXC 105 |
| Secondary | `192.168.1.58` — native dnsmasq on the PVE host (`/etc/dnsmasq.d/ramcraft.conf`) |

They must give **identical** answers for the RamCraft domain. A backup resolver that returned
the public IP would make the hostname work only intermittently — worse than not working, and
far harder to diagnose. The PVE host's own `/etc/resolv.conf` still points at 1.1.1.1, so the
hypervisor never depends on its own dnsmasq.

Set both in the router's DHCP so every device in the house gets them automatically. Verify:

```bash
dig +short anything.mc.ramflix.xyz @192.168.1.63 && dig +short anything.mc.ramflix.xyz @192.168.1.58
```

Both must print `192.168.1.63`. A zero-infrastructure alternative is a `hosts` file entry per
server, but it cannot do wildcards, so every new server needs another line.
- One server can be flagged **default**, which also routes the bare `mc.ramflix.xyz` to it.
- `GET /api/host` includes `router.routes` — what mc-router actually believes. It is the
  fastest way to tell a DNS problem from a routing problem. Settings shows it too.

### The two one-time setup steps — both done 2026-09-21

1. **Cloudflare DNS** — `A` record, name `*.mc`, value = the home WAN IP,
   **DNS only (grey cloud)**. Proxying would break it: Cloudflare's proxy is HTTP-only.
2. **Router** — forward TCP **25565** → `192.168.1.63`.

That is all, forever. New servers need no DNS and no forwarding.

**The house router is a Huawei ONT** (HG8145/OptiXstar class). Port forwarding is under
*Forward Rules → Port Mapping Configuration*, and the **WAN name** dropdown is the trap: these
units carry several WANs (INTERNET / VOIP / TR-069) and a rule on the wrong one saves, lists,
and forwards nothing. It must be the `…INTERNET…` entry. Protocol is not the issue.

### Verifying from outside — never test from the LAN

The Bezeq router has **no NAT loopback**, so any connection test from inside the house hits the
router's own admin page instead of traversing the forward. It looks exactly like a broken
forward and is not. Use a real outside vantage:

```bash
curl -s "https://api.mcstatus.io/v2/status/java/create-oneblock.mc.ramflix.xyz" | python3 -m json.tool
```

That one call proves DNS, the port forward, hostname routing and the server in one shot — it
speaks real Minecraft from their infrastructure. For a plain TCP reachability check across
several countries, `check-host.net`:

```bash
curl -s -H 'Accept: application/json' "https://check-host.net/check-tcp?host=85.130.139.168:25565&max_nodes=6"
```

then `GET /check-result/<request_id>` after ~15 s.

⚠️ A `tcpdump` backgrounded inside `pct exec` does **not** survive the exec returning — it
captures nothing and reads as "no packets arrived". Do not trust that as evidence.

**The panel itself** is plain HTTP and works fine through a **Cloudflare Tunnel** — add a
public hostname pointing at `http://192.168.1.63:8110`.

**The game cannot go through a Cloudflare Tunnel.** cloudflared on the free plan proxies HTTP
only, and Minecraft speaks raw TCP; arbitrary TCP needs Cloudflare Spectrum, which is
enterprise-only. If port-forwarding is unacceptable, run a **playit.gg** agent pointed at
`192.168.1.63:25565` and put the address it hands out in each server's *Override the public
address* field — but then hostname routing is bypassed and each server needs its own tunnel.

## Getting packs and maps in without an API key

Uploads land in `/srv/mc/_uploads` and are bind-mounted **read-only into every Minecraft
container at `/modpacks`**. That mount is the whole trick: the container otherwise only sees
its own `/data`, so a host path like `/srv/mc/_uploads/x.zip` would simply not exist to it.
`build_env()` rewrites any non-URL pack or world path to `/modpacks/<basename>`.

- **CurseForge-only packs** (All the Mods, RLCraft, DawnCraft…) — download the pack's
  **Server Pack** zip from its Files tab in a browser and upload it. This uses the legacy
  `TYPE=CURSEFORGE` + `CF_SERVER_MOD` path, which takes a zip by file or URL and needs
  **no API key at all**. The key only buys pasting a URL instead.
- **Adventure maps** — same, via `WORLD`, which also accepts a local file or a URL.

⚠️ **Map sites serve page links, not files, and block server-side fetches.** Pasting a Planet
Minecraft link downloads an HTML page and the server dies with
`Unsupported archive type: text/html`, then `403 Forbidden` on retry. The create form now
refuses any adventure-map URL that is not a direct `.zip` and tells you to upload instead.

Sources that work: Planet Minecraft, MinecraftMaps, CurseForge Worlds (all download-then-upload).
Modrinth hosts no maps. Neither Modrinth nor FTB carries All the Mods — it is CurseForge-only.

## Network isolation (DMZ)

LXC 105 is the only thing in the house reachable from the internet, so it is firewalled as a
DMZ via the **Proxmox firewall** (`/etc/pve/firewall/105.fw`): it may serve the LAN and reach
the internet, but may **not open connections into the LAN**. If the Minecraft server is ever
compromised, the attacker cannot see the NAS (.57), Proxmox (.58) or the media stack (.60).

```
IN   25565           from anywhere          ACCEPT   (the point of the box)
IN   8110, 53, 22    from 192.168.1.0/24    ACCEPT
IN   25566-25640     from 192.168.1.0/24    ACCEPT
OUT  -> 192.168.1.0/24                      DROP     <-- the isolation
OUT  -> anywhere else                       ACCEPT
```

It is stateful, so replies to connections the LAN opened still flow — the panel and DNS keep
working. Only *new* outbound flows into the LAN are dropped.

### ⚠️ Enabling this was the dangerous part — read before touching the firewall

LXC **101, 104 and 105 all carry `firewall=1` on their NIC**, and there were no `.fw` files at
all. PVE's default guest policy is `policy_in: DROP`, so simply switching the datacenter
firewall on would have **instantly cut off Jellyfin and the entire media stack**.

Guarding that needs two things, both already in place:

- `/etc/pve/firewall/101.fw` and `104.fw` contain an explicit **`enable: 0`** so those guests
  keep behaving exactly as before. Do not delete them.
- `/etc/pve/firewall/cluster.fw` sets `policy_in`/`policy_out` to **ACCEPT**, so the host and
  any unlisted guest are unaffected.

Also: **192.168.1.1 was removed from LXC 105's nameservers** (`pct set 105 --nameserver
'1.1.1.1 8.8.8.8'`). Blocking the LAN also blocks DNS to the router, so leaving it would have
made every lookup wait for a timeout first.

Verify isolation after any change:

```bash
ssh pve "pct exec 105 -- timeout 4 bash -c '</dev/tcp/192.168.1.57/9999'" && echo REACHABLE || echo BLOCKED
```

## Performance

- **`SIMULATION_DISTANCE` is the biggest lever**, defaulted to `min(view_distance, 6)`.
  View distance only *sends* chunks; simulation distance is what the server actually ticks —
  mobs, redstone, crops, hoppers. Leaving them equal makes the server do far more work than
  players can perceive. Both are editable per server.
- `USE_AIKAR_FLAGS=true` on every server (tuned G1GC settings).
- `MAX_TICK_TIME=-1` for modded servers only. A heavy modpack routinely blows past the 60 s
  watchdog while generating chunks and the watchdog's response is to kill the server, which
  reads as a random crash. Vanilla keeps its watchdog — there it is a real signal.
- LXC 105 has **8 cores**. Minecraft's main tick loop is single-threaded, so more cores mainly
  help chunk generation and stop concurrent servers fighting each other.
- Memory is not speed. Over-allocating a heap makes GC pauses *longer*. 4–6 GB suits most
  modpacks; reach for 8–10 GB only for genuinely huge ones.

## Housekeeping

Deleting a server removes its world **and** its backups. Base images are left alone on delete
(shared, ~1.2 GB each, and dropping one forces a re-download next time).

`GET /api/maintenance` lists orphaned directories and backups; `POST /api/maintenance/cleanup`
removes them and prunes unreferenced `itzg/minecraft-server` images and dangling volumes. The
panel exposes it as **Settings → Clean up leftovers**.

## Nightly backups

`/usr/local/bin/ramcraft-backup.sh` in LXC 105, driven by `/etc/cron.d/ramcraft-backup`
at 04:30. Backs up every server, keeps the newest 7 each, logs to
`/var/log/ramcraft-backup.log`. Change retention with `RAMCRAFT_KEEP`.

## Handy commands

```bash
ssh pve "pct exec 105 -- docker ps"
```

```bash
ssh pve "pct exec 105 -- docker logs --tail 50 mc-<server-id>"
```

```bash
ssh pve "pct exec 105 -- bash /usr/local/bin/ramcraft-backup.sh"
```
