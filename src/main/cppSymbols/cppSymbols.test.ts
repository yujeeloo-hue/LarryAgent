import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  listIndexedPaths,
  lookupCppSymbols,
  lookupCppSymbolsFromFile,
  openCppSymbolDatabase,
  readCppExtraRoots,
  readScannerVersion,
  searchCppSymbols,
  writeCppExtraRoots,
} from "./db.js";
import { enumerateCppFiles, isSkippedSymbolDir } from "./enumerate.js";
import {
  ensureCppSymbolGitignored,
  gitignoreHasCppSymbolEntries,
} from "./gitignore.js";
import { cppSymbolDatabasePath, normalizeSymbolPath } from "./paths.js";
import { scanCppSymbolDatabase } from "./scanWorkspace.js";
import { CPP_SYMBOL_GITIGNORE_LINES, CPP_SYMBOL_SCANNER_VERSION } from "./types.js";

const HEADER = `#pragma once
class Demo {
public:
    void BeginPlay();
    float Health;
};
`;

const SOURCE = `#include "Demo.h"
void Demo::BeginPlay() {}
`;

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cpp-symbols-"));
}

test("enumerate skips generated trees, Engine, and dot directories", async () => {
  const root = await tempProject();
  try {
    await mkdir(join(root, "Source"), { recursive: true });
    await mkdir(join(root, "Engine", "Source"), { recursive: true });
    await mkdir(join(root, "Content"), { recursive: true });
    await mkdir(join(root, "Intermediate"), { recursive: true });
    await mkdir(join(root, ".jellybot"), { recursive: true });
    await writeFile(join(root, "Source", "Demo.h"), HEADER);
    await writeFile(join(root, "Engine", "Source", "Hidden.h"), HEADER);
    await writeFile(join(root, "Content", "Asset.h"), HEADER);
    await writeFile(join(root, "Intermediate", "Gen.cpp"), SOURCE);
    await writeFile(join(root, ".jellybot", "Skip.h"), HEADER);
    const files = await enumerateCppFiles(root);
    assert.deepEqual(
      files.map((path) => path.slice(normalizeSymbolPath(root).length + 1)),
      ["Source/Demo.h"],
    );
    assert.equal(isSkippedSymbolDir(".jellybot"), true);
    assert.equal(isSkippedSymbolDir("Engine"), true);
    assert.equal(isSkippedSymbolDir("Source"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symbol database updates by mtime and answers name lookup", async () => {
  const root = await tempProject();
  const header = join(root, "Source", "Demo.h");
  const source = join(root, "Source", "Demo.cpp");
  try {
    await mkdir(join(root, "Source"), { recursive: true });
    await writeFile(header, HEADER);
    await writeFile(source, SOURCE);
    const db = openCppSymbolDatabase(cppSymbolDatabasePath(root));
    try {
      const first = await scanCppSymbolDatabase({ db, root });
      assert.equal(first.stopped, false);
      assert.equal(first.filesTotal, 2);
      assert.equal(first.filesDone, 2);
      const headerPath = listIndexedPaths(db).find((path) =>
        path.endsWith("Demo.h"),
      );
      assert.ok(headerPath);
      const begin = lookupCppSymbols(db, "beginplay");
      assert.equal(begin.length, 2);
      assert.ok(begin.some((hit) => hit.path === headerPath && !hit.isImpl));
      assert.ok(begin.some((hit) => hit.isImpl === true));
      const health = lookupCppSymbols(db, "Health");
      assert.equal(health.length, 1);
      assert.equal(health[0]!.kind, "variable");
      assert.equal(health[0]!.container, "Demo");

      db.prepare(
        `INSERT INTO symbols (
          name, name_lower, kind, path, line, is_impl
        ) VALUES ('Bogus', 'bogus', 'function', ?, 1, 0)`,
      ).run(headerPath);
      await scanCppSymbolDatabase({ db, root });
      assert.equal(lookupCppSymbols(db, "Bogus").length, 1);

      await writeFile(source, `${SOURCE}\nvoid Demo::Tick() {}\n`);
      await scanCppSymbolDatabase({ db, root });
      assert.equal(lookupCppSymbols(db, "Tick").length, 1);
      assert.equal(lookupCppSymbols(db, "Bogus").length, 1);

      await rm(header);
      await scanCppSymbolDatabase({ db, root });
      assert.equal(
        lookupCppSymbols(db, "BeginPlay").some((hit) => hit.path === headerPath),
        false,
      );
      assert.equal(lookupCppSymbols(db, "Bogus").length, 0);
      assert.equal(lookupCppSymbols(db, "Health").length, 0);
      assert.ok(lookupCppSymbols(db, "BeginPlay").some((hit) => hit.isImpl));

      const fromFile = lookupCppSymbolsFromFile(
        cppSymbolDatabasePath(root),
        "Tick",
      );
      assert.equal(fromFile.length, 1);
      assert.equal(fromFile[0]!.name, "Tick");
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stopped enumerate does not drop rows that were not visited", async () => {
  const root = await tempProject();
  try {
    await mkdir(join(root, "Source"), { recursive: true });
    await writeFile(join(root, "Source", "Demo.h"), HEADER);
    const db = openCppSymbolDatabase(cppSymbolDatabasePath(root));
    try {
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('scanner_version', '${CPP_SYMBOL_SCANNER_VERSION}')`,
      ).run();
      db.prepare(
        "INSERT INTO files (path, mtime_ms, size_bytes) VALUES ('gone.h', 1, 1)",
      ).run();
      const result = await scanCppSymbolDatabase({
        db,
        root,
        shouldStop: () => true,
      });
      assert.equal(result.stopped, true);
      assert.ok(listIndexedPaths(db).includes("gone.h"));
      assert.equal(lookupCppSymbols(db, "BeginPlay").length, 0);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a scanner version mismatch rebuilds the database", async () => {
  const root = await tempProject();
  try {
    await mkdir(join(root, "Source"), { recursive: true });
    await writeFile(join(root, "Source", "Demo.h"), HEADER);
    const db = openCppSymbolDatabase(cppSymbolDatabasePath(root));
    try {
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('scanner_version', '${CPP_SYMBOL_SCANNER_VERSION - 1}')`,
      ).run();
      db.prepare(
        "INSERT INTO files (path, mtime_ms, size_bytes) VALUES ('stale.h', 1, 1)",
      ).run();
      await scanCppSymbolDatabase({ db, root });
      assert.equal(readScannerVersion(db), CPP_SYMBOL_SCANNER_VERSION);
      assert.equal(listIndexedPaths(db).includes("stale.h"), false);
      assert.ok(lookupCppSymbols(db, "BeginPlay").length > 0);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extra scan roots index engine trees and prune when removed", async () => {
  const root = await tempProject();
  const engineBase = await tempProject();
  // The extra root is itself named `Engine` — walker rule: a root's own
  // name is never checked, so its children still get indexed.
  const engineRoot = join(engineBase, "Engine");
  try {
    await mkdir(join(root, "Source"), { recursive: true });
    await writeFile(join(root, "Source", "Demo.h"), HEADER);
    await mkdir(join(engineRoot, "Source", "Runtime", "Core"), {
      recursive: true,
    });
    await writeFile(
      join(engineRoot, "Source", "Runtime", "Core", "CoreTypes.h"),
      HEADER,
    );
    // Generated tree below the extra root stays out (skip list applies at
    // any depth below the root).
    await mkdir(join(engineRoot, "Intermediate"), { recursive: true });
    await writeFile(join(engineRoot, "Intermediate", "Gen.h"), HEADER);

    const db = openCppSymbolDatabase(cppSymbolDatabasePath(root));
    try {
      writeCppExtraRoots(db, [normalizeSymbolPath(engineRoot)]);
      assert.deepEqual(readCppExtraRoots(db), [normalizeSymbolPath(engineRoot)]);

      const withEngine = await scanCppSymbolDatabase({
        db,
        root,
        extraRoots: readCppExtraRoots(db),
      });
      assert.equal(withEngine.stopped, false);
      assert.equal(withEngine.filesTotal, 2);
      const engineHit = lookupCppSymbols(db, "BeginPlay").find((hit) =>
        hit.path.includes("CoreTypes.h"),
      );
      assert.ok(engineHit, "engine header symbol missing");

      // Removing the root prunes exactly the engine rows on the next scan.
      writeCppExtraRoots(db, []);
      await scanCppSymbolDatabase({
        db,
        root,
        extraRoots: readCppExtraRoots(db),
      });
      assert.equal(
        lookupCppSymbols(db, "BeginPlay").some((hit) =>
          hit.path.includes("CoreTypes.h"),
        ),
        false,
      );
      assert.equal(
        lookupCppSymbols(db, "BeginPlay").some((hit) =>
          hit.path.includes("Demo.h"),
        ),
        true,
      );

      // Roots live in `meta`, which a version rebuild never clears.
      writeCppExtraRoots(db, [normalizeSymbolPath(engineRoot)]);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('scanner_version', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
      ).run();
      await scanCppSymbolDatabase({
        db,
        root,
        extraRoots: readCppExtraRoots(db),
      });
      assert.deepEqual(readCppExtraRoots(db), [normalizeSymbolPath(engineRoot)]);
      assert.equal(lookupCppSymbols(db, "Health").length, 2);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(engineBase, { recursive: true, force: true });
  }
});

test("gitignore gains the symbol database once", async () => {
  const root = await tempProject();
  try {
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    await ensureCppSymbolGitignored(root);
    const once = await readFile(join(root, ".gitignore"), "utf8");
    assert.equal(gitignoreHasCppSymbolEntries(once), true);
    const lines = once.split(/\r?\n/).map((line) => line.trim());
    for (const line of CPP_SYMBOL_GITIGNORE_LINES) {
      assert.equal(lines.filter((entry) => entry === line).length, 1);
    }
    assert.equal(
      lines.filter((entry) => entry.startsWith("# C++ symbol index")).length,
      1,
    );
    await ensureCppSymbolGitignored(root);
    const twice = await readFile(join(root, ".gitignore"), "utf8");
    assert.equal(twice, once);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const TS_SOURCE = `export class TurnHost {
  start(root: string): void {}
}
export function createTurnHost(): TurnHost {
  return new TurnHost();
}
export const MAX_FILES = 4000;
`;

const CSS_SOURCE = `:root {
  --accent: #58a6ff;
}
.toolbar { color: var(--accent); }
@keyframes pulse { 0% { opacity: 1; } }
`;

test("the index stores TS and CSS symbols alongside C++", async () => {
  const root = await tempProject();
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "Source"), { recursive: true });
    await writeFile(join(root, "Source", "Demo.h"), HEADER);
    await writeFile(join(root, "src", "turnHost.ts"), TS_SOURCE);
    await writeFile(join(root, "src", "theme.css"), CSS_SOURCE);

    const enumerated = await enumerateCppFiles(root);
    const rels = enumerated.map((p) =>
      p.slice(normalizeSymbolPath(root).length + 1),
    );
    assert.ok(rels.includes("Source/Demo.h"));
    assert.ok(rels.includes("src/turnHost.ts"));
    assert.ok(rels.includes("src/theme.css"));

    const db = openCppSymbolDatabase(cppSymbolDatabasePath(root));
    try {
      const scan = await scanCppSymbolDatabase({ db, root });
      assert.equal(scan.stopped, false);

      // TS: class row (exact) + method with container via its own name.
      const ts = searchCppSymbols(db, { query: "TurnHost" });
      assert.equal(ts.mode, "exact");
      assert.ok(ts.hits.some((h) => h.kind === "class" && h.name === "TurnHost"));

      const start = searchCppSymbols(db, { query: "start" });
      const startHit = start.hits.find((h) => h.name === "start");
      assert.ok(startHit);
      assert.equal(startHit?.kind, "function");
      assert.equal(startHit?.container, "TurnHost");
      assert.equal(startHit?.params, "root: string");

      const fn = searchCppSymbols(db, { query: "createTurnHost" });
      assert.equal(fn.mode, "exact");
      assert.equal(fn.hits[0]?.kind, "function");
      assert.equal(fn.hits[0]?.returnType, "TurnHost");

      // CSS: selector + custom property + keyframes land with kinds.
      const sel = searchCppSymbols(db, { query: ".toolbar" });
      assert.equal(sel.mode, "exact");
      assert.equal(sel.hits[0]?.kind, "type");
      assert.equal(sel.hits[0]?.path, normalizeSymbolPath(join(root, "src", "theme.css")));

      const cssVar = searchCppSymbols(db, { query: "--accent" });
      assert.equal(cssVar.mode, "exact");
      assert.equal(cssVar.hits[0]?.kind, "variable");

      const kf = searchCppSymbols(db, { query: "pulse" });
      assert.equal(kf.mode, "exact");
      assert.equal(kf.hits[0]?.name, "pulse");

      // C++ rows still answer the same query path.
      const cpp = searchCppSymbols(db, { query: "BeginPlay" });
      assert.equal(cpp.mode, "exact");
      assert.ok(cpp.hits.some((h) => h.container === "Demo"));
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchCppSymbols: prefix/substring modes, kind/path filters, limit", async () => {
  const root = await tempProject();
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "nodes.ts"),
      `class TurnHost {}
class TurnHostConfig {}
function turnHostReset() {}
`,
    );
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "other", "remote.ts"), `class TurnHostRemote {}
`);

    const db = openCppSymbolDatabase(cppSymbolDatabasePath(root));
    try {
      await scanCppSymbolDatabase({ db, root });

      // Exact name exists → mode "exact", exact row sorts first.
      const exact = searchCppSymbols(db, { query: "TurnHost" });
      assert.equal(exact.mode, "exact");
      assert.equal(exact.hits[0]?.name, "TurnHost");

      // No exact row, prefix matches → mode "prefix".
      const prefix = searchCppSymbols(db, { query: "turnh" });
      assert.equal(prefix.mode, "prefix");
      assert.ok(prefix.hits.length >= 4); // 4 symbols start with "turnh"

      // Prefix misses → substring sweep finds the embedded name.
      const substr = searchCppSymbols(db, { query: "runner" });
      assert.equal(substr.mode, "substring");

      // Kind filter narrows within the prefix sweep.
      const fns = searchCppSymbols(db, { query: "turnh", kind: "function" });
      assert.deepEqual(
        fns.hits.map((h) => h.name),
        ["turnHostReset"],
      );

      // Path prefix filter scopes rows to one directory.
      const remote = searchCppSymbols(db, {
        query: "turnh",
        pathPrefix: normalizeSymbolPath(join(root, "other")),
      });
      assert.deepEqual(
        remote.hits.map((h) => h.name),
        ["TurnHostRemote"],
      );

      // Limit truncation is reported.
      const capped = searchCppSymbols(db, { query: "turnh", limit: 2 });
      assert.equal(capped.hits.length, 2);
      assert.equal(capped.truncated, true);

      // Unknown query misses cleanly.
      const none = searchCppSymbols(db, { query: "zzz-nothing" });
      assert.deepEqual(none.hits, []);
      assert.equal(none.mode, "substring");
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
