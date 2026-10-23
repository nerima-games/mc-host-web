import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EMPTY_COUNT = 0;
const FIRST_ARCHIVE_INDEX = 0;
const JSON_INDENT = 2;
const EXPECTED_ARCHIVE_COUNT = 1;
const JSON_REPLACER = (_key, value) => value;

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8")
);
const typeScriptCompiler = path.join(
  root,
  "node_modules",
  "typescript",
  "bin",
  "tsc"
);

const failOnCommand = (command, args, options = {}) => {
  const result = childProcess.spawnSync(
    command,
    args,
    Object.assign(Object.create(null), { cwd: root, encoding: "utf8" }, options)
  );
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${command} was terminated by ${result.signal}`);
  }
  if (result.status !== EMPTY_COUNT) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
};

const capture = (command, args, options = {}) => {
  const result = failOnCommand(
    command,
    args,
    Object.assign(Object.create(null), { stdio: "pipe" }, options)
  );
  return result.stdout;
};

const exportTargets = [];
for (const target of Object.values(manifest.exports)) {
  if (typeof target === "string") {
    exportTargets.push(target);
  } else {
    for (const candidate of [target.types, target.import, target.default]) {
      if (typeof candidate === "string") {
        exportTargets.push(candidate);
      }
    }
  }
}
if (exportTargets.length === EMPTY_COUNT) {
  throw new Error("package.json must declare at least one export target");
}

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), "mc-host-web-package-")
);
const packDirectory = path.join(workspace, "pack");
const consumerDirectory = path.join(workspace, "consumer");
await fs.mkdir(packDirectory);
await fs.mkdir(consumerDirectory);

try {
  failOnCommand(
    "pnpm",
    ["pack", "--pack-destination", packDirectory],
    { timeout: 60_000 }
  );

  const packEntries = await fs.readdir(packDirectory);
  const archives = packEntries.filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== EXPECTED_ARCHIVE_COUNT) {
    throw new Error(`Expected one package archive, found ${archives.length}`);
  }

  const archivePath = path.join(
    packDirectory,
    archives[FIRST_ARCHIVE_INDEX]
  );
  const archive = await fs.stat(archivePath);
  if (archive.size === EMPTY_COUNT) {
    throw new Error("Package archive is empty");
  }

  const archiveEntries = new Set(
    capture("tar", ["-tzf", archivePath], { timeout: 30_000 })
      .trim()
      .split("\n")
      .filter(Boolean)
  );
  for (const target of exportTargets) {
    const archiveEntry = `package/${target.replace(/^\.\//, "")}`;
    if (!archiveEntries.has(archiveEntry)) {
      throw new Error(`Package archive is missing ${archiveEntry}`);
    }
  }

  await fs.writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      { name: "mc-host-web-consumer", private: true, type: "module" },
      JSON_REPLACER,
      JSON_INDENT
    )}\n`
  );
  failOnCommand(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archivePath
    ],
    { cwd: consumerDirectory, timeout: 180_000 }
  );

  const runtimeProbe = `
    import * as packageExports from ${JSON.stringify(manifest.name)};
    if (Object.keys(packageExports).length === ${EMPTY_COUNT}) {
      throw new Error('The package root has no runtime exports');
    }
  `;
  failOnCommand(
    process.execPath,
    ["--input-type=module", "--eval", runtimeProbe],
    { cwd: consumerDirectory, timeout: 30_000 }
  );

  const typeConsumer = `
import * as packageExports from ${JSON.stringify(manifest.name)};
const exportedValues: readonly unknown[] = Object.values(packageExports);
if (exportedValues.length === 0) {
  throw new Error("The package root has no declaration exports");
}
`;
  await fs.writeFile(path.join(consumerDirectory, "consumer.ts"), typeConsumer);
  await fs.writeFile(
    path.join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2024"
        },
        files: ["consumer.ts"]
      },
      JSON_REPLACER,
      JSON_INDENT
    )}\n`
  );
  failOnCommand(
    process.execPath,
    [
      typeScriptCompiler,
      "--project",
      path.join(consumerDirectory, "tsconfig.json"),
      "--pretty",
      "false"
    ],
    { cwd: consumerDirectory, timeout: 30_000 }
  );

  process.stdout.write(
    `verified ${manifest.name} package exports and declarations\n`
  );
} finally {
  await fs.rm(workspace, { force: true, recursive: true });
}
