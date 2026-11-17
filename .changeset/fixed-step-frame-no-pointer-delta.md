---
'@nerima-games/mc-host-web': patch
---

Stop passing pointer movement to fixed-step ticks, carried or per tick, because the frame turns the camera once from its own input reading.
