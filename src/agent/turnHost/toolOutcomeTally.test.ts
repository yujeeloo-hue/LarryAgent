import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SKILL_READ_RECEIPT_KIND } from "../../tools/types.js";
import type { ToolCallReceipt } from "../runTools.js";
import { createToolOutcomeTally, tallyToolReceipts } from "./toolOutcomeTally.js";

let seq = 0;
function receipt(name: string, returnCode: number, extra: Partial<ToolCallReceipt> = {}): ToolCallReceipt {
  return { toolCallId: `c${++seq}`, name, returnCode, ...extra };
}

describe("tool outcome tally", () => {
  it("counts denials and returns each skill only on its first read", () => {
    const tally = createToolOutcomeTally();
    const read = (skillId: string) =>
      receipt("read_skill", 0, { receipt: { kind: SKILL_READ_RECEIPT_KIND, skillId, skillName: skillId, revision: 2 } });
    const first = tallyToolReceipts(tally, [read("a"), read("a"), receipt("run_shell", 6)]);
    assert.deepEqual(first, [{ skillId: "a", skillName: "a", revision: 2 }]);
    assert.deepEqual(tallyToolReceipts(tally, [read("a"), read("b")]).map((f) => f.skillId), ["b"]);
    assert.equal(tally.denials, 1);
  });

  it("counts errors 1 / 4 / 5 only; deny, not-found and cancel are ignored", () => {
    const tally = createToolOutcomeTally();
    tallyToolReceipts(tally, [
      receipt("run_shell", 1),
      receipt("read_file", 4),
      receipt("edit_file", 5),
      receipt("write_file", 2),
      receipt("read_file", 3),
      receipt("run_shell", 6),
    ]);
    assert.equal(tally.errors, 3);
    assert.equal(tally.recoveries, 0);
  });

  it("pairs each error with at most one later success of the same tool, across batches", () => {
    const tally = createToolOutcomeTally();
    tallyToolReceipts(tally, [receipt("run_shell", 1), receipt("run_shell", 1), receipt("grep", 0)]);
    tallyToolReceipts(tally, [receipt("run_shell", 0)]);
    tallyToolReceipts(tally, [receipt("run_shell", 0), receipt("run_shell", 0)]);
    assert.equal(tally.errors, 2);
    assert.equal(tally.recoveries, 2);
  });

  it("does not count a success that precedes the error", () => {
    const tally = createToolOutcomeTally();
    tallyToolReceipts(tally, [receipt("run_shell", 0), receipt("run_shell", 1)]);
    assert.equal(tally.recoveries, 0);
  });

  it("records distinct skills from successful skill_read receipts", () => {
    const tally = createToolOutcomeTally();
    const read = (skillId: string, code = 0) =>
      receipt("read_skill", code, { receipt: { kind: SKILL_READ_RECEIPT_KIND, skillId, skillName: skillId } });
    tallyToolReceipts(tally, [read("a"), read("a"), read("b"), receipt("read_skill", 0)]);
    assert.deepEqual([...tally.skillsRead].sort(), ["a", "b"]);
  });
});
