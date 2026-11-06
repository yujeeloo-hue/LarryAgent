import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { uploadFilesHandler } from "./uploadFiles.js";
import {
  buildRemoteSizeProbe,
  buildRsyncCommand,
  buildScpCommand,
  chooseUploadBackend,
  formatRate,
  localUploadBytes,
  parseDestSpec,
  parseDuBytes,
  planUploadFiles,
  probeRsyncPrograms,
  scpProgressSample,
  shQuote,
  UploadLiveTracker,
} from "../uploadExec.js";

const WS = "/Users/youyee/Developer/JellyBot";
const IS_WIN = process.platform === "win32";

/** Pull the text out of a ToolExecuteResult content array. */
function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("");
}

describe("planUploadFiles", () => {
  it("derives absolute src and host dest spec", () => {
    const r = planUploadFiles(
      { src: "web/dist", dest_host: "deploy-host", dest_path: "/opt/jnote-web" },
      WS,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.plan.srcPath, join(WS, "web/dist"));
    assert.equal(r.plan.dest, "deploy-host:/opt/jnote-web");
    assert.equal(r.plan.destSpec, "deploy-host:/opt/jnote-web");
    assert.equal(r.plan.delete, false);
    assert.equal(r.plan.envAtRisk, false);
  });

  it("keeps absolute src as-is and flags envAtRisk on delete", () => {
    const r = planUploadFiles(
      {
        src: IS_WIN ? "E:\\jb-upload-src\\dist\\" : "/tmp/dist/",
        dest_host: "root@203.0.113.99",
        dest_path: "/opt/jnote-web",
        delete: true,
      },
      WS,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.plan.srcPath, IS_WIN ? "E:\\jb-upload-src\\dist\\" : "/tmp/dist/");
    assert.equal(r.plan.envAtRisk, true);
  });

  it("clears envAtRisk when .env is excluded", () => {
    const r = planUploadFiles(
      {
        src: "dist",
        dest_host: "h",
        dest_path: "/p",
        delete: true,
        excludes: [".env"],
      },
      WS,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.plan.envAtRisk, false);
    assert.deepEqual(r.plan.excludes, [".env"]);
  });

  it("rejects bad arguments", () => {
    const cases: unknown[] = [
      {},
      { src: "a" },
      { src: "a", dest_host: "h" },
      { src: "a", dest_host: "h", dest_path: "rel/path" },
      { src: 1, dest_host: "h", dest_path: "/p" },
      { src: "a", dest_host: "h", dest_path: "/p", delete: "yes" },
      { src: "a", dest_host: "h", dest_path: "/p", excludes: [1] },
    ];
    for (const c of cases) {
      const r = planUploadFiles(c as never, WS);
      assert.equal(r.ok, false, JSON.stringify(c));
    }
  });
});

