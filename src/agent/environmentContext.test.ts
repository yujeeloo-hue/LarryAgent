import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anyEnvironmentContextEnabled,
  buildEnvironmentContextPrompt,
  type EnvironmentContextInput,
} from "./environmentContext.js";

const base: EnvironmentContextInput = {
  flags: { workspace: true, timezone: true, locale: true, location: true, repository: true },
  workspace: { id: "w1", name: "Demo", path: "/Users/x/Demo" },
  locale: {
    preferredLanguages: ["zh-Hans-CN"],
    systemLocale: "zh-CN",
    appLocale: "en-US",
  },
  now: new Date("2026-09-07T08:00:00Z"),
};

describe("buildEnvironmentContextPrompt — platform hint (Windows v1)", () => {
  it("macOS (darwin) output carries no OS/shell line — byte-stable", () => {
    const out = buildEnvironmentContextPrompt({ ...base, platform: "darwin" });
    assert.ok(out);
    assert.ok(!out.includes("- OS:"));
    assert.ok(!out.includes("cmd.exe"));
    assert.ok(!out.includes("exec_command"));
    // macOS shape: first data line is still the workspace block.
    assert.ok(out.includes("- Workspace: Demo"));
  });

  it("Windows (win32) injects the cmd.exe + exec_command hint", () => {
    const out = buildEnvironmentContextPrompt({ ...base, platform: "win32" });
    assert.ok(out);
    assert.match(out, /^- OS: Windows · shell: cmd\.exe.*$/m);
    assert.match(out, /exec_command/);
  });

  it("flags all off → null even on win32", () => {
    const out = buildEnvironmentContextPrompt({
      ...base,
      platform: "win32",
      flags: {
        workspace: false,
        timezone: false,
        locale: false,
        location: false,
        repository: true,
      },
    });
    assert.equal(out, null);
  });

  it("anyEnvironmentContextEnabled still keys off flags alone", () => {
    assert.equal(
      anyEnvironmentContextEnabled({
        workspace: false,
        timezone: true,
        locale: false,
        location: false,
        repository: false,
      }),
      true,
    );
    assert.equal(
      anyEnvironmentContextEnabled({
        workspace: false,
        timezone: false,
        locale: false,
        location: false,
        repository: true,
      }),
      false,
    );
  });
});
