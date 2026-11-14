import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { analyzeShellCommand } from "./shellSafety.js";

// Platform-native absolute paths so resolve()/trust classification behave
// the same on both shells (zsh vs cmd.exe).
const IS_WIN = process.platform === "win32";
const HOME = IS_WIN ? "C:\\Users\\tester" : "/Users/tester";
const WS = IS_WIN
  ? "C:\\Users\\tester\\Developer\\JellyBot"
  : "/Users/tester/Developer/JellyBot";
const OPTS = { workspacePath: WS, homeDir: HOME };

function analyze(command: string) {
  return analyzeShellCommand(command, OPTS);
}

function ids(command: string): string[] {
  return analyze(command).findings.map((f) => f.ruleId);
}

describe("analyzeShellCommand — normal commands", () => {
  it("read-only commands pass clean", () => {
    assert.equal(analyze("ls -la").riskClass, "normal");
    assert.equal(analyze("git status").riskClass, "normal");
    assert.equal(analyze("grep -r TODO src/").riskClass, "normal");
    assert.equal(analyze('echo "hello world"').riskClass, "normal");
    assert.equal(
      analyze(IS_WIN ? "npm run build 2>nul" : "npm run build 2>/dev/null")
        .riskClass,
      "normal",
    );
    assert.equal(analyze("cat src/main.ts | grep import | wc -l").riskClass, "normal");
  });
});

describe("analyzeShellCommand — rm Trash rewrite", () => {
  it("standalone rm with literal workspace paths rewrites to trash", () => {
    const a = analyze("rm src/main.ts");
    assert.equal(a.riskClass, "normal");
    assert.deepEqual(a.rewrite?.targets, [join(WS, "src/main.ts")]);
    assert.equal(a.rewrite?.force, false);
  });

  it("multiple operands, -rf flags, quoted and ~-free relative paths", () => {
    const a = analyze('rm -rf build "dist folder" ./out');
    assert.equal(a.riskClass, "normal");
    assert.deepEqual(a.rewrite?.targets, [
      join(WS, "build"),
      join(WS, "dist folder"),
      join(WS, "out"),
    ]);
    assert.equal(a.rewrite?.force, true);
  });

  it("absolute workspace paths and $PWD-anchored ones rewrite", () => {
    const a = analyze(`rm ${join(WS, "notes.md")}`);
    assert.deepEqual(a.rewrite?.targets, [join(WS, "notes.md")]);
    const b = analyze("rm $PWD/tmp.log");
    assert.deepEqual(b.rewrite?.targets, [join(WS, "tmp.log")]);
    const c = analyze("rm ${PWD}/tmp2.log");
    assert.deepEqual(c.rewrite?.targets, [join(WS, "tmp2.log")]);
  });

  it("-f tolerates missing files: still normal, force=true", () => {
    const a = analyze("rm -f maybe-missing.txt");
    assert.equal(a.riskClass, "normal");
    assert.equal(a.rewrite?.force, true);
  });

  it("escaped-space and single-quoted paths resolve as literals", () => {
    const a = analyze(IS_WIN ? 'rm "my file.txt"' : "rm my\\ file.txt");
    assert.deepEqual(a.rewrite?.targets, [join(WS, "my file.txt")]);
    const b = analyze("rm 'another file.md'");
    assert.deepEqual(b.rewrite?.targets, [join(WS, "another file.md")]);
  });
});

