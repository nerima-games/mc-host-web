---
'@nerima-games/mc-host-web': patch
---

Update mc-server to 0.3.0 and mx-multiplayer to 0.18.0, and enable multiplayer brewing over protocol 12. Opening a brewing stand shows the server's three bottles, ingredient, fuel, fuel charges and progress, and inserting, collecting and drinking are sent to the server as brewing commands. A rejected command shows its reason in the brewing panel. Brewing states that the brewing rules reject, status effects without an amplifier, and frames from another protocol version are reported or dropped instead of applied.

Multiplayer furnaces now keep the station and the total burn time that the server sends.
