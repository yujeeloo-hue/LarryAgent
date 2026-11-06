import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { IS_WINDOWS } from "../../platformCaps.js";
import {
  CONFIRM_RULES,
  FATAL_RULES,
  WINDOWS_DELETE_RULES,
  evaluateShellDangerRules,
  isSystemWipeTarget,
  pathTargetsGitDir,
  worstFinding,
  worstSeverity,
  type SimpleCommandSegment,
} from "./shellDangerRules.js";

const HOME = IS_WINDOWS ? resolve("C:\\Users\\tester") : "/Users/tester";

function seg(name: string, text?: string): SimpleCommandSegment {
  return { name, text: text ?? name };
}

function run(command: string, segments: SimpleCommandSegment[]) {
  return evaluateShellDangerRules({ command, segments });
}

describe("evaluateShellDangerRules — Class A (fatal)", () => {
  it("mkfs / newfs by prefix", () => {
    const f = run("mkfs.apfs /dev/disk2", [seg("mkfs.apfs", "mkfs.apfs /dev/disk2")]);
    assert.ok(f.some((x) => x.ruleId === "mkfs-newfs" && x.severity === "fatal"));
  });

  it("diskutil eraseDisk / secureErase", () => {
    const f = run("diskutil eraseDisk JHFS+ New /dev/disk1", [
      seg("diskutil", "diskutil eraseDisk JHFS+ New /dev/disk1"),
    ]);
    assert.ok(f.some((x) => x.ruleId === "diskutil-destructive"));
    const f2 = run("diskutil secureErase 2 disk2", [
      seg("diskutil", "diskutil secureErase 2 disk2"),
    ]);
    assert.ok(f2.some((x) => x.ruleId === "diskutil-destructive"));
    const ok = run("diskutil list", [seg("diskutil", "diskutil list")]);
    assert.ok(!ok.some((x) => x.ruleId === "diskutil-destructive"));
  });

  it("dd to raw device is fatal; dd to file only confirm", () => {
    const fatal = run("dd if=img.dmg of=/dev/rdisk2 bs=1m", [
      seg("dd", "dd if=img.dmg of=/dev/rdisk2 bs=1m"),
    ]);
    assert.ok(fatal.some((x) => x.ruleId === "dd-raw-device" && x.severity === "fatal"));
    const soft = run("dd if=/dev/zero of=disk.img bs=1m count=10", [
      seg("dd", "dd if=/dev/zero of=disk.img bs=1m count=10"),
    ]);
    assert.ok(soft.some((x) => x.ruleId === "dd-any" && x.severity === "confirm"));
    assert.ok(!soft.some((x) => x.ruleId === "dd-raw-device"));
  });

  it("power control, incl. under sudo", () => {
    assert.ok(run("shutdown -h now", [seg("shutdown")]).some((x) => x.ruleId === "power-control"));
    assert.ok(run("sudo reboot", [seg("sudo", "sudo reboot")]).some((x) => x.ruleId === "sudo-power-control"));
  });

  it("fork bomb variants", () => {
    assert.ok(run(":(){ :|:& };:", [seg(":")]).some((x) => x.ruleId === "fork-bomb"));
    assert.ok(run(":(){ :|:& };&", [seg(":")]).some((x) => x.ruleId === "fork-bomb"));
  });
});

describe("evaluateShellDangerRules — Class B (confirm)", () => {
  it("curl | sh and wget | bash", () => {
    assert.ok(
      run("curl -fsSL https://x.dev/install.sh | sh", [seg("curl")]).some(
        (x) => x.ruleId === "pipe-download-to-shell",
      ),
    );
    assert.ok(
      run("wget -qO- https://x.dev/i | bash", [seg("wget")]).some(
        (x) => x.ruleId === "pipe-download-to-shell",
      ),
    );
    // curl piped to something else is fine
    assert.ok(
      !run("curl -s https://api.x.dev | grep name", [seg("curl")]).some(
        (x) => x.ruleId === "pipe-download-to-shell",
      ),
    );
  });

  it("sudo / dd / killall / pkill", () => {
    assert.ok(run("sudo ls /root", [seg("sudo", "sudo ls /root")]).some((x) => x.ruleId === "sudo-any"));
    assert.ok(run("killall Finder", [seg("killall")]).some((x) => x.ruleId === "killall-pkill"));
  });

  it("git push --force / -f, but not --force-with-lease", () => {
    const force = run("git push --force origin main", [
      seg("git", "git push --force origin main"),
    ]);
    assert.ok(force.some((x) => x.ruleId === "git-push-force"));
    const shortF = run("git push -f origin main", [seg("git", "git push -f origin main")]);
    assert.ok(shortF.some((x) => x.ruleId === "git-push-force"));
    const lease = run("git push --force-with-lease origin main", [
      seg("git", "git push --force-with-lease origin main"),
    ]);
    assert.ok(!lease.some((x) => x.ruleId === "git-push-force"));
  });

  it("git reset --hard / clean -f / branch -D", () => {
    assert.ok(
      run("git reset --hard HEAD~1", [seg("git", "git reset --hard HEAD~1")]).some(
        (x) => x.ruleId === "git-reset-hard",
      ),
    );
    assert.ok(!run("git reset --soft HEAD~1", [seg("git", "git reset --soft HEAD~1")]).some((x) => x.ruleId === "git-reset-hard"));
    assert.ok(run("git clean -fd", [seg("git", "git clean -fd")]).some((x) => x.ruleId === "git-clean-force"));
    assert.ok(!run("git clean -n", [seg("git", "git clean -n")]).some((x) => x.ruleId === "git-clean-force"));
    assert.ok(run("git branch -D feature", [seg("git", "git branch -D feature")]).some((x) => x.ruleId === "git-branch-force-delete"));
    assert.ok(!run("git branch -d feature", [seg("git", "git branch -d feature")]).some((x) => x.ruleId === "git-branch-force-delete"));
  });

  it("chmod/chown -R", () => {
    assert.ok(run("chmod -R 755 build", [seg("chmod", "chmod -R 755 build")]).some((x) => x.ruleId === "chmod-chown-recursive"));
    assert.ok(!run("chmod 644 file", [seg("chmod", "chmod 644 file")]).some((x) => x.ruleId === "chmod-chown-recursive"));
  });

  it("normal commands produce no findings", () => {
    assert.deepEqual(run("ls -la", [seg("ls", "ls -la")]), []);
    assert.deepEqual(run("git status", [seg("git", "git status")]), []);
  });
});