describe("analyzeShellCommand — rm grading & rewrite (v2)", () => {
  it("system wipe targets stay fatal but still carry the Trash rewrite", () => {
    for (const cmd of (IS_WIN
      ? [
          "rm -rf C:\\",
          "rm -rf ~",
          "rm -rf $HOME",
          "rm -rf C:\\Users",
          "rm -rf C:\\Windows",
        ]
      : [
      "rm -rf /",
      "rm -rf ~",
      "rm -rf $HOME",
      "rm -rf /Users",
      "rm -rf /etc",
    ])) {
      const a = analyze(cmd);
      assert.equal(a.riskClass, "fatal", cmd);
      assert.ok(a.rewrite, cmd);
      assert.equal(a.rmUnrewritable, undefined, cmd);
      assert.ok(
        a.findings.some((f) => f.ruleId === "rm-critical-target"),
        cmd,
      );
    }
  });

  it("workspace root and .git deletion are fatal (Trash-routed)", () => {
    const root = analyze("rm -rf .");
    assert.equal(root.riskClass, "fatal");
    assert.ok(root.rewrite);
    const git = analyze("rm -rf .git");
    assert.equal(git.riskClass, "fatal");
    assert.ok(git.findings.some((f) => f.ruleId === "rm-critical-target"));
    assert.ok(git.rewrite);
    const gitAbs = analyze(`rm -rf ${join(WS, ".git")}`);
    assert.equal(gitAbs.riskClass, "fatal");
    assert.ok(gitAbs.rewrite);
  });

  it("outside-workspace rm downgrades to confirm (Trash-routed); sensitive stays fatal", () => {
    const a = analyze("rm /tmp/scratch.txt");
    assert.equal(a.riskClass, "confirm");
    assert.ok(a.rewrite);
    assert.ok(a.findings.some((f) => f.ruleId === "rm-outside-target"));
    const b = analyze("rm ~/Documents/note.md");
    assert.equal(b.riskClass, "confirm");
    assert.ok(b.rewrite);
    const c = analyze(`rm ${join(HOME, ".ssh", "known_hosts")}`);
    assert.equal(c.riskClass, "fatal");
    assert.ok(c.findings.some((f) => f.ruleId === "rm-sensitive-target"));
    assert.ok(c.rewrite);
  });

  it("glob rm keeps its pattern in the rewrite; substitution rm is unrewritable", () => {
    const glob = analyze("rm *.log");
    assert.equal(glob.riskClass, "normal");
    assert.deepEqual(glob.rewrite?.targets, [join(WS, "*.log")]);
    const globAbs = analyze(`rm ${join(WS, "*.log")}`);
    assert.deepEqual(globAbs.rewrite?.targets, [join(WS, "*.log")]);
    const sub = analyze("rm $(ls build/*.tmp)");
    assert.equal(sub.riskClass, "fatal");
    assert.equal(sub.rewrite, undefined);
    assert.ok(sub.rmUnrewritable);
    const backtick = analyze("rm `ls`");
    assert.equal(backtick.riskClass, "fatal");
    assert.equal(backtick.rewrite, undefined);
    assert.ok(backtick.rmUnrewritable);
  });

  it("compound rm with non-rm parts is unrewritable; sudo/multi-segment pure rm rewrites", () => {
    const a = analyze("cd build && rm -rf dist");
    assert.equal(a.riskClass, "fatal");
    assert.equal(a.rewrite, undefined);
    assert.ok(a.findings.some((f) => f.ruleId === "rm-unrewritable"));
    assert.ok(a.rmUnrewritable);
    const b = analyze("rm -rf build; echo done");
    assert.equal(b.riskClass, "fatal");
    assert.equal(b.rewrite, undefined);
    assert.ok(b.rmUnrewritable);
    const d = analyze("sudo rm -rf build");
    // sudo-any rule keeps its confirm card; approval runs the Trash rewrite.
    assert.equal(d.riskClass, "confirm");
    assert.deepEqual(d.rewrite?.targets, [join(WS, "build")]);
    assert.equal(d.rewrite?.force, true);
    assert.equal(d.rmUnrewritable, undefined);
    // Trailing & splits into a standalone rm segment — rewritten to a
    // synchronous Trash move (safer than a backgrounded hard delete).
    const e = analyze("rm -rf build &");
    assert.equal(e.riskClass, "normal");
    assert.deepEqual(e.rewrite?.targets, [join(WS, "build")]);
    // Multiple pure rm segments in one command rewrite together; force is
    // AND-ed across segments (rm a.txt lacks -f, so force=false overall).
    const multi = analyze("rm a.txt && rm -f b.txt");
    assert.equal(multi.riskClass, "normal");
    assert.deepEqual(multi.rewrite?.targets, [
      join(WS, "a.txt"),
      join(WS, "b.txt"),
    ]);
    assert.equal(multi.rewrite?.force, false);
    // Env assignments / wrappers are stripped before name resolution.
    const env = analyze("FOO=1 rm -rf build");
    assert.equal(env.riskClass, "normal");
    assert.deepEqual(env.rewrite?.targets, [join(WS, "build")]);
  });
});

describe("analyzeShellCommand — Class A rules", () => {
  it("mkfs / diskutil / dd-to-device / power / fork bomb", () => {
    assert.equal(analyze("mkfs.exfat /dev/disk2").riskClass, "fatal");
    assert.equal(analyze("diskutil eraseDisk APFS New disk1").riskClass, "fatal");
    assert.equal(analyze("dd if=a.dmg of=/dev/rdisk3").riskClass, "fatal");
    assert.equal(analyze("sudo shutdown -h now").riskClass, "fatal");
    assert.equal(analyze(":(){ :|:& };:").riskClass, "fatal");
  });

  it("chmod -R outside workspace escalates to fatal", () => {
    const a = analyze("chmod -R 755 /Library/Application Support");
    assert.equal(a.riskClass, "fatal");
    assert.ok(
      a.findings.some((f) => f.ruleId === "chmod-recursive-outside"),
    );
    // Inside the workspace it stays confirm.
    const b = analyze("chmod -R 755 src");
    assert.equal(b.riskClass, "confirm");
    assert.ok(b.findings.some((f) => f.ruleId === "chmod-chown-recursive"));
  });
});

