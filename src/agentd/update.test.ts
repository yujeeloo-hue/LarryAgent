/**
 * performAgentdUpdate: same-version force keeps the previous rollback
 * target, and a failed extract does not throw.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { performAgentdUpdate, type AgentdUpdateStepEvent } from "./update.js";

const base = mkdtempSync(join(tmpdir(), "jb-update-"));
const installDir = join(base, "opt");

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function buildRelease(version: string, marker: string): string {
  const workDir = join(base, `src-${version}-${marker}`);
  const rootName = `jellybot-agentd-${version}`;
  const root = join(workDir, rootName);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "lib", "node", "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "jellybot-agentd", version }), "utf8");
  writeFileSync(join(root, "lib", "agentd.mjs"), "// stub\n", "utf8");
  writeFileSync(join(root, "lib", "marker.txt"), marker, "utf8");
  writeFileSync(
    join(root, "lib", "node", "bin", "node"),
    `#!/bin/sh\nprintf 'jellybot-agentd ${version}\\n'\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(root, "bin", "agentd"), "#!/bin/sh\n:", { mode: 0o755 });
  const tarball = join(workDir, "release.tar.gz");
  const tar = spawnSync("tar", ["-czf", tarball, "-C", workDir, rootName], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(tar.status, 0, String(tar.stderr));
  return tarball;
}

describe("performAgentdUpdate", () => {
  it("keeps the previous release across a same-version force reinstall", async () => {
    const first = buildRelease("1.0.0", "v1");
    const second = buildRelease("1.1.0", "old");
    const forced = buildRelease("1.1.0", "new");

    const a = await performAgentdUpdate({ source: first, installDir });
    assert.equal(a.ok, true);
    const b = await performAgentdUpdate({ source: second, installDir });
    assert.equal(b.ok, true);
    assert.equal(readlinkSync(join(installDir, "previous")), join(installDir, "1.0.0"));

    const c = await performAgentdUpdate({ source: forced, installDir, force: true });
    assert.equal(c.ok, true);
    if (!c.ok) return;
    assert.equal(c.version, "1.1.0");
    assert.equal(readlinkSync(join(installDir, "current")), join(installDir, "1.1.0"));
    assert.equal(readlinkSync(join(installDir, "previous")), join(installDir, "1.0.0"));
    assert.equal(readFileSync(join(installDir, "1.1.0", "lib", "marker.txt"), "utf8"), "new");
    assert.equal(existsSync(join(installDir, ".1.1.0.incoming")), false);
    assert.equal(existsSync(join(installDir, ".1.1.0.retired")), false);
    assert.equal(readFileSync(join(installDir, "1.0.0", "lib", "marker.txt"), "utf8"), "v1");
  });

  it("returns a failure for http and for a tarball with no release root", async () => {
    const http = await performAgentdUpdate({
      source: "http://example.test/x.tar.gz",
      sha256: "ab".repeat(32),
      installDir,
    });
    assert.equal(http.ok, false);

    const emptyDir = join(base, "empty");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "readme.txt"), "nope", "utf8");
    const tarball = join(base, "empty.tar.gz");
    const tar = spawnSync("tar", ["-czf", tarball, "-C", base, "empty"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    assert.equal(tar.status, 0);
    const before = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const failed = await performAgentdUpdate({ source: tarball, installDir, sha256: before });
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.match(failed.error, /package.json/);
  });
});

/* ── Streaming download + structured step events (agentd ≥ 1.4) ──── */

function mockFetch(
  bytes: Buffer,
  opts: { contentLength?: string | null; chunkSize?: number; stall?: boolean } = {},
): typeof fetch {
  const chunkSize = opts.chunkSize ?? 4096;
  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    let offset = 0;
    // A real undici reader rejects pending reads when the signal aborts —
    // the stall watchdog relies on that, so the mock must honour it too.
    const doRead = (): Promise<{ done: boolean; value?: Uint8Array }> =>
      opts.stall
        ? new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          })
        : offset >= bytes.byteLength
          ? Promise.resolve({ done: true })
          : Promise.resolve({ done: false, value: bytes.subarray(offset, (offset += chunkSize)) });
    const headerValue = opts.contentLength === undefined ? String(bytes.byteLength) : opts.contentLength;
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? headerValue : null) },
      body: { getReader: () => ({ read: doRead }) },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("performAgentdUpdate streaming progress", () => {
  it("emits the full ordered step sequence with byte-level download progress", async () => {
    const tarball = buildRelease("2.0.0", "stream");
    const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const bytes = readFileSync(tarball);
    const events: AgentdUpdateStepEvent[] = [];
    const outcome = await performAgentdUpdate({
      source: "https://dl.test/jellybot-agentd-2.0.0-linux-arm64.tar.gz",
      sha256: sha,
      installDir,
      fetchFn: mockFetch(bytes, { chunkSize: 2048 }),
      onStep: (event) => events.push({ ...event, ...(event.progress ? { progress: { ...event.progress } } : {}) }),
    });
    assert.equal(outcome.ok, true);
    // Ordered run-length: the download step may repeat (progress ticks);
    // everything after appears exactly once, in pipeline order.
    const firsts = events.map((e) => e.step).filter((s, i, all) => s !== all[i - 1]);
    assert.deepEqual(firsts, ["download", "verify", "extract", "smoke", "install", "switch", "units", "restart"]);
    const downloads = events.filter((e) => e.step === "download" && e.progress);
    assert.ok(downloads.length >= 2, `progress ticks flowed (got ${downloads.length})`);
    const last = downloads[downloads.length - 1]!;
    assert.equal(last.progress!.receivedBytes, bytes.byteLength);
    assert.equal(last.progress!.totalBytes, bytes.byteLength);
    assert.equal(last.progress!.pct, 100);
  });

  it("downloads without Content-Length report bytes but no pct (indeterminate)", async () => {
    const tarball = buildRelease("2.1.0", "indet");
    const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const bytes = readFileSync(tarball);
    const events: AgentdUpdateStepEvent[] = [];
    const outcome = await performAgentdUpdate({
      source: "https://dl.test/jellybot-agentd-2.1.0-linux-arm64.tar.gz",
      sha256: sha,
      installDir,
      fetchFn: mockFetch(bytes, { contentLength: null, chunkSize: 1024 }),
      onStep: (event) => events.push(event),
    });
    assert.equal(outcome.ok, true);
    const downloads = events.filter((e) => e.step === "download" && e.progress);
    const last = downloads[downloads.length - 1]!;
    assert.equal(last.progress!.receivedBytes, bytes.byteLength);
    assert.equal(last.progress!.totalBytes, undefined);
    assert.equal(last.progress!.pct, undefined);
  });

  it("aborts a stalled download with a clear error instead of hanging forever", async () => {
    const events: AgentdUpdateStepEvent[] = [];
    const outcome = await performAgentdUpdate({
      source: "https://dl.test/hangs.tar.gz",
      sha256: "ab".repeat(32),
      installDir,
      fetchFn: mockFetch(Buffer.alloc(0), { stall: true }),
      // tick cadence is stallMs/4 (min 250ms) — aborts within ~500ms.
      downloadStallMs: 400,
      onStep: (event) => events.push(event),
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.error, /download stalled/);
    assert.equal(events.every((e) => e.step === "download"), true, "no steps after a dead download");
  });
});
