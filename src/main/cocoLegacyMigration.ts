import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CocoRepository } from "../coco/repository.js";
import type { CocoRule } from "../coco/types.js";
import { listLoops, openLoopsDb } from "../loops/db.js";
import { isValidCadence, nextRunAt } from "../loops/schedule.js";

/** Import legacy Loops configuration and run records once. Old success is never reinterpreted as verified. */
export function migrateLegacyLoops(root: string, repository: CocoRepository): void {
  if (!repository.meta("loopsMigrated", false) && existsSync(join(root, "loops.sqlite"))) {
    const legacy = openLoopsDb(root);
    try {
      repository.transaction(() => {
        if (repository.meta("loopsMigrated", false)) return;
        for (const loop of listLoops(legacy)) {
          const cadence: unknown = JSON.parse(loop.cadenceJson);
          if (!isValidCadence(cadence)) throw new Error(`Invalid legacy cadence for ${loop.name}`);
          repository.put<CocoRule>("rule", { id: `loop-${loop.id}`, name: loop.name, objective: loop.prompt, mode: "fixed", scope: { all: false, workspaceIds: [loop.workspaceId], excludedWorkspaceIds: [] }, enabled: loop.enabled, confirmed: true, cadence, fullPermissions: loop.fullPermissions, providerId: loop.providerId, runMode: loop.runMode, reasoningEffort: loop.reasoningEffort, acceptance: [], nextRunAt: nextRunAt(cadence, new Date()).getTime(), createdAt: loop.createdAt, legacyId: loop.id, legacyConfig: loop });
          const runs = legacy.prepare("SELECT * FROM loop_runs WHERE loop_id=? ORDER BY started_at").iterate(loop.id);
          for (const run of runs) repository.put("legacyRun", { id: String(run.id), ruleId: `loop-${loop.id}`, sessionId: run.session_id, status: run.status, startedAt: run.started_at, endedAt: run.ended_at, error: run.error });
        }
        repository.setMeta("loopsMigrated", true);
      });
    } finally { legacy.close(); }
  }
}
