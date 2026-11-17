---
'@nerima-games/mc-host-web': patch
---

Move the once-per-frame display work (weather display, projectile HUD, entity sync, player UI, crosshair, captions, frame counter and debug overlay) out of the simulation tick into a new frame presentation step.