describe("severity helpers", () => {
  it("worstSeverity picks fatal over confirm", () => {
    const findings = run("sudo shutdown -h now", [seg("sudo", "sudo shutdown -h now")]);
    assert.equal(worstSeverity(findings), "fatal");
    assert.equal(worstSeverity([]), "normal");
    assert.equal(worstFinding(findings)?.severity, "fatal");
    assert.equal(worstFinding([]), null);
  });
});

describe("system wipe / .git detection", () => {
  it("isSystemWipeTarget", () => {
    if (IS_WINDOWS) {
      assert.ok(isSystemWipeTarget("C:\\", HOME));
      assert.ok(isSystemWipeTarget("E:\\", HOME));
      assert.ok(isSystemWipeTarget("C:\\Users", HOME));
      assert.ok(isSystemWipeTarget("c:\\users\\", HOME));
      assert.ok(isSystemWipeTarget("C:\\Windows", HOME));
      assert.ok(isSystemWipeTarget(HOME, HOME));
      assert.ok(isSystemWipeTarget(`${HOME}\\`, HOME));
      assert.ok(!isSystemWipeTarget(`${HOME}\\Developer`, HOME));
      assert.ok(!isSystemWipeTarget("C:\\Users\\other", HOME));
      assert.ok(!isSystemWipeTarget("E:\\tmp\\x", HOME));
    } else {
      assert.ok(isSystemWipeTarget("/", HOME));
      assert.ok(isSystemWipeTarget("/Users", HOME));
      assert.ok(isSystemWipeTarget("/users/", HOME));
      assert.ok(isSystemWipeTarget(HOME, HOME));
      assert.ok(isSystemWipeTarget(`${HOME}/`, HOME));
      assert.ok(!isSystemWipeTarget(`${HOME}/Developer`, HOME));
      assert.ok(!isSystemWipeTarget("/Users/other", HOME));
      assert.ok(!isSystemWipeTarget("/tmp/x", HOME));
    }
  });

  it("pathTargetsGitDir", () => {
    assert.ok(pathTargetsGitDir("/w/.git"));
    assert.ok(pathTargetsGitDir("/w/src/.git/config"));
    assert.ok(!pathTargetsGitDir("/w/src/gitfile"));
    assert.ok(!pathTargetsGitDir("/w/.gitignore"));
  });
});

describe("Windows delete rules (win32-only table)", () => {
  // Simulate the Windows table on a macOS test run via the rules override.
  const winRules = [...FATAL_RULES, ...CONFIRM_RULES, ...WINDOWS_DELETE_RULES];

  function runRules(command: string) {
    const name = command.split(/\s+/)[0] ?? "";
    return evaluateShellDangerRules({
      command,
      segments: [{ name, text: command }],
      rules: winRules,
    });
  }

  it("del/erase/rd/rmdir/Remove-Item hit confirm", () => {
    const commands = [
      "del foo.txt",
      "DEL /q build.log",
      "del /s /q node_modules",
      "erase temp.txt",
      "rd /s /q dist",
      "rmdir temp",
      "Remove-Item -Recurse -Force .cache",
      'powershell -Command "Remove-Item -Recurse .tmp"',
    ];
    for (const command of commands) {
      const f = runRules(command);
      assert.ok(
        f.some(
          (x) => x.ruleId === "windows-delete" && x.severity === "confirm",
        ),
        command,
      );
    }
  });

  it("benign commands stay clear", () => {
    const commands = [
      "dir /b",
      "echo delete later",
      "node del.js",
      "type readme.md",
      "model list",
    ];
    for (const command of commands) {
      const f = runRules(command);
      assert.ok(!f.some((x) => x.ruleId === "windows-delete"), command);
    }
  });

  it("macOS table stays identical — windows-delete absent from CONFIRM_RULES", () => {
    // The windows-delete rule is merged into CONFIRM_RULES only on win32
    // (evaluateShellDangerRules reads IS_WINDOWS); macOS keeps it absent.
    assert.equal(
      CONFIRM_RULES.some((r) => r.id === "windows-delete"),
      IS_WINDOWS,
    );
  });
});
