import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  debugButtonTitle,
  debugColumnTitle,
  debugConsoleContextTitle,
  debugEmptyTargets,
  debugMissingSourceTitle,
  debugPanelContextTitle,
  debugStatusDetail,
} from "./debugCopy.js";
import { shouldStealDebugFocus } from "./debugFocus.js";

describe("debug copy", () => {
  it("titles the Debug button for each recipe", () => {
    assert.match(debugButtonTitle("unreal"), /Unreal Editor/);
    assert.match(debugButtonTitle("electron"), /Electron/);
    assert.doesNotMatch(debugButtonTitle("electron"), /Unreal/);
    assert.match(debugButtonTitle("web"), /Node server and Chrome/);
    assert.doesNotMatch(debugButtonTitle(null), /Unreal Editor/);
  });

  it("renames the left column for Electron sessions", () => {
    assert.equal(debugColumnTitle("unreal"), "Threads");
    assert.equal(debugColumnTitle("electron"), "Sessions");
    assert.equal(debugEmptyTargets("electron"), "No sessions");
    assert.equal(debugColumnTitle("web"), "Sessions");
    assert.equal(debugEmptyTargets("web"), "No sessions");
  });

  it("prefers progressText over Unreal fallbacks", () => {
    assert.equal(
      debugStatusDetail({
        status: "starting",
        recipe: "electron",
        progressText: "Launching Electron…",
      }),
      "Launching Electron…",
    );
    assert.equal(
      debugStatusDetail({ status: "starting", recipe: "unreal" }),
      "Launching Unreal Editor",
    );
    assert.equal(
      debugStatusDetail({ status: "starting", recipe: "web" }),
      "Launching web app",
    );
    assert.equal(
      debugStatusDetail({ status: "starting", recipe: "electron" }),
      "Launching Electron",
    );
    assert.equal(
      debugStatusDetail({ status: "building" }),
      "Building",
    );
    assert.equal(
      debugStatusDetail({ status: "building", recipe: "unreal" }),
      "DebugGame Editor · see the Build tab",
    );
  });

  it("does not keep C++ / DAP copy on Electron workspaces", () => {
    assert.equal(debugPanelContextTitle("electron"), "Electron Debug");
    assert.equal(debugPanelContextTitle("unreal"), "C++ Debug");
    assert.equal(debugPanelContextTitle("web"), "Web Debug");
    assert.equal(debugPanelContextTitle(null), "Debug");
    assert.equal(debugConsoleContextTitle("web"), "Inspector output");
    assert.doesNotMatch(debugPanelContextTitle("electron"), /C\+\+|Unreal/);
    assert.equal(debugConsoleContextTitle("electron"), "Inspector output");
    assert.doesNotMatch(debugConsoleContextTitle("electron"), /DAP|Unreal/);
    assert.equal(debugConsoleContextTitle("unreal"), "Debugger output");
    assert.doesNotMatch(
      debugMissingSourceTitle("electron", "foo", "bar.dll"),
      /load this module's symbols/,
    );
    assert.doesNotMatch(
      debugMissingSourceTitle("web", "foo", "bar.dll"),
      /load this module's symbols/,
    );
    assert.match(
      debugMissingSourceTitle("unreal", "foo", "bar.dll"),
      /bar\.dll · no source yet/,
    );
  });
});

describe("shouldStealDebugFocus", () => {
  it("does not steal focus while the user is paused in another session", () => {
    assert.equal(shouldStealDebugFocus("stopped"), false);
    assert.equal(shouldStealDebugFocus("running"), true);
    assert.equal(shouldStealDebugFocus(undefined), true);
  });
});