describe("shQuote + buildRsyncCommand", () => {
  it("quotes POSIX tokens with single quotes", () => {
    assert.equal(shQuote("plain/path", "darwin"), "plain/path");
    assert.equal(shQuote("has space", "darwin"), "'has space'");
    assert.equal(shQuote("it's", "darwin"), "'it'\\''s'");
  });

  it("quotes Windows tokens with double quotes (cmd does not honour ')", () => {
    assert.equal(shQuote("plain/path", "win32"), "plain/path");
    assert.equal(shQuote("has space", "win32"), '"has space"');
    // Every Windows absolute path contains backslashes, which are not in the
    // safe set — without this branch cmd passes the ticks through literally.
    assert.equal(
      shQuote("E:\\build\\Larry Agent.exe", "win32"),
      '"E:\\build\\Larry Agent.exe"',
    );
    assert.equal(shQuote("", "win32"), '""');
  });

  it("builds the progress2 command with all options", () => {
    const planned = planUploadFiles(
      {
        src: "dist",
        dest_host: "deploy-host",
        dest_path: "/opt/jnote-web",
        delete: true,
        dry_run: true,
        excludes: [".env", "node_modules"],
      },
      WS,
    );
    assert.ok(planned.ok);
    const cmd = buildRsyncCommand(planned.plan, "progress2", "darwin");
    assert.ok(cmd.startsWith("rsync -az --info=progress2 --delete -n "));
    assert.ok(cmd.includes("--exclude=.env"));
    assert.ok(cmd.includes("--exclude=node_modules"));
    assert.ok(cmd.includes(`--out-format='%n|%b|%l'`));
    assert.ok(
      cmd.endsWith(`${shQuote(join(WS, "dist"), "darwin")} deploy-host:/opt/jnote-web`),
    );
  });

  it("builds the legacy (openrsync) command", () => {
    const planned = planUploadFiles(
      { src: "dist", dest_host: "h", dest_path: "/p" },
      WS,
    );
    assert.ok(planned.ok);
    const cmd = buildRsyncCommand(planned.plan, "legacy", "darwin");
    assert.ok(cmd.startsWith("rsync -az --progress -v "));
    assert.ok(!cmd.includes("--delete"));
  });

  it("quotes Windows paths for cmd when rsync is installed there", () => {
    const planned = planUploadFiles(
      { src: "E:\\builds\\1.5.3", dest_host: "h", dest_path: "/p" },
      WS,
    );
    assert.ok(planned.ok);
    const cmd = buildRsyncCommand(planned.plan, "legacy", "win32");
    assert.ok(cmd.includes("/cygdrive/e/builds/1.5.3 h:/p"));
    assert.ok(!cmd.includes("'E:"));
  });

  it("quotes the bundled rsync absolute path without splitting at spaces", () => {
    const planned = planUploadFiles(
      { src: "E:\\builds\\out dir", dest_host: "h", dest_path: "/p" },
      WS,
    );
    assert.ok(planned.ok);
    const program = "C:\\Program Files\\Larry Agent\\resources\\rsync\\bin\\rsync.exe";
    const cmd = buildRsyncCommand(planned.plan, "progress2", "win32", program);
    assert.ok(cmd.startsWith(`"${program}" -az --info=progress2 `));
    assert.ok(cmd.includes('"/cygdrive/e/builds/out dir" h:/p'));
  });
});

describe("chooseUploadBackend", () => {
  const plan = (extra: Record<string, unknown> = {}) => {
    const r = planUploadFiles(
      { src: "dist", dest_host: "h", dest_path: "/p", ...extra },
      WS,
    );
    if (!r.ok) throw new Error("plan failed");
    return r.plan;
  };

  it("prefers rsync in both flavors", () => {
    assert.deepEqual(
      chooseUploadBackend({
        platform: "darwin",
        plan: plan(),
        rsyncAvailable: true,
        progress2Supported: true,
      }),
      { kind: "rsync", mode: "progress2" },
    );
    assert.deepEqual(
      chooseUploadBackend({
        platform: "darwin",
        plan: plan(),
        rsyncAvailable: true,
        progress2Supported: false,
      }),
      { kind: "rsync", mode: "legacy" },
    );
  });

  it("falls back to scp on Windows when rsync is absent", () => {
    assert.deepEqual(
      chooseUploadBackend({
        platform: "win32",
        plan: plan(),
        rsyncAvailable: false,
        progress2Supported: false,
      }),
      { kind: "scp" },
    );
  });

  it("refuses on POSIX when rsync is absent (no silent fallback)", () => {
    const r = chooseUploadBackend({
      platform: "darwin",
      plan: plan(),
      rsyncAvailable: false,
      progress2Supported: false,
    });
    assert.equal(r.kind, "error");
    if (r.kind === "error") assert.match(r.error, /rsync was not found/);
  });

  it("refuses scp when the request needs rsync-only flags", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ delete: true }, /--delete/],
      [{ excludes: [".env"] }, /--exclude/],
      [{ dry_run: true }, /-n \(dry run\)/],
    ];
    for (const [extra, re] of cases) {
      const r = chooseUploadBackend({
        platform: "win32",
        plan: plan(extra),
        rsyncAvailable: false,
        progress2Supported: false,
      });
      assert.equal(r.kind, "error", JSON.stringify(extra));
      if (r.kind === "error") assert.match(r.error, re);
    }
  });
});

