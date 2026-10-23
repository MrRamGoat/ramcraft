# Keeping a world active while players are offline

Docker uptime and Minecraft chunk loading are separate. RamCraft containers use
`restart: unless-stopped`; a running server can still unload a player's base when
they disconnect. RCON client shutdown messages are normal status connections
closing, not the Minecraft server stopping.

For packs using FTB Chunks, inspect `data/config/ftbchunks-world.snbt` and any
world-specific override in `data/world/serverconfig/ftbchunks-world.snbt`.
The default `force_loading.force_load_mode: "default"` requires a team member to
have the `ftbchunks.chunk_load_offline` permission. Marking a chunk for loading
alone does not grant that permission.

To allow already marked chunks to keep running offline:

1. Flush the world with `save-all flush` and back up the existing configuration.
2. Copy the pack configuration into `data/world/serverconfig/ftbchunks-world.snbt`
   if no world override exists. Preserve the other settings.
3. Set `force_load_mode: "always"` inside `force_loading`. Leave
   `max_idle_days_before_unforce: 0.0d` to avoid expiry.
4. Restart the Minecraft container gracefully.
5. With zero players connected, verify a marked chunk using
   `execute in minecraft:overworld if loaded <x> <y> <z> run time query gametime`.
   Repeat later to confirm that it remains loaded and game time advances.

The world override survives modpack updates and is included with RamCraft's world
snapshots. Only chunks marked for force-loading stay loaded; normal claims do not.
Keep the existing chunk limits to bound resource use. Some mechanics still require
a nearby player, even in loaded chunks.

FTB reference: https://docs.feed-the-beast.com/mod-docs/next/mods/suite/Ranks/Integration/FTB%20XMod%20Compat/
