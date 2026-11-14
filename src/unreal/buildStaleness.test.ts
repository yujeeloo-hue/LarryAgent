import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  findSourceNewerThan,
  STALENESS_TOLERANCE_MS,
} from "./buildStaleness.js";

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Stamp a file's mtime (seconds-resolution utimes takes a Date). */
async function at(path: string, offsetMs: number): Promise<void> {
  await utimes(path, new Date(T0 + offsetMs), new Date(T0 + offsetMs));
}

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jb-ue-stale-"));
  const dirs = [
    "Source/NF",
    "Plugins/MyPlug/Source/Third",
    "Plugins/MyPlug/Content",
    "Plugins/MyPlug/Intermediate",
    "Build/BatchFiles",
    "Config",
    "Intermediate",
  ];
  for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
  const files = [
    "NF.uproject",
    "NFEditor.Target.cs",
    "notes.txt",
    "Source/NF/NF.Build.cs",
    "Source/NF/NFGameMode.cpp",
    "Source/NF/NFGameMode.h",
    "Plugins/MyPlug/Source/Third/ThirdModule.cpp",
    "Plugins/MyPlug/Content/Asset.uasset",
    "Plugins/MyPlug/Intermediate/gen.cpp",
    "Build/BatchFiles/Hello.bat",
    "Config/DefaultEngine.ini",
    "Intermediate/whatever.cpp",
  ];
  for (const file of files) await writeFile(join(root, file), "x");
  return root;
}

function withProject(
  fn: (root: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const root = await makeProject();
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}

/** Everything older than the build start → expect fresh. */
async function ageAll(root: string, offsetMs = -60_000): Promise<void> {
  const entries = [
    "NF.uproject",
    "NFEditor.Target.cs",
    "Source/NF/NF.Build.cs",
    "Source/NF/NFGameMode.cpp",
    "Source/NF/NFGameMode.h",
    "Plugins/MyPlug/Source/Third/ThirdModule.cpp",
    "Build/BatchFiles/Hello.bat",
  ];
  for (const entry of entries) await at(join(root, entry), offsetMs);
}

describe("findSourceNewerThan", () => {
  it(
    "fresh when every source predates the build",
    withProject(async (root) => {
      await ageAll(root);
      const result = await findSourceNewerThan(root, T0);
      assert.equal(result.stale, false);
      assert.equal(result.newestPath, null);
      assert.equal(result.newestMtime, 0);
      // All in-scope files were inspected (7 sources, not the 12 written).
      assert.equal(result.scannedFiles, 7);
    }),
  );

  it(
    "flags a Source/ cpp edited after the build",
    withProject(async (root) => {
      await ageAll(root);
      const edited = join(root, "Source/NF/NFGameMode.cpp");
      await at(edited, 5_000);
      const result = await findSourceNewerThan(root, T0);
      assert.equal(result.stale, true);
      assert.equal(result.newestPath, edited);
      assert.equal(result.newestMtime, T0 + 5_000);
    }),
  );

  it(
    "flags a plugin Source/ file but not plugin Content or Intermediate",
    withProject(async (root) => {
      await ageAll(root);
      await at(join(root, "Plugins/MyPlug/Content/Asset.uasset"), 90_000);
      await at(join(root, "Plugins/MyPlug/Intermediate/gen.cpp"), 90_000);
      assert.equal((await findSourceNewerThan(root, T0)).stale, false);

      await at(join(root, "Plugins/MyPlug/Source/Third/ThirdModule.cpp"), 1_000);
      assert.equal((await findSourceNewerThan(root, T0)).stale, true);
    }),
  );

  it(
    "flags root uproject / Target.cs / Build scripts, ignores Config and stray root files",
    withProject(async (root) => {
      await ageAll(root);
      await at(join(root, "Config/DefaultEngine.ini"), 90_000);
      await at(join(root, "notes.txt"), 90_000);
      await at(join(root, "Intermediate/whatever.cpp"), 90_000);
      assert.equal((await findSourceNewerThan(root, T0)).stale, false);

      await at(join(root, "NF.uproject"), 2_000);
      assert.equal((await findSourceNewerThan(root, T0)).stale, true);
      await at(join(root, "NF.uproject"), -60_000);

      await at(join(root, "NFEditor.Target.cs"), 2_000);
      assert.equal((await findSourceNewerThan(root, T0)).stale, true);
      await at(join(root, "NFEditor.Target.cs"), -60_000);

      await at(join(root, "Build/BatchFiles/Hello.bat"), 2_000);
      assert.equal((await findSourceNewerThan(root, T0)).stale, true);
    }),
  );

  it(
    "tolerance window: within STALENESS_TOLERANCE_MS above the threshold stays fresh below it",
    withProject(async (root) => {
      await ageAll(root);
      const edited = join(root, "Source/NF/NFGameMode.h");
      // Stale iff mtime >= startedAt - tolerance. Just outside the window
      // is fresh; just inside is stale.
      await at(edited, -STALENESS_TOLERANCE_MS - 500);
      assert.equal((await findSourceNewerThan(root, T0)).stale, false);
      await at(edited, -STALENESS_TOLERANCE_MS + 500);
      assert.equal((await findSourceNewerThan(root, T0)).stale, true);
    }),
  );

  it(
    "missing workspace reports fresh with nothing scanned",
    async () => {
      const result = await findSourceNewerThan(
        join(tmpdir(), "jb-ue-stale-nonexistent"),
        T0,
      );
      assert.equal(result.stale, false);
      assert.equal(result.scannedFiles, 0);
    },
  );
});
