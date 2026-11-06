import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolReturnCode } from "./returnCodes.js";
import {
  buildPlanDocAbsolutePath,
  hasPlanDoc,
  isUnderPlanDocDir,
  parseSessionPlanDocJson,
  planDocRelativeDir,
  slugifyPlanDocTitle,
} from "./planDoc.js";
import {
  parseSessionPlanJson,
  refreshPlanDocRef,
  withPlanDocRef,
} from "./plan.js";
import type { SessionPlan, SessionPlanDoc } from "./types.js";

describe("planDoc helpers", () => {
  it("uses docs/plans relative dir", () => {
    assert.equal(planDocRelativeDir(), "docs/plans");
  });

  it("slugifies titles safely", () => {
    assert.equal(slugifyPlanDocTitle("Hello World!"), "hello-world");
    assert.equal(slugifyPlanDocTitle("   "), "plan");
  });

  it("builds paths under docs/plans", () => {
    const abs = buildPlanDocAbsolutePath("/tmp/ws", "Add Auth", new Date("2026-08-07T12:00:00Z"));
    assert.ok(abs.includes(`${join("docs", "plans")}`));
    assert.ok(abs.endsWith("20260807-add-auth.md") || abs.endsWith("20260807-add-auth.md".replace(/\//g, "\\")));
    assert.equal(isUnderPlanDocDir("/tmp/ws", abs), true);
    assert.equal(isUnderPlanDocDir("/tmp/ws", "/tmp/ws/README.md"), false);
  });

  it("parses and validates planDoc JSON", () => {
    assert.equal(parseSessionPlanDocJson(null), null);
    assert.equal(parseSessionPlanDocJson("{}"), null);
    const doc = parseSessionPlanDocJson(
      JSON.stringify({
        path: "/tmp/ws/docs/plans/a.md",
        summary: "Ship auth",
        updatedAt: 1,
      }),
    );
    assert.ok(doc);
    assert.equal(hasPlanDoc(doc), true);
    assert.equal(doc!.summary, "Ship auth");
  });
});

describe("write_plan_doc tool", () => {
  it("writes under docs/plans and updates planDoc", async () => {
    const { writePlanDocHandler } = await import(
      "../tools/builtin/writePlanDoc.js"
    );
    const root = await mkdtemp(join(tmpdir(), "plan-doc-"));
    try {
      const result = await writePlanDocHandler(
        {
          title: "Feature X",
          content:
            "# Goal\nShip X\n\n# Non-goals\nY\n\n# Approach\nZ\n\n# Acceptance\nDone\n\n# Risks\nNone",
          summary: "Ship feature X safely",
        },
        {
          workspacePath: root,
          fullPermissionsEnabled: false,
        },
      );
      assert.equal(result.returnCode, 0);
      const doc = result.sessionPatch?.planDoc;
      assert.ok(doc);
      assert.ok(doc.path.includes(join("docs", "plans")));
      assert.equal(doc.summary, "Ship feature X safely");
      assert.ok(
        result.content.some(
          (p) => p.type === "text" && p.text.startsWith("Wrote "),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts content past the recommended length with an advisory note", async () => {
    const { writePlanDocHandler } = await import(
      "../tools/builtin/writePlanDoc.js"
    );
    const root = await mkdtemp(join(tmpdir(), "plan-doc-long-"));
    try {
      const longBody = `# Goal\n${"detail ".repeat(2_000)}`;
      const result = await writePlanDocHandler(
        {
          title: "Long Doc",
          content: longBody,
          summary: "Long but accepted",
        },
        { workspacePath: root, fullPermissionsEnabled: false },
      );
      assert.equal(result.returnCode, 0);
      assert.ok(
        result.content.some(
          (p) =>
            p.type === "text" &&
            p.text.includes("recommended") &&
            p.text.includes(`${longBody.length} characters`),
        ),
        "expected advisory length note",
      );
      const doc = result.sessionPatch?.planDoc;
      assert.ok(doc);
      const onDisk = await readFile(doc.path, "utf8");
      assert.equal(onDisk.length, longBody.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("write_plan_doc is write-only (edit mode removed)", () => {
  it("schema declares only title/content/summary and rejects edits/path", async () => {
    const { writePlanDocDefinition } = await import(
      "../tools/builtin/writePlanDoc.js"
    );
    const { validateToolArguments } = await import(
      "../tools/validateToolArguments.js"
    );
    const properties = (writePlanDocDefinition.parameters.properties ??
      {}) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(properties).sort(),
      ["content", "summary", "title"],
    );

    // The handler ignores unknown keys; rejection happens one layer up:
    // runTools validates every call with validateToolArguments and maps any
    // failure to ToolReturnCode.InvalidArguments, so stale edits/path calls
    // fail with "unexpected property" before reaching the handler.
    const withEdits = validateToolArguments(
      {
        title: "T",
        content: "# T",
        summary: "s",
        edits: [{ old_text: "a", new_text: "b" }],
      },
      writePlanDocDefinition.parameters,
    );
    assert.ok(!withEdits.ok);
    assert.match(withEdits.error, /unexpected property "edits"/);

    const withPath = validateToolArguments(
      { title: "T", content: "# T", summary: "s", path: "/tmp/x.md" },
      writePlanDocDefinition.parameters,
    );
    assert.ok(!withPath.ok);
    assert.match(withPath.error, /unexpected property "path"/);
  });

  it("treats an edits-only call as a missing-args failure, writing nothing", async () => {
    const { writePlanDocHandler } = await import(
      "../tools/builtin/writePlanDoc.js"
    );
    const root = await mkdtemp(join(tmpdir(), "plan-doc-wo-"));
    try {
      const result = await writePlanDocHandler(
        { edits: [{ old_text: "a", new_text: "b" }] },
        { workspacePath: root, fullPermissionsEnabled: false },
      );
      assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
      const text = result.content.find((p) => p.type === "text");
      assert.ok(text && "text" in text);
      assert.match(text.text, /"title", "content", and "summary"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-writes wholesale: same title replaces the doc even with a planDocSnapshot", async () => {
    const { writePlanDocHandler } = await import(
      "../tools/builtin/writePlanDoc.js"
    );
    const root = await mkdtemp(join(tmpdir(), "plan-doc-rewrite-"));
    try {
      const first = await writePlanDocHandler(
        {
          title: "Feature X",
          content: "# Goal\nOld approach",
          summary: "v1",
        },
        { workspacePath: root, fullPermissionsEnabled: false },
      );
      assert.equal(first.returnCode, ToolReturnCode.Success);
      const firstDoc = first.sessionPatch?.planDoc;
      assert.ok(firstDoc);

      // Same title → same docs/plans path; content is replaced wholesale
      // (no merge with the snapshot or the previous on-disk version).
      const second = await writePlanDocHandler(
        {
          title: "Feature X",
          content: "# Goal\nNew approach wholesale",
          summary: "v2",
        },
        {
          workspacePath: root,
          fullPermissionsEnabled: false,
          planDocSnapshot: firstDoc,
        },
      );
      assert.equal(second.returnCode, ToolReturnCode.Success);
      const secondDoc = second.sessionPatch?.planDoc;
      assert.ok(secondDoc);
      assert.equal(secondDoc.path, firstDoc.path);
      assert.equal(secondDoc.summary, "v2");

      const onDisk = await readFile(firstDoc.path, "utf8");
      assert.equal(onDisk, "# Goal\nNew approach wholesale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("plan → planDoc ref", () => {
  const DOC: SessionPlanDoc = {
    path: "/tmp/ws/docs/plans/ref.md",
    summary: "Ref me",
    updatedAt: 1,
  };

  function makePlan(): SessionPlan {
    const now = 1;
    return {
      id: "p1",
      title: "T",
      status: "active",
      steps: [
        { id: "s1", title: "A", status: "pending" },
        { id: "s2", title: "B", status: "pending" },
      ],
      createdAt: now,
      updatedAt: now,
      createToolCallId: "tc0",
    };
  }

  it("withPlanDocRef fills only when missing; keeps existing ref", () => {
    const filled = withPlanDocRef(makePlan(), DOC);
    assert.deepEqual(filled.planDoc, { path: DOC.path, summary: DOC.summary });

    const linked = withPlanDocRef(
      { ...makePlan(), planDoc: { path: "/other.md", summary: "orig" } },
      DOC,
    );
    assert.deepEqual(linked.planDoc, { path: "/other.md", summary: "orig" });

    assert.equal(withPlanDocRef(makePlan(), null).planDoc, undefined);
    assert.equal(
      withPlanDocRef(makePlan(), { ...DOC, path: "  " }).planDoc,
      undefined,
    );
  });

  it("refreshPlanDocRef re-points at the fresh doc; no-op when identical/absent", () => {
    const refreshed = refreshPlanDocRef(
      { ...makePlan(), planDoc: { path: "/old.md", summary: "old" } },
      DOC,
    );
    assert.deepEqual(refreshed.planDoc, {
      path: DOC.path,
      summary: DOC.summary,
    });

    const linked = withPlanDocRef(makePlan(), DOC);
    assert.equal(refreshPlanDocRef(linked, DOC), linked);
    assert.equal(refreshPlanDocRef(makePlan(), null).planDoc, undefined);
  });

  it("clips ref summaries to PLAN_DOC_SUMMARY_MAX", () => {
    const long = withPlanDocRef(
      makePlan(),
      { ...DOC, summary: "x".repeat(500) },
    );
    assert.equal(long.planDoc?.summary.length, 400);
  });

  it("parseSessionPlanJson round-trips the ref and drops malformed ones", () => {
    const base = makePlan();
    const roundTripped = parseSessionPlanJson(
      JSON.stringify({
        ...base,
        planDoc: { path: "/tmp/ws/docs/plans/a.md", summary: "  ok  " },
      }),
    );
    assert.ok(roundTripped);
    assert.deepEqual(roundTripped.planDoc, {
      path: "/tmp/ws/docs/plans/a.md",
      summary: "ok",
    });

    assert.equal(parseSessionPlanJson(JSON.stringify(base))?.planDoc, undefined);
    for (const badRef of [
      { path: "", summary: "s" },
      { path: "/a.md", summary: 5 },
      { summary: "s" },
      "nope",
    ]) {
      const parsed = parseSessionPlanJson(
        JSON.stringify({ ...base, planDoc: badRef }),
      );
      assert.ok(parsed);
      assert.equal(parsed.planDoc, undefined);
    }
  });
});