describe("probeRsyncPrograms", () => {
  it("uses the first working bundled candidate and stops probing", async () => {
    const seen: string[] = [];
    const result = await probeRsyncPrograms(["bundled", "rsync"], async (program) => {
      seen.push(program);
      return { available: true, progress2Supported: true };
    });
    assert.deepEqual(result, { program: "bundled", progress2Supported: true });
    assert.deepEqual(seen, ["bundled"]);
  });

  it("falls through a broken bundle to system rsync, or reports none", async () => {
    const seen: string[] = [];
    const probe = async (program: string) => {
      seen.push(program);
      return { available: program === "rsync", progress2Supported: false };
    };
    assert.deepEqual(await probeRsyncPrograms(["broken-bundle", "rsync"], probe), {
      program: "rsync", progress2Supported: false,
    });
    assert.deepEqual(seen, ["broken-bundle", "rsync"]);
    assert.equal(await probeRsyncPrograms(["broken-a", "broken-b"], async () => ({
      available: false, progress2Supported: false,
    })), null);
  });
});

describe("scp fallback helpers", () => {
  it("builds the scp command (directories, timestamps, BatchMode)", () => {
    const r = planUploadFiles(
      { src: "E:\\builds\\out dir", dest_host: "larry", dest_path: "/var/www/dl" },
      WS,
    );
    assert.ok(r.ok);
    assert.equal(
      buildScpCommand(r.plan, "win32"),
      'scp -r -p -o BatchMode=yes "E:\\builds\\out dir" larry:/var/www/dl',
    );
    const posix = planUploadFiles(
      { src: "/tmp/out", dest_host: "larry", dest_path: "/var/www/dl" },
      WS,
    );
    assert.ok(posix.ok);
    assert.equal(
      buildScpCommand(posix.plan, "darwin"),
      "scp -r -p -o BatchMode=yes /tmp/out larry:/var/www/dl",
    );
  });

  it("splits remote specs and rejects malformed ones", () => {
    assert.deepEqual(parseDestSpec("root@203.0.113.99:/var/www/x"), {
      host: "root@203.0.113.99",
      path: "/var/www/x",
    });
    assert.deepEqual(parseDestSpec("larry:/tmp"), { host: "larry", path: "/tmp" });
    assert.equal(parseDestSpec("larry:relative"), null);
    assert.equal(parseDestSpec("no-colon"), null);
    assert.equal(parseDestSpec(":/abs"), null);
  });

  it("counts local bytes and files for the progress total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jb-local-bytes-"));
    try {
      writeFileSync(join(dir, "a.bin"), Buffer.alloc(1000));
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "b.bin"), Buffer.alloc(24));
      const single = await localUploadBytes(join(dir, "a.bin"));
      assert.deepEqual(single, { bytes: 1000, files: 1 });
      const tree = await localUploadBytes(dir);
      assert.deepEqual(tree, { bytes: 1024, files: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives percent/speed/eta from polled remote bytes", () => {
    const s = scpProgressSample({ localBytes: 1000, remoteBytes: 250, elapsedMs: 2000 });
    assert.equal(s.bytesTotal, 1000);
    assert.equal(s.bytesSent, 250);
    assert.equal(s.percent, 25);
    assert.equal(s.speed, "125.00B/s");
    assert.equal(s.etaSeconds, 6);
    // Remote can report MORE than the local total (overhead / stale poll):
    // the bar must clamp instead of overflowing.
    const over = scpProgressSample({ localBytes: 100, remoteBytes: 500, elapsedMs: 1000 });
    assert.equal(over.bytesSent, 100);
    assert.equal(over.percent, 100);
    assert.equal(over.etaSeconds, null);
    const empty = scpProgressSample({ localBytes: 0, remoteBytes: 0, elapsedMs: 10 });
    assert.equal(empty.percent, 0);
    assert.equal(empty.speed, null);
  });

  it("formats rates the way rsync prints them", () => {
    assert.equal(formatRate(0), null);
    assert.equal(formatRate(999), "999.00B/s");
    assert.equal(formatRate(4900), "4.90kB/s");
    assert.equal(formatRate(4.9e6), "4.90MB/s");
  });

  it("builds the SSH size probe with a POSIX-quoted remote path", () => {
    const probe = buildRemoteSizeProbe("larry", "/var/www/dl");
    assert.equal(probe.command, "ssh");
    assert.deepEqual(probe.args.slice(0, 5), [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "larry",
    ]);
    assert.equal(probe.args[5], "du -sb /var/www/dl 2>/dev/null || echo 0");
    assert.equal(parseDuBytes("1234\t/var/www/dl\n"), 1234);
    assert.equal(parseDuBytes("0\n"), 0);
    assert.equal(parseDuBytes(""), 0);
  });
});

