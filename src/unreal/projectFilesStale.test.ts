import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkUnrealProjectFilesStale } from "./projectFilesStale.js";

async function fixture(generatedAt: Date): Promise<{
  parent: string;
  project: string;
  vcxproj: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "jb-ue-stale-"));
  const project = join(parent, "Game");
  const projectFiles = join(project, "Intermediate", "ProjectFiles");
  await mkdir(join(project, "Source", "Game"), { recursive: true });
  await mkdir(projectFiles, { recursive: true });
  await writeFile(join(project, "Game.uproject"), "{}");
  const sln = join(project, "Game.sln");
  await writeFile(sln, "Microsoft Visual Studio Solution File, Format Version 12.00\n");
  const vcxproj = join(projectFiles, "Game.vcxproj");
  await writeFile(
    vcxproj,
    '<Project><ItemGroup><ClCompile Include="..\\..\\Source\\Game\\Game.cpp" /></ItemGroup></Project>',
  );
  await writeFile(join(project, "Source", "Game", "Game.cpp"), "");
  await Promise.all([utimes(sln, generatedAt, generatedAt), utimes(vcxproj, generatedAt, generatedAt)]);
  return { parent, project, vcxproj };
}

test("Unreal project files are current when no source file was created later", async () => {
  const { parent, project } = await fixture(new Date(Date.now() + 60_000));
  try {
    assert.deepEqual(await checkUnrealProjectFilesStale(project), {
      ok: true,
      stale: false,
      reason: "up-to-date",
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a source file created after generation marks Unreal project files stale", async () => {
  const { parent, project } = await fixture(new Date(Date.now() - 500));
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await writeFile(join(project, "Source", "Game", "NewActor.cpp"), "");
    const result = await checkUnrealProjectFilesStale(project);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.stale, true);
    assert.equal(result.reason, "newer-files");
    assert.equal(result.count, 1);
    assert.deepEqual(result.newer, ["source/game/newactor.cpp"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("missing solution or project files mark the workspace stale", async () => {
  const { parent, project, vcxproj } = await fixture(new Date());
  try {
    await rm(vcxproj);
    assert.deepEqual(await checkUnrealProjectFilesStale(project), {
      ok: true,
      stale: true,
      reason: "missing",
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
