---
'@nerima-games/mc-host-web': patch
---

Generate terrain separately for each dimension. Migrate v18 sessions once by rebuilding unedited Nether and End chunks, preserving edits, moving affected players to safe terrain, and removing non-player entities inside rebuilt chunks. Publish the migrated state and chunks atomically as v19.
