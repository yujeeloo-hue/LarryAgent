import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./sessionRuntime.js";
import { createCocoService } from "./cocoService.js";
import { registerBuiltins } from "../tools/index.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { defaultSettings } from "../coco/validation.js";
import { mcpManager } from "../mcp/manager.js";
import { encodeMcpToolName } from "../mcp/toolNames.js";
import { setToolPermissionLevel, clearToolPermissionOverride } from "../tools/config.js";
import type { CocoToolApproval } from "../coco/types.js";
import { SHELL_TOOL_NAME } from "../tools/shellToolName.js";

// Platform isolation (docs/audits/fulltest-watch.md §11; same host condition as §7.3/item 5):
// on macOS hosts where sandbox-exec fails at `sandbox_apply: Operation not permitted`, the
// excluded-project shell wrap (src/tools/shellExclusions.ts) cannot initialize — every wrapped
// CoCo shell exits 71 (EX_OSERR) without running, so the Shell step below never writes proof.txt.
// Probe once per process and skip loudly only under exactly that broken-host condition;
// everywhere sandbox-exec initializes, the full Shell → MCP → acceptance coverage (including
// the deny-roots wrap itself) still runs. Re-enable removes nothing: this is a conditional skip.
const seatbeltSkip = process.platform === "darwin"
  ? (() => {
      const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/echo", "ok"], { encoding: "utf8" });
      return probe.status !== 0 && /sandbox_apply: Operation not permitted/.test(probe.stderr ?? "")
        ? "sandbox-exec sandbox_apply EPERM on this macOS host; excluded-project wrap cannot initialize (fulltest-watch §7.3/§11)"
        : false;
    })()
  : false;

