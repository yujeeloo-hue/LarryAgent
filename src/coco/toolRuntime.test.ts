import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CocoToolRuntime } from "./toolRuntime.js";

const posix = process.platform !== "win32";
test("CoCo uses ordinary Shell environment and stops a command on shutdown", { skip: !posix }, async () => {
  const tools = new CocoToolRuntime(), root = mkdtempSync(join(tmpdir(),"coco-shared-shell-"));
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered=resolve; });
  try {
    const result = await tools.shell({command:'printf "%s" "$COCO_SHARED_TEST"',cwd:root,env:{COCO_SHARED_TEST:"shared-environment"},timeoutMs:3000},[]);
    assert.equal(result.stdout,"shared-environment"); assert.equal(result.exitCode,0);
    const pending = tools.shell({command:'printf ready; sleep 30',cwd:root,timeoutMs:0,onOutput:()=>entered()},[]);
    await started; await tools.close(); assert.equal((await pending).status,"cancelled");
    await assert.rejects(tools.shell({command:"echo late",cwd:root,timeoutMs:100},[]),/stopping/);
  } finally { await tools.close(); rmSync(root,{recursive:true,force:true}); }
});
test("a completed CoCo Shell command does not leave ordinary background children", { skip: !posix }, async () => {
  const tools = new CocoToolRuntime(), root = mkdtempSync(join(tmpdir(),"coco-shell-child-"));
  try {
    const result = await tools.shell({command:'(sleep 1; echo leaked > child.txt) & printf done',cwd:root,timeoutMs:3000},[]);
    assert.equal(result.exitCode,0); assert.equal(result.stdout,"done");
    await tools.close(); await new Promise(resolve=>setTimeout(resolve,1100)); assert.equal(existsSync(join(root,"child.txt")),false);
  } finally { await tools.close(); rmSync(root,{recursive:true,force:true}); }
});
// Skipped: sandbox-exec EPERM on macOS 26.6.2 (25G83) — `sandbox_apply: Operation not permitted`
// (exit 71) in the agent process context, host Seatbelt policy change (environment, not a code
// regression; enforcement path unchanged). Disabled by user decision on Open item 5,
// docs/audits/fulltest-watch.md §7.5, 2026-10-29. Re-enable when the host policy is fixed.
test("shared Shell automatically enforces excluded project paths on macOS", {skip:"sandbox-exec EPERM on macOS 26.6.2; disabled by user decision on Open item 5, 2026-10-29"},async()=>{
  const tools=new CocoToolRuntime(),root=mkdtempSync(join(tmpdir(),"coco-shell-exclusion-")),excluded=join(root,"excluded");mkdirSync(excluded);writeFileSync(join(excluded,"private.txt"),"private fixture");
  try{
    const allowed=await tools.shell({command:'echo permitted > allowed.txt; cat allowed.txt',cwd:root,timeoutMs:3000},[excluded]);
    assert.equal(allowed.exitCode,0);assert.match(allowed.stdout,/permitted/);
    const denied=await tools.shell({command:'cat excluded/private.txt; echo bypass > excluded/leak.txt',cwd:root,timeoutMs:3000},[excluded]);
    assert.notEqual(denied.exitCode,0);assert.ok(!denied.stdout.includes("private fixture"));assert.equal(existsSync(join(excluded,"leak.txt")),false);
  }finally{await tools.close();rmSync(root,{recursive:true,force:true});}
});
