---
"@nerima-games/mc-host-web": patch
---

Add the `runtime.qaCatalog` QA operation, which lists every fully qualified operation name in the composed QA registry, including module registrations and itself.

Add the `gameplay.seedVillagerRestockPersistence` QA fixture. It advances a zero villager restock clock by one second through the villager-trades owner coordinator, marks the session dirty without flushing, and fails with `QaVillagerRestockNotFresh` when the clock has already advanced.
