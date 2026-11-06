/**
 * Update-draft store: one release per platform channel. The regression this
 * guards: a fetched win package/version must never fill (or judge) the
 * mac/agentd cards.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDraftPatch,
  DEFAULT_MANIFEST_URL,
  draftFor,
  emptyMaintStore,
  parseMaintStore,
  withDraft,
} from "../src/maintenanceDraft.js";

const WIN_ZIP = "https://dl.test/download/Larry-Agent-1.5.3-win-x64-setup.exe";
const MAC_ZIP = "https://dl.test/download/Larry-Agent-1.5.2-mac-arm64.zip";

test("an empty store has a blank draft per channel and the default manifest", () => {
  const store = emptyMaintStore();
  assert.equal(store.manifestUrl, DEFAULT_MANIFEST_URL);
  assert.equal(store.force, false);
  for (const channel of ["mac", "win", "agentd"] as const) {
    assert.deepEqual(draftFor(store, channel), { source: "", sha256: "" });
  }
  assert.deepEqual(draftFor(store, null), { source: "", sha256: "" }, "unknown platform has no draft");
});

test("fetch results land in their own channel only (no cross-platform version)", () => {
  let store = withDraft(emptyMaintStore(), "win", { source: WIN_ZIP, sha256: "a".repeat(64), version: "1.5.3" });
  store = withDraft(store, "mac", { source: MAC_ZIP, sha256: "b".repeat(64), version: "1.5.2" });

  assert.equal(draftFor(store, "win").version, "1.5.3");
  assert.equal(draftFor(store, "win").source, WIN_ZIP);
  assert.equal(draftFor(store, "mac").version, "1.5.2");
  assert.equal(draftFor(store, "mac").source, MAC_ZIP);
  assert.deepEqual(draftFor(store, "agentd"), { source: "", sha256: "" }, "agentd untouched");
});

test("form edits are per channel; manifest URL and force stay global", () => {
  const start = withDraft(emptyMaintStore(), "mac", { source: MAC_ZIP, sha256: "b".repeat(64), version: "1.5.2" });
  const store = applyDraftPatch(start, "win", { source: WIN_ZIP, force: true });

  assert.equal(draftFor(store, "win").source, WIN_ZIP);
  assert.equal(draftFor(store, "mac").source, MAC_ZIP, "the other platform's draft is untouched");
  assert.equal(draftFor(store, "mac").version, "1.5.2");
  assert.equal(store.force, true, "force is global");
  assert.equal(store.manifestUrl, DEFAULT_MANIFEST_URL);

  const withUrl = applyDraftPatch(store, "win", { manifestUrl: "https://dl.test/other.json" });
  assert.equal(withUrl.manifestUrl, "https://dl.test/other.json");
  assert.equal(draftFor(withUrl, "mac").source, MAC_ZIP);
});

test("editing the release clears the manifest version", () => {
  const fetched = withDraft(emptyMaintStore(), "win", { source: WIN_ZIP, sha256: "a".repeat(64), version: "1.5.3" });
  const edited = applyDraftPatch(fetched, "win", { source: "/tmp/custom.exe", version: undefined });
  assert.equal(draftFor(edited, "win").source, "/tmp/custom.exe");
  assert.equal(draftFor(edited, "win").version, undefined, "a hand-typed source invents no version");
  // A patch that does not mention the version keeps it.
  const kept = applyDraftPatch(edited, "win", { sha256: "c".repeat(64) });
  assert.equal(draftFor(kept, "win").version, undefined);
  const refetched = applyDraftPatch(kept, "win", { version: "1.5.4" });
  assert.equal(draftFor(refetched, "win").version, "1.5.4");
});

test("persisted drafts round-trip per channel", () => {
  const store = withDraft(
    withDraft(emptyMaintStore(), "mac", { source: MAC_ZIP, sha256: "b".repeat(64), version: "1.5.2" }),
    "agentd",
    { source: "https://dl.test/jellybot-agentd-1.5.1-linux-arm64.tar.gz", sha256: "d".repeat(64), version: "1.5.1" },
  );
  const reloaded = parseMaintStore(JSON.stringify(store));
  assert.deepEqual(reloaded, store);
});

test("legacy single draft migrates into the channel its filename names", () => {
  const win = parseMaintStore(
    JSON.stringify({
      source: WIN_ZIP,
      sha256: "a".repeat(64),
      version: "1.5.3",
      force: true,
      manifestUrl: "https://dl.test/downloads.json",
    }),
  );
  assert.equal(draftFor(win, "win").version, "1.5.3");
  assert.equal(win.manifestUrl, "https://dl.test/downloads.json");
  assert.equal(win.force, true);
  assert.deepEqual(draftFor(win, "mac"), { source: "", sha256: "" }, "a win URL never becomes a mac draft");
  assert.deepEqual(draftFor(win, "agentd"), { source: "", sha256: "" });

  // Unrecognised legacy names are dropped instead of landing on every platform.
  const custom = parseMaintStore(JSON.stringify({ source: "/tmp/custom-release", version: "9.9.9" }));
  for (const channel of ["mac", "win", "agentd"] as const) {
    assert.deepEqual(draftFor(custom, channel), { source: "", sha256: "" });
  }
  // Corrupt / absent storage is harmless.
  assert.deepEqual(parseMaintStore("not json"), emptyMaintStore());
  assert.deepEqual(parseMaintStore(null), emptyMaintStore());
  assert.deepEqual(parseMaintStore("null"), emptyMaintStore());
});
