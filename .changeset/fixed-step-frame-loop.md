---
'@nerima-games/mc-host-web': patch
---

Add a fixed-step frame loop that runs 20 Hz simulation ticks independently of the render frame rate. It runs at most ten ticks per frame, discards the excess after a long stall, applies each edge input to one tick and held input to every tick, and exposes the interpolation fraction for rendering.
