import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { DapClient, formatDapFailure, isDapNotStopped } from "./dapClient.js";
import {
  DapFramer,
  encodeDapMessage,
} from "./dapFraming.js";
import {
  buildShlibBreakpointCommand,
  DebugSession,
  isUnresolvedBreakpointResult,
  lldbAttachArguments,
  lldbInitCommands,
  parseLldbBreakpointId,
  parseLldbStringList,
} from "./dapSession.js";
import { attachFakeAdapter } from "./fakeAdapter.js";

function pair(): {
  client: DapClient;
  toAdapter: PassThrough;
  fromAdapter: PassThrough;
} {
  const toAdapter = new PassThrough();
  const fromAdapter = new PassThrough();
  const client = new DapClient({
    readable: fromAdapter,
    writable: toAdapter,
    timeoutMs: 5_000,
  });
  return { client, toAdapter, fromAdapter };
}

describe("lldb attach arguments", () => {
  it("omits the PDB allowlist for stock lldb-dap and the PDB reader off Windows", () => {
    const args = lldbAttachArguments({
      attachPid: 7,
      pdbModuleAllowlist: ["Game.dylib"],
      usePdbAllowlist: false,
      os: "darwin",
    });
    assert.equal("pdbModuleAllowlist" in args, false);
    const init = args.initCommands as string[];
    assert.ok(init.some((cmd) => cmd.includes("symbols.load-on-demand true")));
    assert.ok(!init.some((cmd) => cmd.includes("symbol-file.pdb")));
    assert.ok(lldbInitCommands("win32").some((cmd) => cmd.includes("symbol-file.pdb")));
  });
});

