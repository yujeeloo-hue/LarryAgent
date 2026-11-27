import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildKnowledgeCatalogNote, KNOWLEDGE_CATALOG_HEADER } from "./catalogNote.js";
import { findSection, parseFrontmatter, splitSections } from "./parseDoc.js";
import { tokenizeKnowledgeText } from "./searchIndex.js";
import { KnowledgeStore } from "./store.js";

function doc(input: {
  title: string;
  summary: string;
  keywords: string[];
  body: string;
  version?: number;
  guideFor?: string[];
  baseVersion?: number;
}): string {
  const lines = [
    "---",
    `title: ${input.title}`,
    `summary: "${input.summary}"`,
    `keywords: [${input.keywords.join(", ")}]`,
  ];
  if (input.guideFor) lines.push(`guide_for: [${input.guideFor.join(", ")}]`);
  if (input.version !== undefined) lines.push(`version: ${input.version}`);
  if (input.baseVersion !== undefined) lines.push(`base_version: ${input.baseVersion}`);
  lines.push("---", "", input.body, "");
  return lines.join("\n");
}

function put(root: string, id: string, content: string): void {
  const [category, slug] = id.split("/") as [string, string];
  mkdirSync(join(root, category), { recursive: true });
  writeFileSync(join(root, category, `${slug}.md`), content, "utf8");
}

function putCategory(root: string, id: string, description: string): void {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "_category.md"), `---\ntitle: ${id}\ndescription: "${description}"\n---\n`, "utf8");
}

