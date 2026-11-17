---
'@nerima-games/mc-host-web': patch
---

Update mc-server to 0.3.0 and mx-multiplayer to 0.18.0, and enable multiplayer brewing over protocol 12. Opening a brewing stand shows the server's three bottles, ingredient, fuel, fuel charges and progress. A stand the server has not yet described shows as empty with a loading status until its state arrives. Inserting, collecting and drinking are sent to the server as brewing commands. A command the server refuses because its revision moved on is sent again, up to four times. Other rejections show their reason in the brewing panel, and a click while a command is pending shows a waiting status.

Brewing states that the brewing rules reject and status effects without an amplifier are reported on the multiplayer status line and not applied. When the server uses a different protocol version, its frames are dropped and the multiplayer status line says that the server and client protocol versions differ.

Multiplayer furnaces now keep the station and the total burn time that the server sends.
