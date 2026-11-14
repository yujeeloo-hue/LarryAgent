import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { openSessionDb, type SessionDatabase } from "../session/db/openDb.js";
import {
  configureSkillUsage,
  countFreshTurnSkillReads,
  finalizeTurnSkillUsage,
  getSkillUsageStats,
  listOpenSkillReads,
  listRecentSkillReads,
  recordSkillRead,
} from "./usage.js";

const ZERO = { errors: 0, recoveries: 0, corrections: 0 };
const HOUR = 3_600_000;

describe("skill usage ledger", () => {
  let root: string;
  let db: SessionDatabase;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "jb-skill-usage-"));
  });

  beforeEach(() => {
    db = openSessionDb(join(root, String(Math.random())));
    configureSkillUsage({ db });
  });

  after(() => {
    configureSkillUsage({ db: null });
    rmSync(root, { recursive: true, force: true });
  });

  it("is a silent no-op without a database", () => {
    configureSkillUsage({ db: null });
    recordSkillRead({ skillId: "a", skillName: "a", sessionId: "s", counters: ZERO });
    assert.equal(countFreshTurnSkillReads({ sessionId: "s", turnStartedAt: 0 }), null);
    assert.deepEqual(getSkillUsageStats(), []);
  });

  it("finalizes outcome as deltas since the read and keeps subagent rows separate", () => {
    const t0 = 10 * HOUR;
    recordSkillRead({ skillId: "a", skillName: "a", sessionId: "p", at: t0 + 1, counters: { errors: 1, recoveries: 0, corrections: 0 } });
    recordSkillRead({ skillId: "b", skillName: "b", sessionId: "p", subagentId: "child", at: t0 + 2, counters: ZERO });
    assert.deepEqual([...listOpenSkillReads()].sort(), ["a", "b"]);

    finalizeTurnSkillUsage({ sessionId: "p", subagentId: "child", turnStartedAt: t0, outcome: "idle", counters: { errors: 2, recoveries: 0, corrections: 0 } });
    finalizeTurnSkillUsage({ sessionId: "p", turnStartedAt: t0, outcome: "idle", counters: { errors: 1, recoveries: 0, corrections: 1 } });

    const [a] = listRecentSkillReads({ skillId: "a", limit: 5 });
    assert.equal(a?.outcome, "idle");
    assert.equal(a?.errorsAfter, 0);
    assert.equal(a?.userSteered, true);
    const [b] = listRecentSkillReads({ skillId: "b", limit: 5 });
    assert.equal(b?.subagentId, "child");
    assert.equal(b?.errorsAfter, 2);
    assert.equal(listOpenSkillReads().size, 0);

    const stats = new Map(getSkillUsageStats().map((s) => [s.skillId, s]));
    assert.equal(stats.get("a")?.successes, 1);
    assert.equal(stats.get("a")?.corrected, 1);
    assert.equal(stats.get("b")?.successes, 0);
  });

  it("counts only skills not read by the session inside the cooldown window", () => {
    const turn = 100 * HOUR;
    recordSkillRead({ skillId: "old", skillName: "old", sessionId: "s", at: turn - 2 * HOUR, counters: ZERO });
    recordSkillRead({ skillId: "ancient", skillName: "ancient", sessionId: "s", at: turn - 48 * HOUR, counters: ZERO });
    recordSkillRead({ skillId: "other", skillName: "other", sessionId: "x", at: turn - HOUR, counters: ZERO });
    for (const id of ["old", "ancient", "other", "new"]) {
      recordSkillRead({ skillId: id, skillName: id, sessionId: "s", at: turn + 1, counters: ZERO });
    }
    assert.equal(countFreshTurnSkillReads({ sessionId: "s", turnStartedAt: turn }), 3);
  });
});