describe("DapClient + DebugSession (fake adapter)", () => {
  it("launches managed targets through coreclr without LLDB commands and terminates owned launches", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    const requests: Array<{ command: string; arguments?: unknown }> = [];
    attachFakeAdapter(toAdapter, fromAdapter, req => {
      requests.push(req);
      if (req.command === "launch") return { events: [{ event: "initialized", body: {} }] };
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({ adapterPath: "/netcoredbg", protocol: "coreclr", program: "/app/App.dll", breakpoints: [], waitForStop: false });
    const launch = requests.find(req => req.command === "launch")!.arguments as Record<string, unknown>;
    assert.equal(launch.program, "/app/App.dll");
    assert.equal(launch.initCommands, undefined);
    assert.equal(requests.some(req => req.command === "evaluate"), false);
    await session.dispose();
    assert.equal((requests.find(req => req.command === "disconnect")!.arguments as { terminateDebuggee: boolean }).terminateDebuggee, true);
  });
  it("pauses the named main application thread", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let pausedThreadId: number | undefined;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "threads") {
        return {
          response: {
            threads: [
              { id: 7, name: "RenderThread" },
              { id: 9, name: "GameThread" },
            ],
          },
        };
      }
      if (req.command === "pause") {
        pausedThreadId = (req.arguments as { threadId?: number }).threadId;
        return {};
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.pauseMainThread();
    assert.equal(pausedThreadId, 9);
    session.client.dispose();
  });

  it("pauses every thread when lldb-dap refuses threads while running", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let pausedThreadId: number | undefined;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "threads") {
        return { success: false, message: "notStopped" };
      }
      if (req.command === "pause") {
        pausedThreadId = (req.arguments as { threadId?: number }).threadId;
        return {};
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.pauseMainThread();
    assert.equal(pausedThreadId, 0);
    session.client.dispose();
  });

  it("retries pause-all when a concrete thread id is notStopped", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    const pauseIds: number[] = [];
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "threads") {
        return {
          response: { threads: [{ id: 9, name: "GameThread" }] },
        };
      }
      if (req.command === "pause") {
        const id = (req.arguments as { threadId?: number }).threadId ?? -1;
        pauseIds.push(id);
        if (id !== 0) return { success: false, message: "notStopped" };
        return {};
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.pauseMainThread();
    assert.deepEqual(pauseIds, [9, 0]);
    session.client.dispose();
  });

  it("runs initialize → breakpoints → launch → stack/locals", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let launchSeq = 0;
    let hoverArgs: unknown;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "launch") {
        launchSeq = req.seq;
        return {
          skipResponse: true,
          events: [{ event: "initialized" }],
        };
      }
      if (req.command === "setBreakpoints") {
        return { response: { breakpoints: [{ verified: true, line: 4 }] } };
      }
      if (req.command === "configurationDone") {
        return {
          extraResponses: [{ request_seq: launchSeq, command: "launch" }],
          events: [{ event: "stopped", body: { reason: "breakpoint", threadId: 1 } }],
        };
      }
      if (req.command === "stackTrace") {
        return {
          response: {
            stackFrames: [
              {
                id: 10,
                name: "add",
                line: 4,
                column: 1,
                source: { path: "sample.cpp" },
              },
              { id: 11, name: "main", line: 11, column: 1 },
            ],
          },
        };
      }
      if (req.command === "scopes") {
        return {
          response: {
            scopes: [{ name: "Locals", variablesReference: 99, expensive: false }],
          },
        };
      }
      if (req.command === "variables") {
        return {
          response: {
            variables: [
              { name: "a", value: "40", variablesReference: 0 },
              { name: "b", value: "2", variablesReference: 0 },
              { name: "sum", value: "42", variablesReference: 0 },
            ],
          },
        };
      }
      if (req.command === "evaluate") {
        hoverArgs = req.arguments;
        return {
          response: {
            result: "42",
            type: "int",
            variablesReference: 0,
          },
        };
      }
      return {};
    });

    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "fake",
      program: "sample.exe",
      breakpoints: [{ path: "sample.cpp", line: 4 }],
    });
    assert.equal(session.stopped?.reason, "breakpoint");
    const stack = await session.stack();
    assert.deepEqual(
      stack.map((f) => f.name),
      ["add", "main"],
    );
    const locals = await session.locals();
    const byName = Object.fromEntries(locals.map((v) => [v.name, v.value]));
    assert.equal(byName.a, "40");
    assert.equal(byName.b, "2");
    assert.equal(byName.sum, "42");
    assert.deepEqual(await session.variables(99), locals);
    assert.deepEqual(await session.evaluateHover("sum", 10), {
      result: "42",
      type: "int",
      variablesReference: 0,
    });
    assert.deepEqual(hoverArgs, {
      expression: "sum",
      frameId: 10,
      context: "hover",
    });
    session.client.dispose();
  });

  it("forwards breakpoint conditions on setBreakpoints", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let args: unknown;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "setBreakpoints") {
        args = req.arguments;
        return { response: { breakpoints: [{ verified: true, line: 4 }] } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.replaceBreakpoints("sample.cpp", [
      { line: 4, condition: "a == 40" },
      { line: 11, condition: "  " },
    ]);
    assert.deepEqual(args, {
      source: { path: "sample.cpp" },
      breakpoints: [{ line: 4, condition: "a == 40" }, { line: 11 }],
    });
    session.client.dispose();
  });

  it("reads lldb-dap errors from body.error.format", () => {
    assert.equal(
      formatDapFailure("configurationDone", {
        type: "response",
        seq: 1,
        request_seq: 3,
        success: false,
        command: "configurationDone",
        body: {
          error: {
            format: "Expected process to be stopped.",
            showUser: true,
          },
        },
      }),
      "Expected process to be stopped.",
    );
  });

  it("detects lldb-dap notStopped failures", () => {
    assert.equal(
      isDapNotStopped(new Error("notStopped")),
      true,
    );
    assert.equal(isDapNotStopped(new Error("DAP pause timed out")), false);
  });

  it("launches with internalConsole and an empty configurationDone body", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let launchArgs: unknown;
    let configArgs: unknown;
    let continued = false;
    let launchSeq = 0;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "launch") {
        launchSeq = req.seq;
        launchArgs = req.arguments;
        return { skipResponse: true, events: [{ event: "initialized" }] };
      }
      if (req.command === "configurationDone") {
        configArgs = req.arguments;
        return {
          extraResponses: [{ request_seq: launchSeq, command: "launch" }],
        };
      }
      if (req.command === "threads") {
        return { response: { threads: [{ id: 7, name: "main" }] } };
      }
      if (req.command === "continue") {
        continued = true;
        assert.equal((req.arguments as { threadId?: number }).threadId, 7);
        return { response: { allThreadsContinued: true } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "fake",
      program: "sample.exe",
      breakpoints: [],
      waitForStop: false,
    });
    assert.equal((launchArgs as { console?: string }).console, "internalConsole");
    assert.equal((launchArgs as { disableSTDIO?: boolean }).disableSTDIO, false);
    assert.deepEqual(configArgs, {});
    assert.equal(continued, true);
    session.client.dispose();
  });

  it("does not auto-continue a user breakpoint after launch", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let continued = false;
    let launchSeq = 0;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "launch") {
        launchSeq = req.seq;
        return { skipResponse: true, events: [{ event: "initialized" }] };
      }
      if (req.command === "configurationDone") {
        return {
          extraResponses: [{ request_seq: launchSeq, command: "launch" }],
          events: [
            {
              event: "stopped",
              body: { reason: "breakpoint", threadId: 1, hitBreakpointIds: [4] },
            },
          ],
        };
      }
      if (req.command === "continue") {
        continued = true;
        return { response: { allThreadsContinued: true } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "fake",
      program: "sample.exe",
      breakpoints: [{ path: "sample.cpp", line: 4 }],
      waitForStop: false,
    });
    assert.equal(session.stopped?.reason, "breakpoint");
    assert.equal(continued, false);
    session.client.dispose();
  });

  it("attaches by pid instead of DAP launch", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let startCmd = "";
    let startArgs:
      | {
          pid?: number;
          attachCommands?: string[];
          stopOnEntry?: boolean;
        }
      | undefined;
    let attachSeq = 0;
    const expressions: string[] = [];
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "attach") {
        attachSeq = req.seq;
        startCmd = req.command;
        startArgs = req.arguments as {
          pid?: number;
          attachCommands?: string[];
          stopOnEntry?: boolean;
        };
        return { skipResponse: true, events: [{ event: "initialized" }] };
      }
      if (req.command === "evaluate") {
        expressions.push(
          String((req.arguments as { expression?: string }).expression ?? ""),
        );
        return {
          response: {
            result:
              (req.arguments as { expression?: string }).expression ===
              "process status"
                ? "Process 4242 state = running"
                : "ok",
          },
        };
      }
      if (req.command === "configurationDone") {
        return { extraResponses: [{ request_seq: attachSeq, command: "attach" }] };
      }
      if (req.command === "threads") {
        return { response: { threads: [{ id: 1, name: "main" }] } };
      }
      if (req.command === "continue") {
        return { response: { allThreadsContinued: true } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "fake",
      program: "UnrealEditor.exe",
      attachPid: 4242,
      breakpoints: [],
      waitForStop: false,
    });
    assert.equal(startCmd, "attach");
    assert.equal(startArgs?.pid, 4242);
    assert.equal(startArgs?.stopOnEntry, false);
    assert.equal(startArgs?.attachCommands, undefined);
    assert.ok(expressions.some((expr) => expr === "process status"));
    session.client.dispose();
  });

  it("resumes after attach even when Windows reports loader breakpoint ids", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let continued = false;
    let singleThread: boolean | undefined;
    let attachSeq = 0;
    const expressions: string[] = [];
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "attach") {
        attachSeq = req.seq;
        return { skipResponse: true, events: [{ event: "initialized" }] };
      }
      if (req.command === "evaluate") {
        const expression = String(
          (req.arguments as { expression?: string }).expression ?? "",
        );
        expressions.push(expression);
        return {
          response: {
            result:
              expression === "process status"
                ? "Process 4242 state = running"
                : "ok",
          },
        };
      }
      if (req.command === "configurationDone") {
        return {
          extraResponses: [{ request_seq: attachSeq, command: "attach" }],
          events: [
            {
              event: "stopped",
              body: {
                reason: "breakpoint",
                threadId: 1,
                allThreadsStopped: true,
                hitBreakpointIds: [1],
              },
            },
          ],
        };
      }
      if (req.command === "threads") {
        return { response: { threads: [{ id: 1, name: "main" }] } };
      }
      if (req.command === "continue") {
        continued = true;
        singleThread = (req.arguments as { singleThread?: boolean }).singleThread;
        return { response: { allThreadsContinued: true } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "fake",
      program: "UnrealEditor.exe",
      attachPid: 4242,
      breakpoints: [{ path: "Foo.cpp", line: 12 }],
      waitForStop: false,
    });
    assert.equal(continued, true);
    assert.equal(singleThread, false);
    assert.equal(session.stopped, null);
    assert.ok(expressions.some((expr) => expr === "process continue"));
    session.client.dispose();
  });

  it("detaches when attach leaves the process suspended", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let attachSeq = 0;
    const expressions: string[] = [];
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "attach") {
        attachSeq = req.seq;
        return { skipResponse: true, events: [{ event: "initialized" }] };
      }
      if (req.command === "evaluate") {
        const expression = String(
          (req.arguments as { expression?: string }).expression ?? "",
        );
        expressions.push(expression);
        return {
          response: {
            result:
              expression === "process status"
                ? "Process 4242 state = stopped"
                : "ok",
          },
        };
      }
      if (req.command === "configurationDone") {
        return { extraResponses: [{ request_seq: attachSeq, command: "attach" }] };
      }
      if (req.command === "threads") {
        return { response: { threads: [{ id: 1, name: "main" }] } };
      }
      if (req.command === "continue") {
        return { response: { allThreadsContinued: true } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await assert.rejects(
      () =>
        session.configureAndLaunch({
          adapterPath: "fake",
          program: "UnrealEditor.exe",
          attachPid: 4242,
          breakpoints: [],
          waitForStop: false,
        }),
      /stayed suspended/,
    );
    assert.ok(expressions.some((expr) => expr === "process detach --keep-stopped false"));
    session.client.dispose();
  });

  it("attaches lldb with on-demand symbols and --shlib breakpoints", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let startArgs:
      | {
          pid?: number;
          program?: string;
          initCommands?: string[];
          attachCommands?: string[];
          pdbModuleAllowlist?: string[];
        }
      | undefined;
    let attachSeq = 0;
    const expressions: string[] = [];
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "attach") {
        attachSeq = req.seq;
        startArgs = req.arguments as {
          pid?: number;
          program?: string;
          initCommands?: string[];
          attachCommands?: string[];
          pdbModuleAllowlist?: string[];
        };
        return { skipResponse: true, events: [{ event: "initialized" }] };
      }
      if (req.command === "evaluate") {
        const expression = String(
          (req.arguments as { expression?: string }).expression ?? "",
        );
        expressions.push(expression);
        return {
          response: {
            result:
              expression === "process status"
                ? "Process 4242 state = running"
                : "ok",
          },
        };
      }
      if (req.command === "setBreakpoints") {
        throw new Error("file:line with shlibs must not use DAP setBreakpoints");
      }
      if (req.command === "configurationDone") {
        return { extraResponses: [{ request_seq: attachSeq, command: "attach" }] };
      }
      if (req.command === "threads") {
        return { response: { threads: [{ id: 1, name: "main" }] } };
      }
      if (req.command === "continue") {
        return { response: { allThreadsContinued: true } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "lldb-dap",
      program: "UnrealEditor.exe",
      attachPid: 4242,
      shlibs: ["UnrealEditor-NF-Win64-DebugGame.dll"],
      pdbModuleAllowlist: ["UnrealEditor-NF-Win64-DebugGame.dll"],
      breakpoints: [
        { path: "E:/game/Source/Foo.cpp", line: 12, condition: "x > 0" },
      ],
      waitForStop: false,
    });
    assert.equal(startArgs?.pid, 4242);
    assert.equal(startArgs?.program, undefined);
    assert.equal(startArgs?.attachCommands, undefined);
    assert.deepEqual(startArgs?.pdbModuleAllowlist, [
      "UnrealEditor-NF-Win64-DebugGame.dll",
    ]);
    assert.ok(
      startArgs?.initCommands?.some((cmd) =>
        cmd.includes("symbols.load-on-demand true"),
      ),
    );
    // Breakpoints are applied after attach confirms running.
    await session.replaceBreakpoints("E:/game/Source/Foo.cpp", [
      { line: 12, condition: "x > 0" },
    ]);
    assert.ok(expressions.some((expr) => expr.includes("breakpoint delete --force")));
    assert.ok(
      expressions.some(
        (expr) =>
          expr.includes("--file") &&
          expr.includes("Foo.cpp") &&
          expr.includes("--line 12") &&
          expr.includes("--shlib") &&
          expr.includes("UnrealEditor-NF-Win64-DebugGame.dll") &&
          expr.includes("--condition"),
      ),
    );
    session.client.dispose();
  });

  it("loads only the selected frame module PDB on demand", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    const requests: Array<{ command: string; arguments?: unknown }> = [];
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      requests.push({ command: req.command, arguments: req.arguments });
      if (req.command === "larry/loadModuleSymbols") {
        return {
          response: {
            moduleName: "UnrealEditor-Core.dll",
            loaded: true,
            alreadyLoaded: false,
            symbolStatus: "Symbols loaded.",
            symbolFilePath:
              "E:/UE/Engine/Binaries/Win64/UnrealEditor-Core.pdb",
          },
        };
      }
      if (req.command === "evaluate") {
        return { response: { result: "should not run REPL commands" } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    try {
      assert.equal(
        await session.loadSymbolsForFrame({
          id: 7,
          name: "UnrealEditor-Core!FMemory::Malloc",
          moduleId: "core",
          line: 0,
          column: 0,
        }),
        true,
      );
      const load = requests.find(
        (req) => req.command === "larry/loadModuleSymbols",
      );
      assert.deepEqual(load?.arguments, {
        frameId: 7,
        moduleId: "core",
        moduleName: "UnrealEditor-Core",
      });
      assert.equal(
        requests.some((req) => req.command === "evaluate"),
        false,
      );
      assert.equal(
        requests.some((req) => req.command === "modules"),
        false,
      );
      // A second click must not reload: LLDB never frees the previous PDB.
      assert.equal(
        await session.loadSymbolsForFrame({
          id: 7,
          name: "UnrealEditor-Core!FMemory::Malloc",
          moduleId: "core",
          line: 0,
          column: 0,
        }),
        true,
      );
      assert.equal(
        requests.filter((req) => req.command === "larry/loadModuleSymbols")
          .length,
        1,
      );
    } finally {
      session.client.dispose();
    }
  });

  it("loads symbols for a disassembly frame that only names its module", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let args: unknown;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "larry/loadModuleSymbols") {
        args = req.arguments;
        return {
          response: {
            moduleName: "UnrealEditor-Core.dll",
            loaded: true,
            alreadyLoaded: false,
            symbolStatus: "Symbols loaded.",
          },
        };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    try {
      // What lldb-dap actually answers once the allowlist skipped the PDB: a
      // disassembly source whose path is the module, with a real line number.
      assert.equal(
        await session.loadSymbolsForFrame({
          id: 7,
          name: "FMemory::Malloc",
          line: 42,
          column: 1,
          source: {
            name: "UnrealEditor-Core.dll`FMemory::Malloc",
            path: "E:/UE/Engine/Binaries/Win64/UnrealEditor-Core.dll",
            sourceReference: 1234,
          },
        }),
        true,
      );
      assert.deepEqual(args, {
        frameId: 7,
        moduleName: "UnrealEditor-Core.dll",
      });
    } finally {
      session.client.dispose();
    }
  });

  it("reports the adapter error when symbols stay missing", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "larry/loadModuleSymbols") {
        return {
          response: {
            moduleName: "UnrealEditor-Core.dll",
            loaded: false,
            alreadyLoaded: false,
            symbolStatus: "error: does not match any existing module",
          },
        };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    try {
      await assert.rejects(
        session.loadSymbolsForFrame({
          id: 7,
          name: "UnrealEditor-Core.dll`FMemory::Malloc",
          line: 0,
          column: 0,
        }),
        /does not match any existing module/,
      );
    } finally {
      session.client.dispose();
    }
  });

  it("fills the Debug Console with target output, not protocol traffic", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let launchSeq = 0;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "launch") {
        launchSeq = req.seq;
        return {
          skipResponse: true,
          events: [
            { event: "initialized" },
            {
              event: "output",
              body: { category: "stdout", output: "LogInit: Engine ready\n" },
            },
            {
              event: "output",
              body: { category: "stderr", output: "LogCore: Error: bad asset" },
            },
            // Unreal attach reports thousands of these; none belong here.
            {
              event: "module",
              body: { reason: "new", module: { id: "1", name: "Core.dll" } },
            },
          ],
        };
      }
      if (req.command === "configurationDone") {
        return {
          extraResponses: [{ request_seq: launchSeq, command: "launch" }],
        };
      }
      if (req.command === "threads") {
        return { response: { threads: [{ id: 1, name: "main" }] } };
      }
      return {};
    });

    const console: Array<{ direction: string; text: string }> = [];
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "fake",
      program: "UnrealEditor.exe",
      breakpoints: [],
      waitForStop: false,
      onConsole: (entry) =>
        console.push({ direction: entry.direction, text: entry.text }),
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(
      console.find((row) => row.text.includes("Engine ready")),
      { direction: "receive", text: "LogInit: Engine ready" },
    );
    assert.deepEqual(
      console.find((row) => row.text.includes("bad asset")),
      { direction: "error", text: "LogCore: Error: bad asset" },
    );
    assert.equal(
      console.some((row) => /Core\.dll|"type":|request |response /.test(row.text)),
      false,
      "module events and wire dumps must not reach the console",
    );
    session.client.dispose();
  });

  it("echoes debugger commands and their results", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    let attachSeq = 0;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "attach") {
        attachSeq = req.seq;
        return { skipResponse: true, events: [{ event: "initialized" }] };
      }
      if (req.command === "configurationDone") {
        return { extraResponses: [{ request_seq: attachSeq, command: "attach" }] };
      }
      if (req.command === "threads") {
        return { response: { threads: [{ id: 1, name: "main" }] } };
      }
      if (req.command === "evaluate") {
        const expression = String(
          (req.arguments as { expression?: string }).expression ?? "",
        );
        if (expression === "process status") {
          return { response: { result: "Process 7 state = running" } };
        }
        if (expression.startsWith("breakpoint set")) {
          return {
            response: {
              result: "Breakpoint 1: where = NF.dll`AFoo::Tick + 32\n",
            },
          };
        }
        return { response: { result: "" } };
      }
      return {};
    });

    const console: Array<{ direction: string; text: string }> = [];
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "fake",
      program: "UnrealEditor.exe",
      attachPid: 7,
      breakpoints: [],
      waitForStop: false,
      shlibs: ["NF.dll"],
      onConsole: (entry) =>
        console.push({ direction: entry.direction, text: entry.text }),
    });
    console.length = 0;

    await session.replaceBreakpoints("E:/game/Source/Foo.cpp", [{ line: 12 }]);
    assert.ok(
      console.some(
        (row) => row.direction === "send" && row.text.startsWith("breakpoint set"),
      ),
      "the command the debugger ran is echoed",
    );
    assert.ok(
      console.some(
        (row) =>
          row.direction === "receive" && row.text.includes("Breakpoint 1: where"),
      ),
      "the debugger's answer is shown",
    );
    // The resume poll repeats several times a second — it must stay silent.
    assert.equal(
      console.some((row) => row.text === "process continue"),
      false,
    );
    session.client.dispose();
  });
});

