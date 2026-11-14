import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { configureSkillPersistence, configureSkillsRoot, skillManager } from "./manager.js";
import {
  describeSkillProposal,
  listSkillProposals,
  resolveSkillProposal,
} from "./proposals.js";
import {
  applyCurationDecision,
  curationTrigger,
  decisionPayload,
  parseCurationDecision,
  preselectCurationItems,
  CURATION_COOLDOWN_MS,
  CURATION_STALE_MS,
} from "./curation.js";
import { similarityClusters } from "./similarity.js";
import { buildSkillReflectDigest } from "./reflectDigest.js";
import { normalizeSkills } from "../toolsConfig/types.js";
import { configureToolsConfigRoot, patchToolsConfig } from "../toolsConfig/store.js";
import { patchSkillHandler, applySkillBodyEdits } from "../tools/builtin/patchSkill.js";
import { mergeSkillsHandler } from "../tools/builtin/mergeSkills.js";
import { deleteSkillHandler } from "../tools/builtin/deleteSkill.js";
import { searchSkillsHandler } from "../tools/builtin/searchSkills.js";
import type { ToolExecuteContext } from "../tools/types.js";
import type { SkillMutationContext } from "./types.js";
import type { Message } from "../session/types.js";

const ROOTS: string[] = [];

async function freshManager(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jb-skill-self-"));
  ROOTS.push(root);
  configureToolsConfigRoot(root);
  configureSkillsRoot(join(root, "skills"));
  configureSkillPersistence(async (skills) => {
    await patchToolsConfig({ skills });
  });
  await skillManager.startFromSettings([]);
  return join(root, "skills");
}

