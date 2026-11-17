---
'@nerima-games/mc-host-web': patch
---

Update mc-render to 0.15.0. Each simulation tick now reads held keys and key presses from the frame's single input reading, so a key pressed or released while a frame runs is neither lost nor seen differently by the ticks of one frame.
