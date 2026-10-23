# ATM10 Sky offline loading repair — 2026-09-30

Server: `mc-all-the-mods-10-to-the-sky-atm10sky`, Proxmox CT 105.

The server was healthy with zero players connected. Its Docker restart policy was
`unless-stopped`, Docker was enabled at boot, and CT 105 had `onboot: 1`.
No idle shutdown or Docker autopause was enabled.

FTB Chunks used `force_load_mode: "default"`, while the player's stored
`offline_force_loader` permission was false. All 25 force-loaded chunks therefore
lost their offline loading. A probe at overworld position `4104 64 8` confirmed
that the base chunk was unloaded before the repair.

After flushing the world, copied the pack's FTB Chunks configuration into:

`/srv/mc/all-the-mods-10-to-the-sky-atm10sky/data/world/serverconfig/ftbchunks-world.snbt`

Changed only `force_loading.force_load_mode` to `"always"`, retaining the 25-chunk
limit and zero expiry. Restarted the server gracefully. This world override is
preserved across pack updates and container recreation.

Original configuration and restoration notes:

`/srv/mc/_backups/all-the-mods-10-to-the-sky-atm10sky/offline-loading-config-20260930-054703/`

Verification: container healthy, zero players online, all 25 marked chunks loaded,
and the router answered a Minecraft status handshake for `atm.<router domain>`.
The routing check used the host's local router endpoint, not an external network.

Rollback: gracefully stop the Minecraft container, remove the newly created world
override to return to the original pack configuration, and start the container.
