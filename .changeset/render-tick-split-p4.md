---
'@nerima-games/mc-host-web': patch
---

Run the simulation at a fixed 20 ticks per second and draw once per animation frame. Before, the world advanced 40 ticks per second at any frame rate of 20 fps or more, and nothing drew between ticks. The view turns once per frame, even on a frame that runs no tick.