afterEach(async () => {
  for (const root of ROOTS.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

const AUTO: SkillMutationContext = { actor: "reflector", reason: "test" };

function ctx(extra: Partial<ToolExecuteContext> = {}): ToolExecuteContext {
  return { workspacePath: tmpdir(), ...extra } as ToolExecuteContext;
}

const REFLECTOR = { skillActor: "reflector", skillWritePolicy: "auto_owned_only" } as const;

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((p) => p.text ?? "").join("\n");
}

describe("skill metadata defaults", () => {
  it("legacy tools.json entries load as active user skills at revision 1", async () => {
    const [legacy] = normalizeSkills([{ id: "a", name: "legacy", enabled: true }]);
    assert.equal(legacy?.origin, undefined);
    await freshManager();
    await skillManager.upsertSkill({ name: "legacy", description: "Legacy.", body: "x", enabled: true });
    const record = skillManager.listRecords()[0]!;
    assert.equal(record.origin, "user");
    assert.equal(record.status, "active");
    assert.equal(record.revision, 1);
  });

  it("ignores unknown origins and status values", () => {
    const [skill] = normalizeSkills([{ id: "a", name: "x", enabled: true, origin: "robot", status: "gone", revision: 0 }]);
    assert.equal(skill?.origin, undefined);
    assert.equal(skill?.status, undefined);
    assert.equal(skill?.revision, undefined);
  });
});

describe("skill history", () => {
  it("snapshots before each change and restores a revision (restore is undoable)", async () => {
    await freshManager();
    const v1 = await skillManager.upsertSkill({ name: "deploy", description: "Deploy app.", body: "one", enabled: true }, AUTO);
    assert.equal(v1.origin, "reflector");
    const v2 = await skillManager.upsertSkill({ id: v1.id, name: "deploy", description: "Deploy app.", body: "two", enabled: true }, AUTO);
    assert.equal(v2.revision, 2);

    const revisions = await skillManager.listRevisions(v1.id);
    assert.deepEqual(revisions.map((r) => [r.revision, r.current]), [[2, true], [1, false]]);
    assert.equal(revisions[1]!.replacedBy.actor, "reflector");
    assert.equal((await skillManager.readRevision(v1.id, 1)).body.trim(), "one");

    const restored = await skillManager.restoreRevision(v1.id, 1);
    assert.equal(restored.body.trim(), "one");
    assert.equal(restored.revision, 3);
    assert.equal(restored.origin, "user", "a UI restore takes ownership");
    assert.equal((await skillManager.readRevision(v1.id, 2)).body.trim(), "two");
    await assert.rejects(() => skillManager.restoreRevision(v1.id, 3), /already the live version/);
  });

  it("keeps history for deleted skills until the prune window passes", async () => {
    const skillsRoot = await freshManager();
    const record = await skillManager.upsertSkill({ name: "gone", description: "Gone.", body: "b", enabled: true });
    await skillManager.removeSkill(record.id);
    assert.equal((await skillManager.pruneDeletedHistory()).length, 0);
    const pruned = await skillManager.pruneDeletedHistory(Date.now() + 31 * 86_400_000);
    assert.deepEqual(pruned, [record.id]);
    const left: string[] = await readdir(join(skillsRoot, ".history")).catch(() => []);
    assert.equal(left.includes(record.id), false);
  });
});

describe("deprecate / merge", () => {
  it("merge into a new skill deprecates every source as superseded by it", async () => {
    await freshManager();
    const a = await skillManager.upsertSkill({ name: "a-one", description: "A.", body: "a", enabled: true }, AUTO);
    const b = await skillManager.upsertSkill({ name: "b-two", description: "B.", body: "b", enabled: true }, AUTO);
    const merged = await skillManager.mergeSkills({ target: "ab", sources: [a.id, b.id], description: "AB.", body: "ab" }, AUTO);
    assert.equal(merged.created, true);
    assert.equal(merged.deprecated.length, 2);
    for (const source of merged.deprecated) {
      assert.equal(source.status, "deprecated");
      assert.equal(source.enabled, false);
      assert.equal(source.supersededBy, merged.target.id);
    }
    const catalog = skillManager.listEnabledCatalog();
    assert.deepEqual(catalog.map((c) => c.name), ["ab"]);
    const all = skillManager.listEnabledCatalog({ includeInactive: true });
    assert.equal(all.find((c) => c.name === "a-one")?.supersededByName, "ab");
  });

  it("merge into an existing source keeps it active", async () => {
    await freshManager();
    const a = await skillManager.upsertSkill({ name: "keep", description: "K.", body: "k", enabled: true }, AUTO);
    const b = await skillManager.upsertSkill({ name: "drop", description: "D.", body: "d", enabled: true }, AUTO);
    const merged = await skillManager.mergeSkills({ target: a.id, sources: [a.id, b.id], description: "K2.", body: "k2" }, AUTO);
    assert.equal(merged.created, false);
    assert.equal(merged.target.id, a.id);
    assert.equal(merged.target.status, "active");
    assert.deepEqual(merged.deprecated.map((r) => r.id), [b.id]);
  });

  it("reactivate clears the successor", async () => {
    await freshManager();
    const a = await skillManager.upsertSkill({ name: "old", description: "O.", body: "o", enabled: true });
    const b = await skillManager.upsertSkill({ name: "new", description: "N.", body: "n", enabled: true });
    await skillManager.deprecateSkill(a.id, { supersededBy: b.id });
    const back = await skillManager.reactivateSkill(a.id);
    assert.equal(back.status, "active");
    assert.equal(back.enabled, true);
    assert.equal(back.supersededBy, undefined);
  });
});

describe("skill write tools", () => {
  it("applySkillBodyEdits requires a unique exact match", () => {
    assert.deepEqual(applySkillBodyEdits("a b c", [{ oldString: "b", newString: "B" }]), { ok: true, body: "a B c" });
    const none = applySkillBodyEdits("a b c", [{ oldString: "z", newString: "Z" }]);
    assert.equal(none.ok, false);
    const many = applySkillBodyEdits("b b", [{ oldString: "b", newString: "B" }]);
    assert.equal(many.ok, false);
    assert.match(many.ok ? "" : many.message, /more than once/);
  });

  it("reflector patch of an auto-owned skill writes directly", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill({ name: "auto", description: "Auto.", body: "step one", enabled: true }, AUTO);
    const result = await patchSkillHandler(
      { id: record.id, edits: [{ old_string: "one", new_string: "two" }], reason: "fix step" },
      ctx(REFLECTOR),
    );
    assert.equal(result.returnCode ?? 0, 0, text(result));
    assert.equal(skillManager.getRecord(record.id)?.body.trim(), "step two");
    assert.equal(result.receipt?.kind, "skill_write");
    assert.equal((await listSkillProposals()).length, 0);
  });

  it("reflector patch of a user skill becomes a proposal; accept applies it as the user", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill({ name: "mine", description: "Mine.", body: "step one", enabled: true });
    const result = await patchSkillHandler(
      { id: record.id, edits: [{ old_string: "one", new_string: "two" }], reason: "fix step" },
      ctx(REFLECTOR),
    );
    assert.equal(result.returnCode ?? 0, 0);
    assert.match(text(result), /suggestion/i);
    assert.equal(skillManager.getRecord(record.id)?.body.trim(), "step one");
    const [proposal] = await listSkillProposals({ status: "pending" });
    assert.ok(proposal);
    const view = describeSkillProposal(proposal, skillManager);
    assert.equal(view.stale, false);
    assert.match(view.changes[0]!.after, /step two/);

    const resolved = await resolveSkillProposal(proposal.id, "accept", skillManager);
    assert.equal(resolved.proposal.status, "accepted");
    const after = skillManager.getRecord(record.id)!;
    assert.equal(after.body.trim(), "step two");
    assert.equal(after.origin, "user");
  });

  it("a proposal goes stale when the skill changes first", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill({ name: "mine", description: "Mine.", body: "step one", enabled: true });
    await patchSkillHandler({ id: record.id, edits: [{ old_string: "one", new_string: "two" }], reason: "r" }, ctx(REFLECTOR));
    await skillManager.upsertSkill({ id: record.id, name: "mine", description: "Mine.", body: "step one!", enabled: true });
    const [proposal] = await listSkillProposals({ status: "pending" });
    assert.equal(describeSkillProposal(proposal!, skillManager).stale, true);
    await assert.rejects(() => resolveSkillProposal(proposal!.id, "accept", skillManager), /out of date/);
    const rejected = await resolveSkillProposal(proposal!.id, "reject", skillManager);
    assert.equal(rejected.proposal.status, "rejected");
  });

  it("keeps at most 3 pending proposals per skill (oldest auto-rejected)", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill({ name: "mine", description: "Mine.", body: "s1 s2 s3 s4", enabled: true });
    for (const n of [1, 2, 3, 4]) {
      await patchSkillHandler({ id: record.id, edits: [{ old_string: `s${n}`, new_string: `S${n}` }], reason: `r${n}` }, ctx(REFLECTOR));
    }
    const all = await listSkillProposals();
    assert.equal(all.filter((p) => p.status === "pending").length, 3);
    const rejected = all.filter((p) => p.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason, "r1");
  });

  it("reflector merge_skills deprecates sources; delete is refused", async () => {
    await freshManager();
    const a = await skillManager.upsertSkill({ name: "x-one", description: "X.", body: "x", enabled: true }, AUTO);
    const b = await skillManager.upsertSkill({ name: "x-two", description: "X2.", body: "x2", enabled: true }, AUTO);
    const merged = await mergeSkillsHandler(
      { source_ids: [a.id, b.id], target: { name: "x-all", description: "All X.", body: "all" }, reason: "duplicates" },
      ctx(REFLECTOR),
    );
    assert.equal(merged.returnCode ?? 0, 0, text(merged));
    assert.equal(skillManager.getRecord(a.id)?.status, "deprecated");

    const deleted = await deleteSkillHandler({ id: b.id }, ctx(REFLECTOR));
    assert.notEqual(deleted.returnCode ?? 0, 0);
    assert.ok(skillManager.getRecord(b.id));
  });

  it("search_skills hides deprecated skills unless include_inactive", async () => {
    await freshManager();
    const a = await skillManager.upsertSkill({ name: "pdf-export", description: "Export PDF files.", body: "x", enabled: true });
    await skillManager.deprecateSkill(a.id, {});
    const hidden = text(await searchSkillsHandler({ query: "pdf" }, ctx()));
    assert.doesNotMatch(hidden, /pdf-export/);
    const shown = text(await searchSkillsHandler({ query: "pdf", include_inactive: true }, ctx()));
    assert.match(shown, /pdf-export/);
    assert.match(shown, /deprecated/);
  });
});