describe("UploadLiveTracker", () => {
  it("streams legacy per-file runs and lands filesDone on xfr#", () => {
    const events: unknown[] = [];
    const planned = planUploadFiles(
      { src: "d", dest_host: "h", dest_path: "/p" },
      WS,
    );
    assert.ok(planned.ok);
    const t = new UploadLiveTracker(planned.plan, "legacy", (p) =>
      events.push(p),
    );
    t.onChunk(
      "Transfer starting: 3 files\n" +
        "a.js|100|100\n" +
        "     100  100%  0.00kB/s   00:00:00 (xfer#1, to-check=2/3)\n" +
        "b.js|200|200\n",
    );
    t.flush();
    const last = events.at(-1) as Record<string, unknown>;
    assert.equal(last.filesDone, 1);
    assert.equal(last.filesTotal, 3);
    assert.equal(last.phase, "transferring");
    assert.equal(last.bytesSent, 100);
    assert.deepEqual((last.recentFiles as { name: string }[]).map((f) => f.name), [
      "a.js",
      "b.js",
    ]);
  });

  it("legacy openrsync run (uppercase KB/s) drives the bar mid-file", () => {
    const events: unknown[] = [];
    const planned = planUploadFiles(
      { src: "big.bin", dest_host: "h", dest_path: "/p" },
      WS,
    );
    assert.ok(planned.ok);
    const t = new UploadLiveTracker(planned.plan, "legacy", (p) =>
      events.push(p),
    );
    // Real openrsync shape (stock macOS rsync): \r-rewritten mid-file
    // runs with an uppercase "KB/s" unit — the old regex dropped these.
    t.onChunk(
      "Transfer starting: 1 files\n" +
        "          98304  32%   95.79KB/s   00:00:02\r" +
        "         131072  43%   31.98KB/s   00:00:05\r",
    );
    const last = events.at(-1) as Record<string, unknown>;
    // Single large file in flight: blended percent == the file's percent.
    assert.equal(last.percent, 43);
    assert.equal(last.bytesSent, 131072);
    assert.equal(last.filesDone, 0);
    assert.equal(last.filesTotal, 1);
    assert.equal(last.speed, "31.98KB/s");
    assert.equal(last.etaSeconds, 5);
  });

  it("legacy completion lands 100% without double-counting bytes", () => {
    const events: unknown[] = [];
    const planned = planUploadFiles(
      { src: "big.bin", dest_host: "h", dest_path: "/p" },
      WS,
    );
    assert.ok(planned.ok);
    const t = new UploadLiveTracker(planned.plan, "legacy", (p) =>
      events.push(p),
    );
    t.onChunk(
      "Transfer starting: 1 files\n" +
        "         294912  96%   31.99KB/s   00:00:00\r" +
        "         307200 100%   12.00KB/s   00:00:00\r" +
        "         307200 100%   42.84KB/s   00:00:07 (xfer#1, to-check=0/1)\n" +
        "big.bin|307282|307200\n",
    );
    t.flush();
    const last = events.at(-1) as Record<string, unknown>;
    assert.equal(last.percent, 100);
    // 307200 counted once (bytesAccum), not twice (completion + sample).
    assert.equal(last.bytesSent, 307200);
    assert.equal(last.filesDone, 1);
  });

  it("legacy blend mixes completed files with the in-flight file", () => {
    const events: unknown[] = [];
    const planned = planUploadFiles(
      { src: "d", dest_host: "h", dest_path: "/p" },
      WS,
    );
    assert.ok(planned.ok);
    const t = new UploadLiveTracker(planned.plan, "legacy", (p) =>
      events.push(p),
    );
    t.onChunk(
      "Transfer starting: 3 files\n" +
        "a.js|100|100\n" +
        "     100  100%  0.00kB/s   00:00:00 (xfer#1, to-check=2/3)\n" +
        "       2000  50%   1.00MB/s   00:00:02\r",
    );
    const last = events.at(-1) as Record<string, unknown>;
    // (1 done + 0.5 of b.js) / 3 files → 50%.
    assert.equal(last.percent, 50);
    // a.js (100, via xfr#) + b.js's partial 2000.
    assert.equal(last.bytesSent, 2100);
    assert.equal(last.filesDone, 1);
  });

  it("progress2 mode passes whole-transfer percent through", () => {
    const events: unknown[] = [];
    const planned = planUploadFiles(
      { src: "d", dest_host: "h", dest_path: "/p" },
      WS,
    );
    assert.ok(planned.ok);
    const t = new UploadLiveTracker(planned.plan, "progress2", (p) =>
      events.push(p),
    );
    t.onChunk("          4,251,232   38%  4.90MB/s    0:00:04  xfr#89, ir-chk=1021/1235\n");
    t.flush();
    const last = events.at(-1) as Record<string, unknown>;
    assert.equal(last.percent, 38);
    assert.equal(last.bytesSent, 4251232);
    assert.equal(last.speed, "4.90MB/s");
  });
});