describe("knowledge parseDoc", () => {
  it("parses inline and block lists and quoted scalars", () => {
    const parsed = parseFrontmatter(
      "---\ntitle: \"A: b\"\nkeywords:\n  - one\n  - two\nrelated_tools: [x_tool, 'y_tool']\n---\n\nBody\n",
    );
    assert.equal(parsed.fields.title, "A: b");
    assert.deepEqual(parsed.fields.keywords, ["one", "two"]);
    assert.deepEqual(parsed.fields.related_tools, ["x_tool", "y_tool"]);
    assert.equal(parsed.body, "Body");
  });

  it("splits ## sections and ignores headings inside code fences", () => {
    const body = "Intro\n\n## First\nA\n```\n## not a heading\n```\n## Second step\nB";
    assert.deepEqual(splitSections(body).map((s) => s.heading), ["", "First", "Second step"]);
    assert.match(findSection(body, "second")!.text, /^## Second step\nB$/);
    assert.equal(findSection(body, "missing"), null);
  });
});

describe("knowledge tokenizer", () => {
  it("emits words, snake_case parts and CJK bigrams", () => {
    const tokens = tokenizeKnowledgeText("Use computer_batch to 截图点击");
    assert.ok(tokens.includes("computer_batch"));
    assert.ok(tokens.includes("computer"));
    assert.ok(tokens.includes("batch"));
    assert.ok(tokens.includes("截图"));
    assert.ok(tokens.includes("图点"));
    assert.ok(!tokens.includes("to"));
  });
});

describe("KnowledgeStore", () => {
  let root: string;
  let builtinDir: string;
  let userDir: string;
  let store: KnowledgeStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-"));
    builtinDir = join(root, "builtin");
    userDir = join(root, "user");
    putCategory(builtinDir, "computer-use", "Desktop control.");
    putCategory(builtinDir, "fsm-graph", "Graphs.");
    put(
      builtinDir,
      "computer-use/basics",
      doc({
        title: "Computer Use basics",
        summary: "Screenshot then click.",
        keywords: ["screenshot", "click", "截图"],
        body: "## Locating\nTake a screenshot first.\n\n## Clicking\nClick the center.",
        version: 2,
        guideFor: ["computer_mouse"],
      }),
    );
    put(
      builtinDir,
      "fsm-graph/routing",
      doc({
        title: "Routing and edges",
        summary: "Pins and EdgeWhen.",
        keywords: ["pin", "edge", "route"],
        body: "## Pins\nRouteTo selects a local pin.",
        version: 1,
        guideFor: ["fsm_graph_connection"],
      }),
    );
    store = new KnowledgeStore();
    store.configure({ builtinDir, userDir });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads built-in docs, categories and guides", () => {
    assert.deepEqual(store.listDocs().map((d) => d.id), ["computer-use/basics", "fsm-graph/routing"]);
    assert.equal(store.getDoc("computer-use/basics")?.source, "builtin");
    assert.equal(store.guideFor("computer_mouse")?.id, "computer-use/basics");
    assert.equal(store.listCategories().find((c) => c.id === "computer-use")?.description, "Desktop control.");
  });

  it("skips docs without the required frontmatter", () => {
    put(builtinDir, "fsm-graph/broken", "---\ntitle: Missing summary\n---\nBody");
    store.invalidate();
    assert.equal(store.getDoc("fsm-graph/broken"), null);
  });

  it("ranks by BM25 with AND matching, CJK queries and OR fallback", () => {
    const and = store.search({ query: "click screenshot", limit: 5 });
    assert.equal(and.mode, "and");
    assert.equal(and.hits[0]?.doc.id, "computer-use/basics");
    assert.equal(store.search({ query: "截图", limit: 5 }).hits[0]?.doc.id, "computer-use/basics");
    const or = store.search({ query: "pin nonexistentword", limit: 5 });
    assert.equal(or.mode, "or");
    assert.equal(or.hits[0]?.doc.id, "fsm-graph/routing");
    assert.equal(store.search({ query: "fsm_graph_connection", limit: 5 }).hits[0]?.doc.id, "fsm-graph/routing");
  });

  it("patching a built-in doc creates an override and leaves the built-in file alone", () => {
    const original = readFileSync(join(builtinDir, "computer-use", "basics.md"), "utf8");
    const result = store.patch({
      id: "computer-use/basics",
      edits: [{ oldString: "Click the center.", newString: "Click the center of the target." }],
    });
    assert.ok(result.ok);
    const override = store.getDoc("computer-use/basics")!;
    assert.equal(override.source, "override");
    assert.equal(override.baseVersion, 2);
    assert.equal(override.stale, false);
    assert.match(override.body, /center of the target/);
    assert.equal(readFileSync(join(builtinDir, "computer-use", "basics.md"), "utf8"), original);
  });

  it("marks an override stale when the built-in version moves ahead", () => {
    put(
      userDir,
      "computer-use/basics",
      doc({ title: "Edited", summary: "Old.", keywords: ["a", "b", "c"], body: "## Old\nx", version: 3, baseVersion: 1 }),
    );
    store.invalidate();
    const override = store.getDoc("computer-use/basics")!;
    assert.equal(override.source, "override");
    assert.equal(override.stale, true);
    assert.equal(override.builtinVersion, 2);
    assert.match(buildKnowledgeCatalogNote(store.listCategories(), store.listDocs())!, /computer-use\/basics: Edited \[stale\]/);
  });

  it("deleting an override reverts to built-in; built-in docs cannot be deleted", () => {
    assert.ok(store.patch({ id: "computer-use/basics", edits: [{ oldString: "first", newString: "FIRST" }] }).ok);
    const reverted = store.delete("computer-use/basics");
    assert.deepEqual(reverted, { ok: true, id: "computer-use/basics", reverted: true });
    assert.equal(store.getDoc("computer-use/basics")?.source, "builtin");
    const denied = store.delete("computer-use/basics");
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.code, "denied");
  });

  it("writes user docs, bumps versions and requires a description for new categories", () => {
    const base = {
      title: "Release checklist",
      summary: "Steps before shipping.",
      keywords: ["release", "ship", "checklist"],
      content: "## Steps\n1. Build",
    };
    const missing = store.write({ ...base, category: "release" });
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.message : "", /category_description/);

    const created = store.write({ ...base, category: "release", categoryDescription: "Shipping." });
    assert.ok(created.ok && created.created);
    assert.equal(created.ok && created.doc.id, "release/release-checklist");
    assert.equal(store.listCategories().find((c) => c.id === "release")?.description, "Shipping.");

    const updated = store.write({ ...base, id: "release/release-checklist", category: "release", content: "## Steps\n1. Test" });
    assert.ok(updated.ok && !updated.created);
    assert.equal(updated.ok && updated.doc.version, 2);
    assert.equal(store.getDoc("release/release-checklist")?.source, "user");
  });

  it("validates keywords, summary length, body size and guide targets", () => {
    const base = { category: "fsm-graph", title: "T", summary: "S", keywords: ["a", "b", "c"], content: "body" };
    assert.equal(store.write({ ...base, keywords: ["a"] }).ok, false);
    assert.equal(store.write({ ...base, summary: "x".repeat(201) }).ok, false);
    assert.equal(store.write({ ...base, content: "x".repeat(32_001) }).ok, false);
    assert.equal(store.write({ ...base, guideFor: ["mcp__srv__tool"] }).ok, false);
  });

  it("patch requires a unique old_string", () => {
    const result = store.patch({ id: "computer-use/basics", edits: [{ oldString: "Click", newString: "Tap" }] });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : "", /matches 2 places/);
  });

  it("user-layer guides win over built-in guides for the same tool", () => {
    const result = store.write({
      category: "fsm-graph",
      slug: "my-routing",
      title: "My routing notes",
      summary: "Better notes.",
      keywords: ["pin", "edge", "route"],
      content: "## Notes\nx",
      guideFor: ["fsm_graph_connection"],
    });
    assert.ok(result.ok);
    assert.equal(store.guideFor("fsm_graph_connection")?.id, "fsm-graph/my-routing");
  });

  it("picks up changes written by another process", () => {
    const path = join(builtinDir, "fsm-graph", "routing.md");
    writeFileSync(
      path,
      doc({ title: "Routing v2", summary: "New.", keywords: ["pin", "edge", "route"], body: "## Pins\ny", version: 2 }),
    );
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    store.invalidate();
    assert.equal(store.getDoc("fsm-graph/routing")?.title, "Routing v2");
  });

  it("builds a bounded catalog note", () => {
    const text = buildKnowledgeCatalogNote(store.listCategories(), store.listDocs())!;
    assert.ok(text.startsWith(KNOWLEDGE_CATALOG_HEADER));
    assert.match(text, /^computer-use:$/m);
    assert.match(text, /^- fsm-graph\/routing: Routing and edges$/m);
    assert.equal(buildKnowledgeCatalogNote([], []), null);
  });
});