describe("similarity", () => {
  it("clusters near-duplicate skills and leaves unrelated ones out", () => {
    const clusters = similarityClusters(
      [
        { id: "a", text: "deploy the web app to production with docker compose" },
        { id: "b", text: "deploy web app production docker compose rollout" },
        { id: "c", text: "write unit tests for the parser module" },
      ],
      0.3,
    );
    assert.deepEqual(clusters, [["a", "b"]]);
  });
});

describe("reflect digest", () => {
  const counters = { turnModelIterations: 12, toolErrorCount: 30, toolRecoveryCount: 0 };

  it("is empty-safe and deterministic", () => {
    const input = { turnMessages: [], counters, skillsRead: [], similar: [] };
    const first = buildSkillReflectDigest(input);
    assert.match(first, /^\[SKILL_REFLECT_DIGEST\]/);
    assert.equal(buildSkillReflectDigest(input), first);
  });

  it("caps failures and total size", () => {
    const turnMessages: Message[] = [
      { id: "u", role: "user", createdAt: 1, parts: [{ type: "text", text: "do it" }] },
    ];
    for (let i = 0; i < 30; i++) {
      turnMessages.push(
        {
          id: `a${i}`,
          role: "assistant",
          createdAt: 2 + i,
          parts: [{ type: "tool_call", id: `c${i}`, name: "run_shell", status: "error", arguments: { command: `cmd ${i} ${"x".repeat(500)}` }, argumentsRaw: "{}" }],
        },
        {
          id: `t${i}`,
          role: "tool",
          toolCallId: `c${i}`,
          createdAt: 2 + i,
          parts: [{ type: "tool_result", toolCallId: `c${i}`, returnCode: 1, content: [{ type: "text", text: "E".repeat(2000) }] }],
        },
      );
    }
    const digest = buildSkillReflectDigest({
      turnMessages,
      counters,
      skillsRead: Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}-${"n".repeat(80)}` })),
      similar: [],
    });
    assert.ok(digest.length <= 4000, `digest is ${digest.length} chars`);
    assert.ok((digest.match(/run_shell/g) ?? []).length <= 8);
  });
});

describe("curation", () => {
  const day = 86_400_000;

  it("trigger respects enable, cooldown and the auto-write threshold", () => {
    const base = { now: 10 * day, records: [], recentUsage: () => [] };
    assert.equal(curationTrigger({ ...base, enabled: false, state: { autoWritesSinceRun: 9, touched: {} } }), null);
    assert.equal(
      curationTrigger({ ...base, enabled: true, state: { autoWritesSinceRun: 9, touched: {}, lastRunAt: 10 * day - CURATION_COOLDOWN_MS + 1 } }),
      null,
    );
    assert.equal(curationTrigger({ ...base, enabled: true, state: { autoWritesSinceRun: 5, touched: {} } }), "auto_writes");
    assert.equal(curationTrigger({ ...base, enabled: true, state: { autoWritesSinceRun: 0, touched: {} } }), null);
  });

  it("preselect skips open reads and recently touched skills; stale applies to automatic origins only", async () => {
    await freshManager();
    const old = 0;
    const now = CURATION_STALE_MS + 10 * day;
    const auto = await skillManager.upsertSkill({ name: "auto-old", description: "Old auto skill about kites.", body: "kites", enabled: true }, AUTO);
    const user = await skillManager.upsertSkill({ name: "user-old", description: "Old user skill about boats.", body: "boats", enabled: true });
    const records = skillManager.listRecords().map((r) => ({ ...r, createdAt: old + 1 }));
    const base = { records, stats: [], recentUsage: () => [], now };

    const items = preselectCurationItems({ ...base, openReads: new Set(), touched: {} });
    assert.deepEqual(items.map((i) => [i.kind, i.skillIds[0]]), [["stale", auto.id]]);
    assert.equal(items.some((i) => i.skillIds.includes(user.id)), false);

    assert.equal(preselectCurationItems({ ...base, openReads: new Set([auto.id]), touched: {} }).length, 0);
    assert.equal(preselectCurationItems({ ...base, openReads: new Set(), touched: { [auto.id]: now - day } }).length, 0);
  });

  it("parses decisions and maps them to payloads", async () => {
    assert.equal(parseCurationDecision("not json"), null);
    const decision = parseCurationDecision('```json\n{"action":"deprecate","target":"a","reason":"unused"}\n```');
    assert.equal(decision?.action, "deprecate");
    await freshManager();
    const a = await skillManager.upsertSkill({ name: "a", description: "A.", body: "a", enabled: true }, AUTO);
    const mapped = decisionPayload(decision!, [a], [a]);
    assert.ok(mapped && !("error" in mapped));
    assert.equal(mapped.payload.kind, "deprecate");
    const bad = decisionPayload({ action: "merge", reason: "r", description: "d", body: "b", target: "a" }, [a], [a]);
    assert.ok(bad && "error" in bad);
  });

  it("applies directly to auto-owned skills and proposes for user-owned ones", async () => {
    await freshManager();
    const auto = await skillManager.upsertSkill({ name: "auto-x", description: "A.", body: "a", enabled: true }, AUTO);
    const user = await skillManager.upsertSkill({ name: "user-x", description: "U.", body: "u", enabled: true });
    const direct = await applyCurationDecision({
      item: { kind: "stale", skillIds: [auto.id], lastUsedAt: 0 },
      decision: { action: "deprecate", reason: "unused" },
      manager: skillManager,
    });
    assert.equal(direct.applied, true);
    assert.equal(skillManager.getRecord(auto.id)?.status, "deprecated");
    const [revision] = (await skillManager.listRevisions(auto.id)).filter((r) => !r.current);
    assert.equal(revision, undefined, "deprecate does not rewrite content");

    const proposed = await applyCurationDecision({
      item: { kind: "poor", skillIds: [user.id], uses: 5, successRate: 0.2, failures: [] },
      decision: { action: "patch", reason: "clarify", description: "U2.", body: "u2" },
      manager: skillManager,
    });
    assert.equal(proposed.applied, false);
    assert.ok(proposed.proposalId);
    assert.equal(skillManager.getRecord(user.id)?.body.trim(), "u");
    const [proposal] = await listSkillProposals({ status: "pending" });
    assert.match(proposal!.reason, /^\[curation\]/);
  });
});
