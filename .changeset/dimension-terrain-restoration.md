---
'@nerima-games/mc-host-web': patch
---

Generate terrain separately for each dimension. Migrate v18 sessions once while preserving terrain that holds dropped items, XP, vehicles, containers or other persisted position state. Rebuild only unedited Nether and End chunks, move affected players to safe nearby terrain, and reset affected mobs. Publish the migrated state and chunks atomically as v19 with a recoverable checkpoint.