describe("breakpoint hit attribution", () => {
  async function attached(): Promise<DebugSession> {
    const { client, toAdapter, fromAdapter } = pair();
    let attachSeq = 0;
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      if (req.command === "attach") {
        attachSeq = req.seq;
        return { skipResponse: true, events: [{ event: "initialized" }] };
      }
      if (req.command === "configurationDone") {
        return { extraResponses: [{ request_seq: attachSeq, command: "attach" }] };
      }
      if (req.command === "threads") {
        return { response: { threads: [{ id: 1, name: "main" }] } };
      }
      if (req.command === "evaluate") {
        const expression = String(
          (req.arguments as { expression?: string }).expression ?? "",
        );
        if (expression === "process status") {
          return { response: { result: "Process 7 state = running" } };
        }
        if (expression.startsWith("breakpoint set")) {
          return {
            response: {
              result:
                "Breakpoint 4: where = NF.dll`AFoo::Tick + 32 at Foo.cpp:12:5, address = 0x7ffd",
            },
          };
        }
        return { response: { result: "" } };
      }
      return {};
    });
    const session = DebugSession.fromClient(client);
    await session.configureAndLaunch({
      adapterPath: "fake",
      program: "UnrealEditor.exe",
      attachPid: 7,
      breakpoints: [],
      waitForStop: false,
      shlibs: ["NF.dll"],
    });
    return session;
  }

  it("claims a hit on a breakpoint planted after attach", async () => {
    const session = await attached();
    // The editor toggled this one once Unreal was already running — the old
    // path-set was captured at attach time and never saw it.
    await session.replaceBreakpoints("E:/game/Source/Foo.cpp", [{ line: 12 }]);
    assert.equal(
      session.isOwnBreakpointStop({ reason: "breakpoint", hitBreakpointIds: [4] }),
      true,
    );
    session.client.dispose();
  });

  it("ignores stops from breakpoints it did not plant", async () => {
    const session = await attached();
    await session.replaceBreakpoints("E:/game/Source/Foo.cpp", [{ line: 12 }]);
    assert.equal(
      session.isOwnBreakpointStop({ reason: "breakpoint", hitBreakpointIds: [99] }),
      false,
    );
    assert.equal(session.isOwnBreakpointStop({ reason: "exception" }), false);
    session.client.dispose();
  });

  it("forgets ids that were deleted", async () => {
    const session = await attached();
    await session.replaceBreakpoints("E:/game/Source/Foo.cpp", [{ line: 12 }]);
    await session.replaceBreakpoints("E:/game/Source/Foo.cpp", []);
    assert.equal(
      session.isOwnBreakpointStop({ reason: "breakpoint", hitBreakpointIds: [4] }),
      false,
    );
    session.client.dispose();
  });

  it("reads LLDB breakpoint results", () => {
    assert.equal(
      parseLldbBreakpointId(
        "Breakpoint 4: where = NF.dll`AFoo::Tick + 32 at Foo.cpp:12:5",
      ),
      4,
    );
    assert.equal(parseLldbBreakpointId("Breakpoint 2: 3 locations."), 2);
    assert.equal(parseLldbBreakpointId("error: invalid command"), null);
    assert.equal(
      isUnresolvedBreakpointResult("Breakpoint 3: no locations (pending)."),
      true,
    );
    assert.equal(
      isUnresolvedBreakpointResult("Breakpoint 4: where = NF.dll`AFoo::Tick"),
      false,
    );
  });
});

