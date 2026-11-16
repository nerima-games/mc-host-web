---
"@nerima-games/mc-host-web": patch
---

Keep a checkpoint of the previous healthy session revision on every save, and stop a save before it overwrites anything when the checkpoint cannot be written.

Refuse to open or overwrite a session written by a newer build or by an older build without a migration, reporting it as a typed failure. Open the checkpoint when the latest save cannot be read, and provide player-facing messages for save and open failures.
