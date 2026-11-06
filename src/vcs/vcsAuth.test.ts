import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

import {
  askVcsCredentials,
  buildGitAuthEnv,
  buildSvnAuthArgs,
  cacheSessionVcsCredentials,
  clearSessionVcsCredentials,
  configureVcsAuthTimeoutForTests,
  decodeVcsCredentials,
  encodeVcsCredentials,
  isVcsAuthFailure,
  readStoredVcsCredentials,
  resetSessionVcsCredentialsForTests,
  resolveVcsAuthResponse,
  setVcsAuthBroadcastSink,
  writeStoredVcsCredentials,
} from "./vcsAuth.js";
import {
  configureCredentialCipherForTests,
  configureCredentialsRoot,
} from "../llm/credentials.js";
import type { CredentialCipher } from "../llm/credentials.js";

/** base64 "cipher" — deterministic and reversible so roundtrips are provable. */
const fakeCipher: CredentialCipher = {
  mode: "safeStorage",
  encrypt: (plainText) => Buffer.from(`enc:${plainText}`, "utf8").toString("base64"),
  decrypt: (payload) => {
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    if (!decoded.startsWith("enc:")) throw new Error("corrupt payload");
    return decoded.slice(4);
  },
};

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-vcsauth-test-"));
}

afterEach(() => {
  configureCredentialCipherForTests(undefined);
  setVcsAuthBroadcastSink(null);
  resetSessionVcsCredentialsForTests();
  configureVcsAuthTimeoutForTests(10 * 60_000);
});

describe("isVcsAuthFailure", () => {
  it("recognizes git credential-prompt failures", () => {
    assert.equal(
      isVcsAuthFailure(
        "fatal: could not read Username for 'https://example.com/repo.git': terminal prompts disabled",
      ),
      true,
    );
    assert.equal(isVcsAuthFailure("Authentication failed for 'https://example.com'"), true);
    assert.equal(isVcsAuthFailure("remote: HTTP Basic: Access denied"), true);
    assert.equal(isVcsAuthFailure("error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401"), true);
  });

  it("recognizes svn auth error codes", () => {
    assert.equal(isVcsAuthFailure("svn: E170001: Authentication failed"), true);
    assert.equal(
      isVcsAuthFailure("svn: E215004: No more credentials or we tried too many times"),
      true,
    );
  });

  it("does not flag plain network / not-found / tree failures", () => {
    assert.equal(isVcsAuthFailure("svn: E155007: not a working copy"), false);
    assert.equal(
      isVcsAuthFailure("fatal: unable to access 'https://x/': Failed to connect"),
      false,
    );
    assert.equal(isVcsAuthFailure("File is not tracked by Git yet"), false);
    assert.equal(isVcsAuthFailure("W155010: path is not under version control"), false);
  });
});

describe("credential codec", () => {
  it("round-trips username and password", () => {
    const c = { username: "ada", password: "s3cr:et\nline" };
    assert.deepEqual(decodeVcsCredentials(encodeVcsCredentials(c)), c);
  });

  it("rejects malformed payloads", () => {
    assert.equal(decodeVcsCredentials("noseparator"), null);
    assert.equal(decodeVcsCredentials("\u0000password-only"), null);
    assert.equal(decodeVcsCredentials("user\u0000"), null);
    assert.equal(decodeVcsCredentials(""), null);
  });
});

