import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  configureSkillPersistence,
  configureSkillsRoot,
  skillManager,
} from "../../skills/manager.js";
import { configureToolsConfigRoot, patchToolsConfig } from "../../toolsConfig/store.js";
import type { ToolExecuteContext } from "../types.js";
import { validateToolArguments } from "../validateToolArguments.js";
import {
  applySkillBodyEdits,
  patchSkillDefinition,
  patchSkillHandler,
} from "./patchSkill.js";

const ROOTS: string[] = [];

async function freshManager(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jb-skill-patch-"));
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

function ctx(extra: Partial<ToolExecuteContext> = {}): ToolExecuteContext {
  return { workspacePath: tmpdir(), ...extra } as ToolExecuteContext;
}

const REFLECTOR = { skillActor: "reflector", skillWritePolicy: "auto_owned_only" } as const;

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((p) => p.text ?? "").join("\n");
}

const LONG_BODY = [
  "- **Gate runs first**：`npm run typecheck` 之后再跑套件。",
  "- **报告入 docs/**：`docs/audits/*.md` 是本地产物。",
  "- **后台跑**：塞不进时限的才 `nohup`。",
].join("\n");

describe("applySkillBodyEdits", () => {
  it("tolerates indentation drift instead of failing", () => {
    const body = "- **Step one**\n  run the gate\n- **Step two**\n  ship it";
    const result = applySkillBodyEdits(body, [
      { oldString: "- **Step one**\nrun the gate", newString: "- **Step one**\nrun the gate twice" },
    ]);
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    assert.equal(result.ok ? result.fuzzyEdits : -1, 1);
    assert.match(result.ok ? result.body : "", /run the gate twice/);
  });

  it("skips identical and already-applied edits instead of failing", () => {
    const same = applySkillBodyEdits("a b c", [{ oldString: "b", newString: "b" }]);
    assert.deepEqual(same, { ok: true, body: "a b c", fuzzyEdits: 0 });

    const applied = applySkillBodyEdits("intro\nnew wording lives here\n", [
      { oldString: "old wording", newString: "new wording lives here" },
    ]);
    assert.deepEqual(applied, { ok: true, body: "intro\nnew wording lives here\n", fuzzyEdits: 0 });
  });

  it("rejects a duplicated anchor with an actionable message", () => {
    const result = applySkillBodyEdits("b b", [{ oldString: "b", newString: "B" }]);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /more than once/);
  });

  it("explains a missing anchor with the closest body lines", () => {
    const result = applySkillBodyEdits(LONG_BODY, [
      { oldString: "- **Gate runs last**：跑套件再 typecheck。", newString: "- **Gate runs last**：跑套件再 typecheck！" },
    ]);
    assert.equal(result.ok, false);
    const message = result.ok ? "" : result.message;
    assert.match(message, /edits\[0\]\.old_string was not found/);
    assert.match(message, /Did you mean|Lines \d+-\d+/);
    assert.match(message, /whitespace/);
  });
});

describe("patch_skill handler", () => {
  it("updates only the catalog description when edits are omitted", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill(
      { name: "desc-only", description: "Old.", body: "step one", enabled: true },
      { actor: "reflector", reason: "seed" },
    );
    const result = await patchSkillHandler(
      { id: record.id, description: "New catalog description.", reason: "search miss" },
      ctx(REFLECTOR),
    );
    assert.equal(result.returnCode ?? 0, 0, text(result));
    const after = skillManager.getRecord(record.id)!;
    assert.equal(after.description, "New catalog description.");
    assert.equal(after.body.trim(), "step one");
    assert.match(text(result), /body unchanged/);
  });

  it("accepts edits sent as a JSON string", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill(
      { name: "json-string", description: "D.", body: "step one", enabled: true },
      { actor: "reflector", reason: "seed" },
    );
    const result = await patchSkillHandler(
      {
        id: record.id,
        edits: JSON.stringify([{ old_string: "one", new_string: "two" }]),
        reason: "double-encoded array",
      },
      ctx(REFLECTOR),
    );
    assert.equal(result.returnCode ?? 0, 0, text(result));
    assert.equal(skillManager.getRecord(record.id)?.body.trim(), "step two");
  });

  it("requires edits or a description", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill(
      { name: "nothing", description: "D.", body: "step one", enabled: true },
      { actor: "reflector", reason: "seed" },
    );
    const result = await patchSkillHandler({ id: record.id, reason: "r" }, ctx(REFLECTOR));
    assert.notEqual(result.returnCode ?? 0, 0);
    assert.match(text(result), /provide "edits".*or "description"/);
  });

  it("names the frontmatter trap when the anchor is a frontmatter line", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill(
      { name: "front-trap", description: "D.", body: "step one", enabled: true },
      { actor: "reflector", reason: "seed" },
    );
    const result = await patchSkillHandler(
      {
        id: record.id,
        edits: [{ old_string: "name: front-trap", new_string: "name: renamed" }],
        reason: "rename attempt",
      },
      ctx(REFLECTOR),
    );
    assert.notEqual(result.returnCode ?? 0, 0);
    assert.match(text(result), /frontmatter/);
    assert.match(text(result), /`description` argument/);
  });

  it("writes nothing when every edit is a no-op", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill(
      { name: "noop", description: "D.", body: "step one", enabled: true },
      { actor: "reflector", reason: "seed" },
    );
    const before = skillManager.getRecord(record.id)!.revision;
    const result = await patchSkillHandler(
      { id: record.id, edits: [{ old_string: "step one", new_string: "step one" }], reason: "noop" },
      ctx(REFLECTOR),
    );
    assert.equal(result.returnCode ?? 0, 0, text(result));
    assert.match(text(result), /No change/);
    assert.equal(skillManager.getRecord(record.id)!.revision, before);
  });

  it("applies a whitespace-tolerant match and says so", async () => {
    await freshManager();
    const record = await skillManager.upsertSkill(
      {
        name: "tolerant",
        description: "D.",
        body: "- **Step one**\n  run the gate\n- **Step two**\n  ship it",
        enabled: true,
      },
      { actor: "reflector", reason: "seed" },
    );
    const result = await patchSkillHandler(
      {
        id: record.id,
        edits: [
          { old_string: "- **Step one**\nrun the gate", new_string: "- **Step one**\nrun the gate twice" },
        ],
        reason: "tidy wording",
      },
      ctx(REFLECTOR),
    );
    assert.equal(result.returnCode ?? 0, 0, text(result));
    assert.match(skillManager.getRecord(record.id)!.body, /run the gate twice/);
    assert.match(text(result), /whitespace\/format tolerance/);
  });
});

describe("patch_skill schema", () => {
  it("advertises an array for edits but tolerates a JSON string at execution", () => {
    const strict = validateToolArguments(
      { reason: "r", edits: '[{"old_string":"a","new_string":"b"}]' },
      patchSkillDefinition.parameters,
    );
    assert.equal(strict.ok, false);

    const execution = patchSkillDefinition.validationParameters;
    assert.ok(execution);
    const lenient = validateToolArguments(
      { reason: "r", edits: '[{"old_string":"a","new_string":"b"}]' },
      execution,
    );
    assert.equal(lenient.ok, true);
  });

  it("allows a description-only call through the advertised schema", () => {
    const ok = validateToolArguments(
      { name: "some-skill", description: "Only the description.", reason: "r" },
      patchSkillDefinition.parameters,
    );
    assert.equal(ok.ok, true);
  });
});