describe("uploadFilesHandler (integration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jb-upload-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("fails fast on invalid arguments without spawning rsync", async () => {
    const r = await uploadFilesHandler({ src: "x" } as never, {
      workspacePath: WS,
    } as never);
    assert.match(textOf(r), /dest_host/);
  });

  it("fails fast when the source path does not exist", async () => {
    const r = await uploadFilesHandler(
      { src: "no-such-dir-xyz", dest_host: "h", dest_path: "/p" } as never,
      { workspacePath: WS } as never,
    );
    assert.match(textOf(r), /does not exist/);
  });

  it("runs the real transfer against a bogus host and reports the failure shape", { timeout: 20_000 }, async () => {
    writeFileSync(join(dir, "a.txt"), "hello upload");
    const r = await uploadFilesHandler(
      {
        src: join(dir, "a.txt"),
        dest_host: "no-such-host.invalid",
        dest_path: "/tmp/jb-upload-test",
      } as never,
      // A real directory: execShellProcess spawns with cwd = workspace root,
      // and a nonexistent cwd fails the spawn (cmd.exe ENOENT on Windows).
      { workspacePath: dir } as never,
    );
    const text = textOf(r);
    // rsync when present, scp (Windows without rsync) otherwise — both must
    // report the same result shape, and both must actually fail on a bogus host.
    assert.match(text, /^\$ (rsync -az|scp -r) /m);
    assert.match(text, /^backend (rsync|scp)/m);
    assert.match(text, /^cwd /m);
    assert.match(text, /^exit [1-9]\d*/m);
    assert.match(text, /^elapsed /m);
  });
});
