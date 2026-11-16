---
"@nerima-games/mc-host-web": patch
---

Queue brewing actions and present their correlated stage results without consuming inventory twice.

As a stopgap until the server protocol carries the complete three-bottle state, disable multiplayer brewing commands and show an explicit unsupported status; multiplayer brewing synchronization is unavailable.