describe("parseLldbStringList", () => {
  it("reads the values of an array setting", () => {
    assert.deepEqual(
      parseLldbStringList(
        [
          "target.pdb-module-allowlist (array of strings) =",
          '  [0]: "UnrealEditor-NF-Win64-DebugGame.dll"',
          '  [1]: "UnrealEditor-Core.dll"',
        ].join("\n"),
      ),
      ["UnrealEditor-NF-Win64-DebugGame.dll", "UnrealEditor-Core.dll"],
    );
  });

  it("reads an empty list", () => {
    assert.deepEqual(
      parseLldbStringList("target.pdb-module-allowlist (array of strings) ="),
      [],
    );
  });
});

describe("buildShlibBreakpointCommand", () => {
  it("scopes file:line to game modules and quotes a condition", () => {
    const cmd = buildShlibBreakpointCommand({
      file: "Foo.cpp",
      line: 12,
      shlibs: ["UnrealEditor-NF-Win64-DebugGame.dll"],
      condition: "x > 0",
    });
    assert.match(cmd, /^breakpoint set --file "Foo.cpp" --line 12 --shlib "/);
    assert.ok(cmd.includes("UnrealEditor-NF-Win64-DebugGame.dll"));
    assert.ok(cmd.includes('--condition "x > 0"'));
  });
});

describe("DapClient reverse requests", () => {
  it("answers startDebugging from the adapter", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    const seen: string[] = [];
    client.setReverseRequestHandler(async (req) => {
      seen.push(req.command);
      return { ok: true };
    });
    fromAdapter.write(
      encodeDapMessage({
        type: "request",
        seq: 42,
        command: "startDebugging",
        arguments: { request: "attach" },
      }),
    );
    const chunk = await new Promise<Buffer>((resolve) => {
      toAdapter.once("data", resolve);
    });
    const messages = new DapFramer().feed(chunk);
    const reply = messages[0];
    assert.equal(reply?.type, "response");
    if (reply?.type === "response") {
      assert.equal(reply.command, "startDebugging");
      assert.equal(reply.request_seq, 42);
      assert.equal(reply.success, true);
    }
    assert.deepEqual(seen, ["startDebugging"]);
    client.dispose();
  });
});

describe("resumeFromStop", () => {
  it("resumes a foreign stop with one continue on the stopped thread", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    const commands: Array<{ command: string; arguments?: unknown }> = [];
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      commands.push({ command: req.command, arguments: req.arguments });
      return { response: {} };
    });
    const session = DebugSession.fromClient(client);
    await session.resumeFromStop({ reason: "exception", threadId: 17 });
    assert.deepEqual(commands, [
      { command: "continue", arguments: { threadId: 17, singleThread: false } },
    ]);
    session.client.dispose();
  });

  it("falls back to the full resume when the stop has no thread", async () => {
    const { client, toAdapter, fromAdapter } = pair();
    const commands: string[] = [];
    attachFakeAdapter(toAdapter, fromAdapter, (req) => {
      commands.push(req.command);
      if (req.command === "threads") {
        return { response: { threads: [{ id: 1, name: "main" }] } };
      }
      return { response: {} };
    });
    const session = DebugSession.fromClient(client);
    await session.resumeFromStop({ reason: "exception" });
    assert.deepEqual(commands, ["evaluate", "threads", "continue"]);
    session.client.dispose();
  });
});
