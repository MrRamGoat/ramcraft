# RamCraft workspace

Scope: `panel/static` only. RamFLIX and other sibling projects retain their own identities.

The physical scene is a daylight desk where Ram gets a world ready before friends join. The work surface is light and quiet; graphite navigation provides a stable frame. An original SVG block landscape supplies the Minecraft character without loading a game engine or a large image.

## Visual system

- Inter for controls, headings, and body; JetBrains Mono for console and addresses.
- Light neutral `oklch(.974 .004 240)` background, white surfaces, graphite `oklch(.24 .017 247)` navigation.
- Blue `oklch(.52 .16 252)` for primary actions and selection; green, amber, and red retain state meaning.
- 7px control corners, 10–12px panels, 1px borders, minimal shadow.
- Main workspace capped at 1600px; sidebar collapses into mobile navigation at 650px.
- 150–200ms interaction transitions; reduced motion disables animation.

## Behavior

World cards retain their DOM identity across polling. Search and status filters hide cards without rebuilding the collection. Connection failures retain last-known data and visibly label it as stale. Dialogs restore focus and make the workspace inert while open. The join guide exposes actual LAN and public addresses from the API.

## Local preview

Run `node preview.cjs` and open `http://127.0.0.1:8111`. This serves local assets and proxies API requests to the live LAN host, so management actions in the preview affect real servers.
