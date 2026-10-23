# Porting

W5 moves the browser host from `mc-compose/apps/` into this package. The scope includes DOM integration, startup wiring, adapters, animation-frame scheduling, lifecycle handling, QA installation, browser E2E, and shared test helpers.

The plan also assigns a Pages workflow to this package. Server composition, CLI, and file persistence move to `mc-server`; game rules move to their domain packages.
