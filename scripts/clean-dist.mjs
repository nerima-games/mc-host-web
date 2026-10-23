import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

await fs.rm(path.resolve(root, "dist"), { force: true, recursive: true });