describe("builders", () => {
  it("git env injects a per-remote Basic header without argv", () => {
    const env = buildGitAuthEnv("https://example.com/repo.git", {
      username: "ada",
      password: "pw",
    });
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://example.com/repo.git.extraheader");
    const basic = Buffer.from("ada:pw", "utf8").toString("base64");
    assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${basic}`);
    // Credentials never appear as separate argv/log lines.
    assert.ok(!env.GIT_CONFIG_VALUE_0.includes("ada:pw"));
  });

  it("svn args pass username/password with no-auth-cache", () => {
    const args = buildSvnAuthArgs({ username: "ada", password: "pw" });
    assert.deepEqual(args, ["--username", "ada", "--password", "pw", "--no-auth-cache"]);
  });
});

describe("ask flow", () => {
  it("uses the session cache without prompting", async () => {
    configureCredentialsRoot(newRoot());
    configureCredentialCipherForTests(fakeCipher);
    let prompts = 0;
    setVcsAuthBroadcastSink(() => {
      prompts++;
    });
    cacheSessionVcsCredentials("svn:E:\\ws", {
      username: "cached",
      password: "pw",
    });
    const c = await askVcsCredentials({
      vcs: "svn",
      operation: "Annotate",
      context: "E:\\ws",
      cacheKey: "svn:E:\\ws",
    });
    assert.equal(prompts, 0);
    assert.deepEqual(c, { username: "cached", password: "pw" });
  });

  it("prompts, resolves via respond, and remembers to the store", async () => {
    const root = newRoot();
    configureCredentialsRoot(root);
    configureCredentialCipherForTests(fakeCipher);
    setVcsAuthBroadcastSink((payload) => {
      assert.equal(payload.operation, "Push");
      setImmediate(() => {
        const accepted = resolveVcsAuthResponse({
          requestId: payload.requestId,
          credentials: { username: "ada", password: "pw" },
          remember: true,
        });
        assert.equal(accepted, true);
      });
    });
    const c = await askVcsCredentials({
      vcs: "git",
      operation: "Push",
      context: "https://example.com/repo.git",
    });
    assert.deepEqual(c, { username: "ada", password: "pw" });

    // Stored under the namespaced provider id; encrypted on disk.
    const raw = readFileSync(join(root, "llm-api-keys.json"), "utf8");
    assert.ok(!raw.includes("ada"));
    assert.ok(raw.includes("vcs-auth:"));
    const stored = await readStoredVcsCredentials("git:https://example.com/repo.git");
    assert.deepEqual(stored, { username: "ada", password: "pw" });

    // Second ask hits the store without a broadcast.
    let prompted = false;
    setVcsAuthBroadcastSink(() => {
      prompted = true;
    });
    const again = await askVcsCredentials({
      vcs: "git",
      operation: "Push",
      context: "https://example.com/repo.git",
    });
    assert.equal(prompted, false);
    assert.deepEqual(again, { username: "ada", password: "pw" });
  });

  it("session-only answers are cached in memory, not persisted", async () => {
    const root = newRoot();
    configureCredentialsRoot(root);
    configureCredentialCipherForTests(fakeCipher);
    setVcsAuthBroadcastSink((payload) => {
      setImmediate(() => {
        resolveVcsAuthResponse({
          requestId: payload.requestId,
          credentials: { username: "bob", password: "pw2" },
          remember: false,
        });
      });
    });
    const c = await askVcsCredentials({
      vcs: "svn",
      operation: "Update",
      context: "E:\\ws",
    });
    assert.deepEqual(c, { username: "bob", password: "pw2" });
    const stored = await readStoredVcsCredentials("svn:E:\\ws");
    assert.equal(stored, null);
  });

  it("resolves null (abort) when the user dismisses", async () => {
    configureCredentialsRoot(newRoot());
    configureCredentialCipherForTests(fakeCipher);
    setVcsAuthBroadcastSink((payload) => {
      setImmediate(() => {
        resolveVcsAuthResponse({
          requestId: payload.requestId,
          credentials: null,
          remember: false,
        });
      });
    });
    const c = await askVcsCredentials({
      vcs: "svn",
      operation: "Annotate",
      context: "E:\\ws",
    });
    assert.equal(c, null);
  });

  it("times out to null so a forgotten dialog cannot wedge the caller", async () => {
    configureCredentialsRoot(newRoot());
    configureCredentialCipherForTests(fakeCipher);
    configureVcsAuthTimeoutForTests(20);
    setVcsAuthBroadcastSink(() => {
      /* nobody answers */
    });
    const c = await askVcsCredentials({
      vcs: "git",
      operation: "Push",
      context: "https://example.com/x.git",
    });
    assert.equal(c, null);
  });

  it("a stale response for an unknown requestId is rejected, not thrown", () => {
    assert.equal(
      resolveVcsAuthResponse({
        requestId: "does-not-exist",
        credentials: { username: "x", password: "y" },
        remember: false,
      }),
      false,
    );
  });

  it("empty usernames are rejected as credentials=null", async () => {
    configureCredentialsRoot(newRoot());
    configureCredentialCipherForTests(fakeCipher);
    setVcsAuthBroadcastSink((payload) => {
      setImmediate(() => {
        resolveVcsAuthResponse({
          requestId: payload.requestId,
          credentials: { username: "   ", password: "pw" },
          remember: false,
        });
      });
    });
    const c = await askVcsCredentials({
      vcs: "svn",
      operation: "Commit",
      context: "E:\\ws",
    });
    assert.equal(c, null);
  });

  it("clearSessionVcsCredentials removes the cached entry", async () => {
    const key = "svn:E:\\ws2";
    cacheSessionVcsCredentials(key, { username: "a", password: "b" });
    clearSessionVcsCredentials(key);
    // No sink → the ask must resolve null instead of hanging.
    setVcsAuthBroadcastSink(null);
    const c = await askVcsCredentials({
      vcs: "svn",
      operation: "Annotate",
      context: "E:\\ws2",
      cacheKey: key,
    });
    assert.equal(c, null);
  });

  it("returns null without prompting when no broadcast sink is set", async () => {
    // (test env / tooling — never hang waiting for a renderer)
    setVcsAuthBroadcastSink(null);
    const c = await askVcsCredentials({
      vcs: "git",
      operation: "Push",
      context: "https://example.com/repo.git",
      cacheKey: `no-sink-${Date.now()}`,
    });
    assert.equal(c, null);
  });
});
