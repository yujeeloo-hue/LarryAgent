import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { adoptPlanDocDefinition, adoptPlanDocHandler } from "./adoptPlanDoc.js";
import { writePlanDocHandler } from "./writePlanDoc.js";
import { createPlanHandler } from "./createPlan.js";
import { fsmRouteHandler } from "./fsmRoute.js";
import { validateToolArguments } from "../validateToolArguments.js";
import { isPlanExecutionRequest, parseSessionPlanDocJson, planDocRevision } from "../../session/planDoc.js";

describe("existing plan document adoption and revision gates", () => {
  it("adopts a file without changing it, granting approval, or creating a duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "adopt-plan-"));
    try {
      await mkdir(join(root, "docs/plans"), { recursive: true });
      const path = join(root, "docs/plans/existing.md");
      const content = "# Existing design\nImplement X";
      await writeFile(path, content);
      const result = await adoptPlanDocHandler({ path }, { workspacePath: root, fullPermissionsEnabled: false });
      assert.equal(result.returnCode, 0);
      const doc = result.sessionPatch?.planDoc;
      assert.equal(doc?.path, path);
      assert.equal(doc?.revision, planDocRevision(content));
      assert.equal(doc?.approvedRevision, undefined);
      assert.equal(doc?.executionRequestedRevision, undefined);
      assert.deepEqual(result.routeEvent, { event: "doc_adopted", source: "tool" });
      assert.equal(await readFile(path, "utf8"), content);
      assert.deepEqual(await readdir(join(root, "docs/plans")), ["existing.md"]);
      assert.equal(validateToolArguments({ path, approved: true }, adoptPlanDocDefinition.parameters).ok, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects files outside docs/plans, missing/empty files, and escaping symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "adopt-plan-invalid-"));
    const outside = await mkdtemp(join(tmpdir(), "adopt-plan-outside-"));
    try {
      await mkdir(join(root, "docs/plans"), { recursive: true });
      await writeFile(join(root, "README.md"), "# Wrong");
      await writeFile(join(root, "docs/plans/empty.md"), " ");
      await writeFile(join(outside, "external.md"), "# Outside");
      await symlink(join(outside, "external.md"), join(root, "docs/plans/link.md"));
      for (const path of [join(root, "README.md"), join(root, "docs/plans/missing.md"), join(root, "docs/plans/empty.md"), join(root, "docs/plans/link.md")]) {
        const result = await adoptPlanDocHandler({ path }, { workspacePath: root, fullPermissionsEnabled: true });
        assert.notEqual(result.returnCode, 0, path);
        assert.equal(result.sessionPatch, undefined);
      }
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it("persists approval/request revisions and invalidates them on a changed write", async () => {
    const root = await mkdtemp(join(tmpdir(), "plan-revisions-"));
    try {
      const first = await writePlanDocHandler({ title: "Feature", content: "# Feature\nOld", summary: "Feature" }, { workspacePath: root, fullPermissionsEnabled: false });
      const doc = first.sessionPatch!.planDoc!;
      const approved = { ...doc, reviewedRevision: doc.revision!, approvedRevision: doc.revision!, approvedAt: 1, executionRequestedRevision: doc.revision! };
      assert.deepEqual(parseSessionPlanDocJson(JSON.stringify(approved)), approved);
      const same = await writePlanDocHandler({ title: "Feature", content: "# Feature\nOld", summary: "Feature" }, { workspacePath: root, fullPermissionsEnabled: false, planDocSnapshot: approved });
      assert.equal(same.sessionPatch?.planDoc?.approvedRevision, doc.revision);
      assert.equal(same.sessionPatch?.planDoc?.executionRequestedRevision, doc.revision);
      const changed = await writePlanDocHandler({ title: "Feature", content: "# Feature\nNew", summary: "Feature" }, { workspacePath: root, fullPermissionsEnabled: false, planDocSnapshot: approved });
      assert.equal(changed.sessionPatch?.planDoc?.approvedRevision, undefined);
      assert.equal(changed.sessionPatch?.planDoc?.reviewedRevision, undefined);
      assert.equal(changed.sessionPatch?.planDoc?.executionRequestedRevision, undefined);
      assert.notEqual(changed.sessionPatch?.planDoc?.revision, doc.revision);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("ready honors a trusted go-ahead only after review of the same on-disk version", async () => {
    const root = await mkdtemp(join(tmpdir(), "plan-ready-"));
    try {
      await mkdir(join(root, "docs/plans"), { recursive: true });
      const path = join(root, "docs/plans/current.md");
      await writeFile(path, "# Current");
      const adopted = await adoptPlanDocHandler({ path }, { workspacePath: root, fullPermissionsEnabled: false, planExecutionRequested: true });
      const doc = adopted.sessionPatch!.planDoc!;
      const context = { workspacePath: root, fullPermissionsEnabled: false, planDocSnapshot: doc, boundRouteEvents: ["ready", "rewrite", "plan_approved"] };
      const manual = await fsmRouteHandler({ route: "plan_approved" }, context);
      assert.notEqual(manual.returnCode, 0);
      const approved = await fsmRouteHandler({ route: "ready" }, context);
      assert.equal(approved.routeEvent?.event, "plan_approved");
      assert.equal(approved.sessionPatch?.planDoc?.approvedRevision, doc.revision);
      assert.equal(approved.sessionPatch?.planDoc?.reviewedRevision, doc.revision);
      await writeFile(path, "# Changed");
      const changed = await fsmRouteHandler({ route: "ready" }, context);
      assert.equal(changed.routeEvent?.event, "stay");
      assert.equal(changed.sessionPatch?.planDoc?.approvedRevision, undefined);
      assert.equal(changed.sessionPatch?.planDoc?.executionRequestedRevision, undefined);
      assert.equal(changed.sessionPatch?.planDoc?.approvalPending, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("create_plan rejects unapproved or changed versions when the graph requires approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "plan-checklist-gate-"));
    try {
      const result = await writePlanDocHandler({ title: "Feature", content: "# Feature", summary: "Feature" }, { workspacePath: root, fullPermissionsEnabled: false });
      const doc = result.sessionPatch!.planDoc!;
      const context = { workspacePath: root, fullPermissionsEnabled: true, toolCallId: "test", requirePlanDocApprovalForCreatePlan: true };
      const args = { title: "Feature", steps: ["Implement", "Verify"] };
      assert.notEqual((await createPlanHandler(args, { ...context, planDocSnapshot: doc })).returnCode, 0);
      const approved = { ...doc, approvedRevision: doc.revision! };
      assert.equal((await createPlanHandler(args, { ...context, planDocSnapshot: approved })).returnCode, 0);
      await writeFile(doc.path, "# Changed");
      assert.notEqual((await createPlanHandler(args, { ...context, planDocSnapshot: approved })).returnCode, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("captures explicit execution requests and ignores questions, negations and quoted text", () => {
    for (const text of ["开工", "开工吧", "OK，开始落地修改吧", "按方案实现吧", "开始开发", "Go ahead."]) assert.equal(isPlanExecutionRequest(text), true, text);
    for (const text of ["可以开始开发吗？", "先不要开工", "用户说开工", "解释一下开工是什么意思", "开始吧", "看看方案", "引用：开工"]) assert.equal(isPlanExecutionRequest(text), false, text);
  });
});
