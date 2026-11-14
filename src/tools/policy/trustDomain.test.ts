import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { IS_WINDOWS } from "../../platformCaps.js";
import {
  classifyPathTarget,
  isSensitivePath,
  isWithin,
} from "./trustDomain.js";

const HOME = resolve("/Users/tester");
const WS = resolve("/Users/tester/Developer/JellyBot");

describe("isWithin", () => {
  it("boundary-aware containment", () => {
    assert.ok(isWithin("/Users/a", "/Users/a"));
    assert.ok(isWithin("/Users/a", "/Users/a/b/c.txt"));
    assert.ok(!isWithin("/Users/a", "/Users/ab/c.txt"));
    assert.ok(!isWithin("/Users/a/b", "/Users/a"));
  });
});

describe("isSensitivePath", () => {
  it("home root and credential trees", () => {
    assert.ok(isSensitivePath(HOME, HOME));
    assert.ok(isSensitivePath(`${HOME}/.ssh/config`, HOME));
    assert.ok(isSensitivePath(`${HOME}/.ssh`, HOME));
    assert.ok(isSensitivePath(`${HOME}/.gnupg/pubring.kbx`, HOME));
    assert.ok(isSensitivePath(`${HOME}/.config/jellybot/tools.json`, HOME));
  });

  it("shell rc files and Library", () => {
    assert.ok(isSensitivePath(`${HOME}/.zshrc`, HOME));
    assert.ok(isSensitivePath(`${HOME}/.bash_profile`, HOME));
    assert.ok(isSensitivePath(`${HOME}/Library/Preferences/x.plist`, HOME));
  });

  it("system absolute prefixes", () => {
    if (IS_WINDOWS) {
      assert.ok(isSensitivePath("C:\\Windows\\System32\\drivers\\etc\\hosts", HOME));
      assert.ok(isSensitivePath("C:\\Program Files\\Vendor\\app.exe", HOME));
      assert.ok(isSensitivePath("C:\\ProgramData\\Vendor\\secrets.json", HOME));
      assert.ok(isSensitivePath("E:\\Users\\other\\.ssh\\id_rsa", HOME));
      assert.ok(!isSensitivePath("E:\\tools\\work\\notes.txt", HOME));
    } else {
      assert.ok(isSensitivePath("/etc/hosts", HOME));
      assert.ok(isSensitivePath("/System/Library/Kernels/x", HOME));
      assert.ok(isSensitivePath("/Library/Fonts/A.ttf", HOME));
      assert.ok(isSensitivePath("/usr/bin/git", HOME));
      assert.ok(isSensitivePath("/private/etc/sudoers", HOME));
    }
  });

  it("ordinary paths are not sensitive", () => {
    assert.ok(!isSensitivePath(`${HOME}/Developer/proj/src/main.ts`, HOME));
    assert.ok(!isSensitivePath("/tmp/build-cache", HOME));
  });

  it("/var is a system prefix (symlink target under /private)", () => {
    if (!IS_WINDOWS) assert.ok(isSensitivePath("/var/tmp/x", HOME));
  });
});

describe("classifyPathTarget", () => {
  it("workspace wins over sensitive naming", () => {
    assert.equal(
      classifyPathTarget({ absolutePath: `${WS}/.ssh/deploy_key`, workspaceRoot: WS, homeDir: HOME }),
      "workspace",
    );
    assert.equal(
      classifyPathTarget({ absolutePath: WS, workspaceRoot: WS, homeDir: HOME }),
      "workspace",
    );
  });

  it("sensitive outside workspace", () => {
    assert.equal(
      classifyPathTarget({ absolutePath: `${HOME}/.ssh/authorized_keys`, workspaceRoot: WS, homeDir: HOME }),
      "sensitive",
    );
    assert.equal(
      classifyPathTarget({
        absolutePath: IS_WINDOWS
          ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
          : "/etc/hosts",
        workspaceRoot: WS,
        homeDir: HOME,
      }),
      "sensitive",
    );
  });

  it("plain outside paths", () => {
    assert.equal(
      classifyPathTarget({ absolutePath: "/tmp/foo.txt", workspaceRoot: WS, homeDir: HOME }),
      "outside",
    );
    assert.equal(
      classifyPathTarget({ absolutePath: `${HOME}/Documents/note.md`, workspaceRoot: WS, homeDir: HOME }),
      "outside",
    );
  });
});
