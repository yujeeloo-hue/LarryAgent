/**
 * Workspace template registry — manifests + rendered file sets (pure).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTemplateFiles,
  getWorkspaceTemplateInfo,
  isWorkspaceTemplateId,
  listWorkspaceTemplateInfos,
  workspaceSlug,
} from "./templates.js";

describe("listWorkspaceTemplateInfos", () => {
  it("renders exactly the confirmed menu: 3 templates + blank", () => {
    const list = listWorkspaceTemplateInfos();
    assert.deepEqual(
      list.map((t) => t.id),
      ["web-node", "electron", "unreal", "blank"],
    );
    // Mac App / iOS App stay unregistered for now (user decision).
    assert.ok(!list.some((t) => /mac|ios/i.test(t.id)));
  });

  it("hasDeps only on non-Unreal templates", () => {
    for (const t of listWorkspaceTemplateInfos()) {
      assert.equal(t.hasDeps, t.id === "web-node" || t.id === "electron");
    }
  });
});

describe("buildTemplateFiles — web-node (ETHub-style)", () => {
  const files = buildTemplateFiles("web-node", "My Cool App");
  const paths = files.map((f) => f.path);

  it("writes the ETHub layout: server.js + public/, no build tooling", () => {
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.includes("server.js"));
    assert.ok(paths.includes("src/routes.js"));
    assert.ok(paths.includes("public/index.html"));
    assert.ok(paths.includes("public/app.js"));
    assert.ok(paths.includes("public/style.css"));
    assert.ok(!paths.some((p) => p.startsWith("vite")));
    assert.ok(!paths.includes("tsconfig.json"));
  });

  it("uses start/dev scripts the web debug auto-detect expects", () => {
    const pkg = JSON.parse(
      files.find((f) => f.path === "package.json")!.content,
    );
    assert.equal(pkg.name, "my-cool-app");
    assert.equal(pkg.scripts.start, "node server.js");
    assert.equal(pkg.scripts.dev, "node --watch server.js");
  });

  it("tasks.json carries run only (no build step)", () => {
    const tasks = JSON.parse(
      files.find((f) => f.path === ".larry/tasks.json")!.content,
    );
    assert.deepEqual(Object.keys(tasks.tasks), ["run"]);
    assert.equal(tasks.tasks.run.command, "node server.js");
  });

  it("renders the workspace name into server.js", () => {
    const server = files.find((f) => f.path === "server.js")!.content;
    assert.ok(server.includes("My Cool App"));
    assert.ok(!server.includes("{{"));
  });
});

describe("buildTemplateFiles — electron", () => {
  const files = buildTemplateFiles("electron", "Desk");

  it("scaffolds main/preload/renderer + electron-vite config", () => {
    const paths = files.map((f) => f.path);
    for (const expected of [
      "src/main/index.ts",
      "src/preload/index.ts",
      "src/renderer/index.html",
      "src/renderer/src/main.ts",
      "electron.vite.config.ts",
    ]) {
      assert.ok(paths.includes(expected), `missing ${expected}`);
    }
  });

  it("tasks.json has build + run", () => {
    const tasks = JSON.parse(
      files.find((f) => f.path === ".larry/tasks.json")!.content,
    );
    assert.deepEqual(Object.keys(tasks.tasks).sort(), ["build", "run"]);
  });
});

describe("buildTemplateFiles — unreal (docs + config only)", () => {
  const files = buildTemplateFiles("unreal", "MyGame");
  const paths = files.map((f) => f.path);

  it("never generates .uproject or Source files", () => {
    assert.ok(!paths.some((p) => p.endsWith(".uproject")));
    assert.ok(!paths.some((p) => p.startsWith("Source/")));
    assert.ok(!paths.includes("package.json"));
  });

  it("writes docs, gitignore and an empty tasks.json (UBT build auto-injects)", () => {
    for (const expected of [
      "PROJECT.md",
      "README.md",
      ".gitignore",
      ".larry/tasks.json",
      "docs/plans/README.md",
    ]) {
      assert.ok(paths.includes(expected), `missing ${expected}`);
    }
    const tasks = JSON.parse(
      files.find((f) => f.path === ".larry/tasks.json")!.content,
    );
    assert.deepEqual(tasks.tasks, {});
  });

  it("gitignore covers UE build artifacts", () => {
    const gi = files.find((f) => f.path === ".gitignore")!.content;
    for (const dir of ["Binaries/", "Intermediate/", "Saved/"]) {
      assert.ok(gi.includes(dir), `missing ${dir}`);
    }
  });
});

describe("buildTemplateFiles — common", () => {
  it("PROJECT.md uses the canonical five section headings", () => {
    for (const id of ["web-node", "electron", "unreal"] as const) {
      const body = buildTemplateFiles(id, "X").find(
        (f) => f.path === "PROJECT.md",
      )!.content;
      assert.ok(body.startsWith("# X\n"));
      for (const heading of [
        "## Basics",
        "## Structure",
        "## Conventions",
        "## Docs Guide",
        "## Recent",
      ]) {
        assert.ok(body.includes(heading), `${id}: missing ${heading}`);
      }
      for (const legacy of [
        "## Overview",
        "## Work log",
        "## Pitfalls\n",
        "## Handoff\n",
      ]) {
        assert.ok(!body.includes(legacy), `${id}: legacy ${legacy} leaked`);
      }
      // Recent mirrors the scaffolded worklog entry.
      assert.ok(body.includes("- Workspace initialized from the template."));
    }
  });

  it("writes the five docs memory files with canonical titles", () => {
    for (const id of ["web-node", "electron", "unreal"] as const) {
      const files = buildTemplateFiles(id, "X");
      const paths = files.map((f) => f.path);
      for (const doc of [
        "docs/WORKLOG.md",
        "docs/PITFALLS.md",
        "docs/HANDOFF.md",
        "docs/STYLE.md",
        "docs/DEPLOY.md",
      ]) {
        assert.ok(paths.includes(doc), `${id}: missing ${doc}`);
      }
      const worklog = files.find((f) => f.path === "docs/WORKLOG.md")!.content;
      assert.ok(worklog.startsWith("# WORKLOG — Work Log"));
      assert.ok(worklog.includes("- Workspace initialized from the"));
      const deploy = files.find((f) => f.path === "docs/DEPLOY.md")!.content;
      assert.ok(deploy.startsWith("# DEPLOY — Deployment & Release"));
    }
  });

  it("keeps the docs memory files trackable in every template gitignore", () => {
    for (const id of ["web-node", "electron", "unreal"] as const) {
      const gi = buildTemplateFiles(id, "X").find(
        (f) => f.path === ".gitignore",
      )!.content;
      assert.ok(gi.includes("PROJECT.md"), `${id}: PROJECT.md still ignored`);
      assert.ok(gi.includes("docs/demo/"), `${id}: docs/demo/ still ignored`);
      for (const entry of [
        "docs/WORKLOG.md",
        "docs/PITFALLS.md",
        "docs/HANDOFF.md",
        "docs/STYLE.md",
        "docs/DEPLOY.md",
      ]) {
        assert.ok(!gi.includes(entry), `${id}: ${entry} must be trackable`);
      }
    }
  });

  it("blank writes nothing", () => {
    assert.deepEqual(buildTemplateFiles("blank", "X"), []);
  });

  it("leaves no unrendered placeholders", () => {
    for (const id of ["web-node", "electron", "unreal"] as const) {
      for (const f of buildTemplateFiles(id, "X")) {
        assert.ok(!f.content.includes("{{"), `${id}/${f.path} has {{`);
      }
    }
  });
});

describe("helpers", () => {
  it("workspaceSlug normalizes display names", () => {
    assert.equal(workspaceSlug("My Cool App"), "my-cool-app");
    assert.equal(workspaceSlug("  JB--Bot! "), "jb-bot");
    assert.equal(workspaceSlug("---"), "my-app");
  });

  it("isWorkspaceTemplateId guards IPC input", () => {
    assert.ok(isWorkspaceTemplateId("unreal"));
    assert.ok(!isWorkspaceTemplateId("mac-app"));
    assert.ok(!isWorkspaceTemplateId(null));
  });

  it("getWorkspaceTemplateInfo covers every id", () => {
    assert.equal(getWorkspaceTemplateInfo("blank").name, "Blank Project");
    assert.equal(getWorkspaceTemplateInfo("web-node").iconId, "globe");
    assert.equal(getWorkspaceTemplateInfo("unreal").iconId, "unreal");
  });
});
