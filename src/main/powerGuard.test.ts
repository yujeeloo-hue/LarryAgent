import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "powerGuard.ts"),
  "utf8",
);

test("power guard keeps the display awake while work runs", () => {
  // Product decision 2026-11-11: task running = screen on (no display
  // sleep, no lock). `prevent-app-suspension` let the screen go dark
  // mid-task even though the system stayed awake, which read as an
  // interruption. Lock the blocker type against accidental regression.
  assert.ok(
    source.includes('powerSaveBlocker.start("prevent-display-sleep")'),
    "guard must start prevent-display-sleep",
  );
  assert.ok(
    !source.includes('powerSaveBlocker.start("prevent-app-suspension")'),
    "prevent-app-suspension (display may sleep + lock mid-task) must not come back",
  );
});
