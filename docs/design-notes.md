# Design Notes

Browser DOM and animation-frame code belongs in `mc-host-web`; process and file operations belong in `mc-server`. This boundary keeps browser-only APIs out of server code.
