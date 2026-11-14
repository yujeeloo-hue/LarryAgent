/**
 * Device-local trash mover (agentd rm → Trash rewrite target): moves files
 * and directories under a timestamped name into the configured trash root,
 * keeping the content recoverable. EXDEV (cross-device, e.g. /tmp tmpfs)
 * falls back to copy-then-remove.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceTrashMover } from "./deviceTrash.js";

test("moves a file into the trash root under a stamped name", async () => {
  const base = mkdtempSync(join(tmpdir(), "jb-device-trash-"));
  const trashRoot = join(base, "trash");
  const file = join(base, "hello.txt");
  writeFileSync(file, "payload", "utf8");

  const mover = createDeviceTrashMover(trashRoot);
  await mover(file);

  assert.equal(existsSync(file), false, "source removed");
  const entries = readdirSync(trashRoot);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /^\d+-[0-9a-f]{8}-hello\.txt$/);
});

test("moves a directory recursively and creates the trash root on demand", async () => {
  const base = mkdtempSync(join(tmpdir(), "jb-device-trash-"));
  const trashRoot = join(base, "nested", "trash");
  const dir = join(base, "bundle");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "a", "utf8");
  writeFileSync(join(dir, "sub", "b.txt"), "b", "utf8");

  const mover = createDeviceTrashMover(trashRoot);
  await mover(dir);

  assert.equal(existsSync(dir), false, "source dir removed");
  const parked = readdirSync(trashRoot)[0]!;
  assert.match(parked, /bundle$/);
  assert.ok(existsSync(join(trashRoot, parked, "sub", "b.txt")), "tree intact");
});

test("same-name targets never collide (unique stamped names)", async () => {
  const base = mkdtempSync(join(tmpdir(), "jb-device-trash-"));
  const trashRoot = join(base, "trash");
  const mover = createDeviceTrashMover(trashRoot);

  for (const rel of ["one/a.txt", "two/a.txt"]) {
    mkdirSync(join(base, rel.split("/")[0]!), { recursive: true });
    const p = join(base, rel);
    writeFileSync(p, "x", "utf8");
    await mover(p);
  }

  const entries = readdirSync(trashRoot).filter((n) => n.endsWith("a.txt"));
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0], entries[1]);
});