for (const ask of [false,true]) test(`real CoCo reuses configured MCP ${ask ? "Ask policy" : "without separate grants"}: Shell → MCP → acceptance`, { timeout: 20000, skip: seatbeltSkip }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coco-tools-app-"))), project = realpathSync(mkdtempSync(join(tmpdir(), "coco-tools-project-")));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root); configurePromptDefaults(join(process.cwd(), "resources/prompts")); registerBuiltins();
  let projectId = "", toolCalls = 0;
  const toolName = encodeMcpToolName("coco-fixture", "record");
  if(ask)setToolPermissionLevel(toolName,2);else clearToolPermissionOverride(toolName);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += String(chunk); const payload = JSON.parse(body || "{}");
    if (req.url === "/mcp") {
      if (payload.id === undefined) { res.writeHead(202).end(); return; }
      let result: unknown;
      if (payload.method === "initialize") result = { protocolVersion: payload.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Local fixture", version: "1" } };
      else if (payload.method === "tools/list") result = { tools: [{ name: "record", description: "Record a test outcome", inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } }] };
      else if (payload.method === "tools/call") { toolCalls++; assert.deepEqual(payload.params.arguments, { project: "fixture" }); result = { content: [{ type: "text", text: "mcp-result: recorded" }] }; }
      else result = {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result })); return;
    }
    const messages = payload.messages, first = messages.filter((m: {role:string})=>m.role==="system").map((m: {content?:unknown})=>String(m.content??"")).join("\n"), serialized = JSON.stringify(messages);
    let delta: Record<string, unknown>;
    if (messages.some((m:{role:string;content:unknown})=>m.role === "system" && String(m.content).includes("You are CoCo, the user's commander"))) {
      const submitted = messages.some((m:{tool_calls?:{function:{name:string}}[]})=>m.tool_calls?.some(c=>c.function.name==="coco_work"));
      delta = submitted ? {content:"The work was saved; I will verify its outcome."} : {tool_calls:[{index:0,id:"save-proof",type:"function",function:{name:"coco_work",arguments:JSON.stringify({action:"submit",plan:{ reply: "Plan saved", planOnly: false, work: [{ key: "proof", title: "Run a check and record it", objective: "Use Shell to write proof.txt and record the result with MCP", workspaceId: projectId, priority: 50, dependsOn: [], steps: ["Write proof.txt using Shell", "Record using MCP"], deliverables: ["proof.txt"], acceptance: [{ id: "proof", description: "proof.txt contains proof and MCP recorded the result", kind: "review" }] }], ruleSuggestions: [] }})}}] };
    } else if (first.includes("evaluating whether a project task is complete")) delta = { content: JSON.stringify({ action: "complete", reason: "proof.txt contains the recorded result" }) };
    else if (!serialized.includes(`"name":"${SHELL_TOOL_NAME}"`)) delta = { tool_calls: [{ index: 0, id: "shell-proof", type: "function", function: { name: SHELL_TOOL_NAME, arguments: JSON.stringify({ command: "node --version && npm --version && node -e \"require('fs').writeFileSync('proof.txt','proof')\"" }) } }] };
    else if (!serialized.includes(toolName)) delta = { tool_calls: [{ index: 0, id: "mcp-proof", type: "function", function: { name: toolName, arguments: JSON.stringify({ project: "fixture" }) } }] };
    else delta = { content: "Check and recording finished; independently verify the evidence." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ providers: [{ id: "local", name: "Test", baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "coco-tools" }], activeProviderId: "local", userMemoryAutoExtract: false, projectMemoryAutoExtract: false, composerRunMode: "agent", maxModelIterations: 5 }));
  await mcpManager.startFromSettings([{ id: "coco-fixture", name: "Local fixture", enabled: true, transport: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` } }]);
  const store = createSessionStore(root, { startBackgroundServices: false }); projectId = (await store.createWorkspace({ name: "Test project", path: project })).id;
  const coco = createCocoService(root, store,undefined,undefined,{projectAwareness:false});
  coco.engine.repository.setMeta("settings", { ...defaultSettings(),enabled:true, fullPermissions: false, shellEnabled: false, excludedSessionIds: ["obsolete"] });
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.ok(predicate(), JSON.stringify(coco.engine.snapshot().work)); };
  try {
    coco.start(); coco.engine.command({ type: "chat", text: "Run a check and record it" });
    if(ask){
      await wait(() => coco.engine.snapshot().work[0]?.status === "to_decide");
      assert.equal(toolCalls, 0, "Larry Agent's Ask permission is still enforced");
      const pending=coco.engine.snapshot().toolApprovals?.[0];assert.ok(pending);assert.equal(pending.toolName,toolName);
      assert.throws(()=>coco.engine.command({type:"work",id:pending.workId,action:"resume",answer:"continue"}),/exact tool invocation/);
      coco.engine.command({type:"toolApproval",id:pending.id,action:"approve"});
      await wait(()=>coco.engine.snapshot().work[0]?.status==="completed");
      assert.equal(coco.engine.repository.get<CocoToolApproval>("toolApproval",pending.id)?.status,"consumed");
      assert.throws(()=>coco.engine.command({type:"toolApproval",id:pending.id,action:"approve"}),/no longer current/);
    }else{
      await wait(()=>["completed","to_decide"].includes(coco.engine.snapshot().work[0]?.status ?? ""));
      assert.equal(coco.engine.snapshot().toolApprovals?.length,0,"configured MCP needs no additional CoCo approval");
    }
    const final=coco.engine.snapshot();assert.equal(final.work[0]?.status,"completed",JSON.stringify(final.work));assert.equal(toolCalls,1);
    assert.equal(readFileSync(join(project,"proof.txt"),"utf8"),"proof");assert.equal(final.work[0]?.fullPermissions,true);
    const calls = coco.engine.repository.list<{ toolName: string; status: string }>("toolInvocation"); assert.ok(calls.some(c => c.toolName === SHELL_TOOL_NAME && c.status === "done")); assert.ok(calls.some(c => c.toolName === toolName && c.status === "finished"));
    assert.equal(final.verifications.at(-1)?.passed, true);
  } finally {
    clearToolPermissionOverride(toolName); coco.stop(); await coco.shutdown(); store.memorySync.stop(); store.database.close(); await mcpManager.reconcile([]); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
  }
});
