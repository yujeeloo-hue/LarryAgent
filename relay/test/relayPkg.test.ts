/**
 * Self-host packaging invariants (relay/install.sh + unit template +
 * build-relay-pkg.mjs naming). These guard the shipped installer: POSIX
 * syntax, the no-delete safety property, sha256 pinning, and the
 * systemd unit's hardened shape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(import.meta.filename), "..", "..");
const installSh = join(repoRoot, "relay", "install.sh");
const unitTemplate = join(repoRoot, "relay", "jellybot-relay.service");
const sh = process.platform === "win32" ? "sh" : "/bin/sh";

describe("relay self-host installer", () => {
  const script = readFileSync(installSh, "utf8");

  it("parses under a POSIX shell", () => {
    const r = spawnSync(sh, ["-n", installSh], { encoding: "utf8" });
    assert.equal(r.status, 0, `sh -n failed: ${r.stderr}`);
  });

  it("prints usage and exits 0 before any preflight", () => {
    const r = spawnSync(sh, [installSh, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--version=X\.Y\.Z/);
    assert.match(r.stdout, /--no-systemd/);
    assert.match(r.stdout, /--prefix=DIR/);
  });

  it("rejects unknown arguments", () => {
    const r = spawnSync(sh, [installSh, "--bogus"], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown argument/);
  });

  it("never deletes anything except its own /tmp scratch files", () => {
    const offenders = script
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /^rm\s/.test(line))
      .filter(({ line }) => !line.startsWith('rm -rf "$tmpdir"') && !line.startsWith("rm -f \"$unit_new\""));
    assert.deepEqual(offenders, [], "installer grew an rm outside its own scratch files");
  });

  it("pins downloads against the manifest sha256", () => {
    assert.match(script, /sha256sum -c/);
    assert.match(script, /larryagent\.online\/download\/downloads\.json/);
    assert.match(script, /jellybot\.cloud\/download\/downloads\.json/);
  });

  it("derives download URLs from the manifest URL without doubling /download/", () => {
    // Tripwire for the 404 bug: base_url must strip the WHOLE
    // "/download/downloads.json" suffix, and every fetch then re-appends
    // "/download/" exactly once.
    assert.match(script, /base_url="\$\{url%\/download\/downloads\.json\}"/);
    const doubled = script.split("\n").filter((l) => /\$\{base_url\}\/download\/download\//.test(l));
    assert.deepEqual(doubled, []);
  });

  it("surfaces the first-run console credential, keeps data untouched", () => {
    assert.match(script, /web console login/);
    // The data dir only ever appears in env/backup-never contexts.
    assert.doesNotMatch(script, /rm\s+-[^\n]*data/);
  });

  it("moves replaced files aside instead of overwriting in place", () => {
    assert.match(script, /\.bak-\$ts/);
    assert.match(script, /mv "\$PREFIX\/\$item" "\$PREFIX\/\$item\.bak-\$ts"/);
  });

  it("polls /api/health after start", () => {
    assert.match(script, /\/api\/health/);
  });
});

describe("relay systemd unit template", () => {
  const unit = readFileSync(unitTemplate, "utf8");

  it("carries the placeholders install.sh substitutes", () => {
    for (const token of ["__PREFIX__", "__PORT__", "__BASE_PATH__", "__NODE__"]) {
      assert.ok(unit.includes(token), `missing placeholder ${token}`);
    }
  });

  it("keeps the hardened production shape", () => {
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.match(unit, /^ReadWritePaths=__PREFIX__\/data$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    // Never listens beyond loopback; TLS belongs to the reverse proxy.
    assert.match(unit, /^Environment=RELAY_HOST=127\.0\.0\.1$/m);
  });
});
