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
  assert.ok(
    source.includes('powerSaveBlocker.start("prevent-display-sleep")'),
    "guard must start prevent-display-sleep",
  );
  assert.ok(
    !source.includes('powerSaveBlocker.start("prevent-app-suspension")'),
    "prevent-app-suspension (display may sleep + lock mid-task) must not come back",
  );
});
