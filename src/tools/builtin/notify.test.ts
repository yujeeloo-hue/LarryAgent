/**
 * notify tool — fake-port behaviour (title validation, session passthrough,
 * copy clamping) + regex wiring locks mirroring loops.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { notifyDefinition, notifyHandler } from "./notify.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  JsonObject,
  ToolExecuteContext,
  ToolExecuteResult,
} from "../types.js";
import type { NotifyToolInput, NotifyToolPort } from "../notifyTool.js";
// Type-only: appNotify.ts imports electron; erased at runtime.
import type { appNotify } from "../../main/appNotify.js";

// Compile-time lock: the live hub function satisfies the structural port.
const _appNotifyIsPort: NotifyToolPort | null =
  null as unknown as typeof appNotify | null;

// ------------------------------------------------------------ fake port

function fakePort() {
  const calls: NotifyToolInput[] = [];
  const port: NotifyToolPort = (input) => {
    calls.push(input);
  };
  return { calls, port };
}

function ctx(
  over: Partial<ToolExecuteContext> = {},
  opts?: { noSession?: boolean },
): ToolExecuteContext {
  return {
    workspacePath: "/ws",
    ...(opts?.noSession ? {} : { sessionId: "session-42" }),
    ...over,
  } as ToolExecuteContext;
}

function run(
  args: JsonObject,
  context: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  return notifyHandler(args, context) as Promise<ToolExecuteResult>;
}

function text(res: ToolExecuteResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

// -------------------------------------------------------------- behaviour

describe("notify handler", () => {
  it("fails with the gate note when the port is absent", async () => {
    const res = await run({ title: "Hi" }, ctx());
    assert.equal(res.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(res), /no notify port/);
  });

  it("requires a non-empty title", async () => {
    const { port, calls } = fakePort();
    for (const bad of [undefined, "", "   "]) {
      const args: JsonObject = {};
      if (bad !== undefined) args.title = bad;
      const res = await run(args, ctx({ notify: port }));
      assert.equal(res.returnCode, ToolReturnCode.InvalidArguments, JSON.stringify(bad));
      assert.match(text(res), /"title" is required/);
    }
    assert.equal(calls.length, 0);
  });

  it("delivers title/body and passes the session id for click-to-jump", async () => {
    const { calls, port } = fakePort();
    const res = await run(
      { title: "Deploy finished", body: "2 files changed · 38s" },
      ctx({ notify: port }),
    );
    assert.equal(res.returnCode, ToolReturnCode.Success);
    assert.deepEqual(calls, [
      {
        title: "Deploy finished",
        body: "2 files changed · 38s",
        sessionId: "session-42",
      },
    ]);
    assert.match(text(res), /Notification delivered/);
  });

  it("body is optional (empty string when absent)", async () => {
    const { calls, port } = fakePort();
    await run({ title: "Ping" }, ctx({ notify: port }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body, "");
  });

  it("omits sessionId when the context has none", async () => {
    const { calls, port } = fakePort();
    await run({ title: "Ping" }, ctx({ notify: port }, { noSession: true }));
    assert.equal("sessionId" in calls[0]!, false);
  });

  // Message center is opt-in: the hub files an entry in the bell inbox only
  // when `inbox` is literally true, so the default path must not carry the
  // key at all (a stray `inbox: false` would still be a protocol change).
  it("omits inbox by default and forwards it only when true", async () => {
    const { calls, port } = fakePort();
    await run({ title: "Ping" }, ctx({ notify: port }));
    assert.equal("inbox" in calls[0]!, false);
    await run({ title: "Ping", inbox: false }, ctx({ notify: port }));
    assert.equal("inbox" in calls[1]!, false);
    await run({ title: "Ping", inbox: true }, ctx({ notify: port }));
    assert.equal(calls[2]!.inbox, true);
  });

  it("ignores a non-boolean inbox argument", async () => {
    const { calls, port } = fakePort();
    for (const bad of ["true", 1, null]) {
      await run({ title: "Ping", inbox: bad }, ctx({ notify: port }));
    }
    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal("inbox" in call, false);
  });

  it("result copy states where the notification lands", async () => {
    const { port } = fakePort();
    const transientRes = await run({ title: "Ping" }, ctx({ notify: port }));
    assert.match(text(transientRes), /transient — not filed in the bell inbox/);
    const inboxRes = await run(
      { title: "Ping", inbox: true },
      ctx({ notify: port }),
    );
    assert.match(text(inboxRes), /filed unread in the bell inbox until clicked/);
  });

  it("clamps over-long title and body", async () => {
    const { calls, port } = fakePort();
    await run(
      { title: "T".repeat(200), body: "B".repeat(500) },
      ctx({ notify: port }),
    );
    assert.equal(calls[0]!.title.length, 120);
    assert.ok(calls[0]!.title.endsWith("…"));
    assert.equal(calls[0]!.body.length, 300);
    assert.ok(calls[0]!.body.endsWith("…"));
  });

  it("definition shape: level 1, title required, no extra props", () => {
    assert.equal(notifyDefinition.name, "notify");
    assert.equal(notifyDefinition.defaultPermissionLevel, 1);
    assert.deepEqual(notifyDefinition.parameters.required, ["title"]);
    assert.equal(notifyDefinition.parameters.additionalProperties, false);
    const props = notifyDefinition.parameters.properties as Record<
      string,
      { type?: string }
    >;
    // The message-center opt-in must stay a plain boolean flag.
    assert.equal(props.inbox?.type, "boolean");
  });
});

// ----------------------------------------------------------- wiring locks

describe("notify wiring locks", () => {
  const read = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), "utf8");

  it("registered as a builtin in tools/index.ts", () => {
    const src = read("../index.ts");
    assert.match(src, /import \{ notifyDefinition, notifyHandler \}/);
    assert.match(src, /registerBuiltin\(notifyDefinition, notifyHandler\)/);
  });

  it("deferred: not in DEFAULT_OFFERED (search_tools discovery only)", () => {
    const src = read("../offerSet.ts");
    assert.doesNotMatch(src, /"notify"/);
  });

  it("context field declared in tools/types.ts", () => {
    const src = read("../types.ts");
    assert.match(src, /\| "notify"/);
    assert.match(src, /notify\?: import\("\.\/notifyTool\.js"\)\.NotifyToolPort/);
  });

  it("message center is opt-in: task-done files, the rest stays transient", () => {
    const hub = read("../../main/appNotify.ts");
    // The ledger write sits behind the inbox gate (default = transient), and
    // transient entries carry no unread semantics.
    assert.match(hub, /const toInbox = input\.inbox === true;/);
    assert.match(hub, /if \(toInbox\) \{\s*ledger\.unshift\(entry\);/);
    assert.match(hub, /read: !toInbox,/);
    // Task completion is the one automatic opt-in.
    const taskDone = read("../../main/desktopNotify.ts");
    assert.match(taskDone, /inbox: true,/);
    // The tray's one-shot "hidden to tray" hint must not collect there.
    const tray = read("../../main/appTray.ts");
    assert.doesNotMatch(tray, /inbox:/);
    // Click-to-jump on a transient popup: the entry must be captured before
    // closePopup drops the record (it lives nowhere else).
    assert.match(hub, /const entry = popup\?\.entry;/);
    assert.match(hub, /activateEntry\(id, entry\)/);
  });

  it("main host injects the hub via the daemon-safe holder", () => {
    const rt = read("../../main/sessionRuntime.ts");
    assert.match(rt, /getNotifyToolPort\(\)/);
    assert.match(rt, /\.\.\.\(notifyToolPort \? \{ notify: notifyToolPort \} : \{\}\)/);
    // Daemon-graph safety: sessionRuntime must not statically import the
    // hub (ipcMain/screen are absent from the loops electron shim).
    assert.doesNotMatch(rt, /from "\.\/appNotify\.js"/);
    const boot = read("../../main/index.ts");
    assert.match(boot, /setNotifyToolPort\(appNotify\)/);
    assert.match(boot, /setDesktopNotifySink\(appNotify\)/);
  });

  it("catalogued as interaction", () => {
    const src = read("../catalog.ts");
    assert.match(src, /notify: "interaction"/);
  });

  it("tool card shows the Bell icon", () => {
    // Glyph names live in the shared catalog now; the card resolves them
    // through `desktopFunctionalIconNodes` instead of naming a glyph inline.
    const src = read(
      "../../renderer/src/screens/conversation/cards/toolDisplay.ts",
    );
    assert.match(src, /toolIconCatalog/);
    assert.match(src, /desktopFunctionalIconNodes/);
    const catalog = read("../../shared/icons/toolIconCatalog.ts");
    assert.match(catalog, /"notify": \{[^}]*"displayName": "Notify"/);
    assert.match(catalog, /"notify": \{[^}]*"icon": "Bell"/);
  });
});
