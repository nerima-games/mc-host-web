---
'@nerima-games/mc-host-web': patch
---

Update mx-gameplay to 0.13.0 and mc-audio to 0.7.0. Endermen now become hostile after the player stares at them. Enchantment levels from the multiplayer server and from anvil results are validated before they reach the inventory, and an invalid level is reported instead of stored. Sound and music playback is unchanged, because the game never used the sound data mc-audio removed.
