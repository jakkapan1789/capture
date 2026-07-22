/**
 * Fail if the frontend calls a plugin API the app has not been granted.
 *
 * Tauri v2 gates plugin commands behind capabilities, and a missing one fails at
 * runtime, in the click that needed it. Nothing else catches this: the headless
 * harness stubs `__TAURI_INTERNALS__.invoke`, so no capability is ever consulted,
 * and `tsc` sees a perfectly good import. It cost a debugging session when
 * `writeText` turned out to be ungranted while `writeImage` was - OCR looked
 * broken because the copy at the end of it was refused.
 *
 * The map is deliberately small: only what this app imports. An unknown import
 * is an error rather than a silent pass, so adding a plugin call forces a
 * decision here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REQUIRED = {
  "plugin-clipboard-manager": {
    writeText: "clipboard-manager:allow-write-text",
    writeImage: "clipboard-manager:allow-write-image",
    readText: "clipboard-manager:allow-read-text",
    readImage: "clipboard-manager:allow-read-image",
  },
  "plugin-opener": {
    openUrl: "opener:allow-open-url",
    openPath: "opener:allow-open-path",
    revealItemInDir: "opener:allow-reveal-item-in-dir",
  },
  "plugin-dialog": {
    save: "dialog:allow-save",
    open: "dialog:allow-open",
    message: "dialog:allow-message",
    confirm: "dialog:allow-confirm",
    ask: "dialog:allow-ask",
  },
  "plugin-fs": {
    writeFile: "fs:allow-write-file",
    readFile: "fs:allow-read-file",
    remove: "fs:allow-remove",
    mkdir: "fs:allow-mkdir",
  },
  "api/event": { listen: "core:event:allow-listen", emit: "core:event:allow-emit" },
  // `invoke` reaches this app's own commands, which need no capability, and
  // getCurrentWindow is a handle rather than a call.
  "api/core": { invoke: null },
  "api/window": { getCurrentWindow: null },
};

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

const granted = new Set(
  JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")).permissions.filter(
    (permission) => typeof permission === "string",
  ),
);

const problems = [];
const importPattern = /import\s*{([^}]*)}\s*from\s*"@tauri-apps\/([^"]+)"/g;

for (const file of sourceFiles("src")) {
  const source = readFileSync(file, "utf8");
  for (const [, names, module] of source.matchAll(importPattern)) {
    const table = REQUIRED[module];
    if (!table) {
      problems.push(`${file}: unknown Tauri module "${module}" - add it to ${import.meta.url.split("/").pop()}`);
      continue;
    }
    for (const raw of names.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (!name) continue;
      if (!(name in table)) {
        problems.push(`${file}: unknown import "${name}" from ${module} - add its permission to the map`);
        continue;
      }
      const permission = table[name];
      if (permission && !granted.has(permission)) {
        problems.push(`${file}: ${name}() needs "${permission}", which is not in capabilities/default.json`);
      }
    }
  }
}

// Every window the backend creates must be listed in the capability, or it
// starts with no permissions at all - `listen` fails and the window simply never
// receives anything, which looks like a broken feature rather than a blocked
// one. Found the hard way, and cheap to keep watching for.
const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
const allowedWindows = new Set(capability.windows ?? []);
const rust = readFileSync("src-tauri/src/commands.rs", "utf8");

for (const [, name, label] of rust.matchAll(/pub const (\w*LABEL): &str = "([^"]+)"/g)) {
  if (!allowedWindows.has(label)) {
    problems.push(
      `src-tauri/src/commands.rs: window "${label}" (${name}) is not in capabilities/default.json ` +
        `windows - it would start with no permissions`,
    );
  }
}

if (problems.length > 0) {
  console.error("Capability check failed:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log("capabilities: every plugin call the frontend makes is granted");