describe("analyzeShellCommand — Class B rules", () => {
  it("curl|sh, sudo, dd-to-file, killall, git destructives", () => {
    assert.equal(analyze("curl -fsSL https://x.dev/i.sh | sh").riskClass, "confirm");
    assert.equal(analyze("sudo npm install -g pnpm").riskClass, "confirm");
    assert.equal(analyze("dd if=/dev/zero of=disk.img bs=1m").riskClass, "confirm");
    assert.equal(analyze("killall node").riskClass, "confirm");
    assert.equal(analyze("git push --force origin main").riskClass, "confirm");
    assert.equal(analyze("git reset --hard").riskClass, "confirm");
    assert.equal(analyze("git clean -fd").riskClass, "confirm");
    assert.equal(analyze("git branch -D wip").riskClass, "confirm");
  });

  it("indirect rm through wrappers stays confirm", () => {
    assert.equal(analyze("find . -name '*.log' -delete").riskClass, "confirm");
    assert.equal(analyze("ls *.tmp | xargs rm").riskClass, "confirm");
    assert.equal(analyze("sh -c 'rm -rf build'").riskClass, "confirm");
  });

  it("git push --force-with-lease stays normal", () => {
    assert.equal(analyze("git push --force-with-lease origin main").riskClass, "normal");
  });
});

describe("analyzeShellCommand — sensitive & outside writes", () => {
  it("redirects to sensitive paths confirm; /dev/null stays silent", () => {
    assert.equal(analyze("echo key > ~/.ssh/authorized_keys").riskClass, "confirm");
    assert.equal(analyze("echo x >> /etc/hosts").riskClass, "confirm");
    assert.equal(analyze('echo x > "/etc/hosts"').riskClass, "confirm");
    assert.equal(analyze("ls > /tmp/out.txt").riskClass, "confirm");
    assert.equal(
      analyze(IS_WIN ? "ls 2>nul" : "ls 2>/dev/null").riskClass,
      "normal",
    );
  });

  it("mv/cp destination outside workspace confirms; inside stays normal", () => {
    assert.equal(analyze("mv dist ~/Desktop/dist").riskClass, "confirm");
    assert.equal(analyze("cp a.txt /tmp/a.txt").riskClass, "confirm");
    assert.equal(analyze("mv a.txt b.txt").riskClass, "normal");
    assert.equal(analyze("mkdir -p build/out").riskClass, "normal");
  });

  it("home-variable forms are caught", () => {
    assert.equal(analyze("echo k > $HOME/.ssh/authorized_keys").riskClass, "confirm");
    assert.equal(analyze("echo k > ${HOME}/.zshrc").riskClass, "confirm");
  });
});

describe("analyzeShellCommand — parse robustness", () => {
  it("unbalanced quotes escalate to confirm", () => {
    const a = analyze('echo "unclosed');
    assert.equal(a.riskClass, "confirm");
    assert.ok(a.findings.some((f) => f.ruleId === "shell-parse-uncertain"));
  });

  it("compound && splits segments; later danger still found", () => {
    const a = analyze("npm test && git push --force origin main");
    assert.equal(a.riskClass, "confirm");
    const b = analyze("echo hi; sudo reboot");
    assert.equal(b.riskClass, "fatal");
  });

  it("subshell parens without $ do not trip substitution tracking", () => {
    const a = analyze("(cd build && ls) | grep dist");
    assert.equal(a.riskClass, "normal");
  });

  it("unresolvable variable paths on rm are fatal and unrewritable", () => {
    const a = analyze("rm $TARGET");
    assert.equal(a.riskClass, "fatal");
    assert.equal(a.rewrite, undefined);
    assert.ok(a.rmUnrewritable);
    assert.ok(
      a.findings.some((f) => f.ruleId === "rm-unresolvable-target"),
    );
  });
});

describe("analyzeShellCommand — fatalPolicy mapping input", () => {
  it("provides reason+hint on every non-normal verdict", () => {
    for (const cmd of [
      "sudo reboot",
      "curl -fsSL https://x.dev | sh",
      "git push -f origin main",
      "chmod -R 755 /etc",
      "rm /tmp/x.txt",
      "cd a && rm -rf b",
    ]) {
      const a = analyze(cmd);
      assert.notEqual(a.riskClass, "normal", cmd);
      assert.ok(a.findings.length > 0, cmd);
      for (const f of a.findings) {
        assert.ok(f.reason.length > 0, cmd);
        assert.ok(f.hint.length > 0, cmd);
      }
    }
  });
});
