import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSshInsteadOfEnv,
  isSshRemoteUrl,
  parseHttpsGitRemote,
  probeSshGitAccess,
  pushWithSshFallback,
  sshProbeIndicatesAccess,
  type SshProbeRunner,
} from "./sshFallback.js";

describe("parseHttpsGitRemote", () => {
  it("parses a plain github HTTPS remote", () => {
    assert.deepEqual(parseHttpsGitRemote("https://github.com/yujeeloo-hue/ETHub.git"), {
      host: "github.com",
      port: null,
    });
  });

  it("keeps a custom port", () => {
    assert.deepEqual(parseHttpsGitRemote("https://git.example.com:8443/team/repo.git"), {
      host: "git.example.com",
      port: 8443,
    });
  });

  it("strips embedded user:pass credentials", () => {
    assert.deepEqual(parseHttpsGitRemote("https://ada:s3cret@github.com/ada/repo"), {
      host: "github.com",
      port: null,
    });
  });

  it("rejects ssh / scp-style / local URLs", () => {
    assert.equal(parseHttpsGitRemote("git@github.com:yujeeloo-hue/JellyBot.git"), null);
    assert.equal(parseHttpsGitRemote("ssh://git@github.com/yujeeloo-hue/JellyBot.git"), null);
    assert.equal(parseHttpsGitRemote("/Users/youyee/Developer/JellyBot"), null);
    assert.equal(parseHttpsGitRemote(""), null);
  });
});

describe("buildSshInsteadOfEnv", () => {
  it("rewrites https://host/ to the scp ssh form via env-only config", () => {
    const env = buildSshInsteadOfEnv("https://github.com/yujeeloo-hue/ETHub.git");
    assert.ok(env);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "url.git@github.com:.insteadOf");
    assert.equal(env.GIT_CONFIG_VALUE_0, "https://github.com/");
  });

  it("uses ssh://git@host:port/ when the remote has a custom port", () => {
    const env = buildSshInsteadOfEnv("https://git.example.com:2222/team/repo.git");
    assert.ok(env);
    assert.equal(env.GIT_CONFIG_KEY_0, "url.ssh://git@git.example.com:2222/.insteadOf");
    assert.equal(env.GIT_CONFIG_VALUE_0, "https://git.example.com/");
  });

  it("preserves the http scheme of the remote", () => {
    const env = buildSshInsteadOfEnv("http://git.internal/team/repo.git");
    assert.ok(env);
    assert.equal(env.GIT_CONFIG_VALUE_0, "http://git.internal/");
  });

  it("returns null for non-https remotes", () => {
    assert.equal(buildSshInsteadOfEnv("git@github.com:yujeeloo-hue/JellyBot.git"), null);
    assert.equal(buildSshInsteadOfEnv(""), null);
  });
});

describe("isSshRemoteUrl", () => {
  it("recognizes scp-style and ssh:// remotes", () => {
    assert.equal(isSshRemoteUrl("git@github.com:yujeeloo-hue/JellyBot.git"), true);
    assert.equal(isSshRemoteUrl("ssh://git@github.com/yujeeloo-hue/JellyBot.git"), true);
    assert.equal(isSshRemoteUrl("deploy@example.com:srv/repo.git"), true);
  });

  it("does not match https or plain paths", () => {
    assert.equal(isSshRemoteUrl("https://github.com/yujeeloo-hue/ETHub.git"), false);
    assert.equal(isSshRemoteUrl("/Users/youyee/Developer/JellyBot"), false);
    assert.equal(isSshRemoteUrl(""), false);
  });
});

describe("sshProbeIndicatesAccess", () => {
  it("matches GitHub / GitLab / Bitbucket greetings", () => {
    assert.equal(
      sshProbeIndicatesAccess("Hi yujeeloo-hue! You've successfully authenticated, but GitHub does not provide shell access."),
      true,
    );
    assert.equal(sshProbeIndicatesAccess("Welcome to GitLab, @ada!"), true);
    assert.equal(sshProbeIndicatesAccess("logged in as ada"), true);
  });

  it("rejects failure output", () => {
    assert.equal(sshProbeIndicatesAccess("git@github.com: Permission denied (publickey)."), false);
    assert.equal(sshProbeIndicatesAccess("Host key verification failed."), false);
    assert.equal(sshProbeIndicatesAccess(""), false);
  });
});

describe("probeSshGitAccess", () => {
  it("probes non-interactively and reports granted access", async () => {
    let seenArgs: string[] = [];
    const runner: SshProbeRunner = async (args) => {
      seenArgs = args;
      return { stdout: "", stderr: "Hi ada! You've successfully authenticated." };
    };
    const ok = await probeSshGitAccess({ host: "github.com", port: null }, runner);
    assert.equal(ok, true);
    assert.ok(seenArgs.includes("BatchMode=yes"), "probe must be non-interactive");
    assert.ok(seenArgs.includes("-T"));
    assert.equal(seenArgs.at(-1), "git@github.com");
  });

  it("uses an ssh:// destination for custom ports", async () => {
    let seenArgs: string[] = [];
    const runner: SshProbeRunner = async (args) => {
      seenArgs = args;
      return { stdout: "", stderr: "" };
    };
    await probeSshGitAccess({ host: "git.example.com", port: 2222 }, runner);
    assert.equal(seenArgs.at(-1), "ssh://git@git.example.com:2222");
  });

  it("resolves false on denied keys or a missing ssh binary", async () => {
    assert.equal(
      await probeSshGitAccess(
        { host: "github.com", port: null },
        async () => ({ stdout: "", stderr: "Permission denied (publickey)." }),
      ),
      false,
    );
    assert.equal(
      await probeSshGitAccess(
        { host: "github.com", port: null },
        async () => {
          throw new Error("spawn ssh ENOENT");
        },
      ),
      false,
    );
  });
});

describe("pushWithSshFallback", () => {
  it("returns unavailable when the remote is not https", async () => {
    const result = await pushWithSshFallback(
      "git@github.com:yujeeloo-hue/JellyBot.git",
      async () => {
        throw new Error("must not push");
      },
    );
    assert.deepEqual(result, { status: "unavailable" });
  });

  it("returns unavailable when the ssh probe fails", async () => {
    const result = await pushWithSshFallback(
      "https://github.com/yujeeloo-hue/ETHub.git",
      async () => {
        throw new Error("must not push");
      },
      async () => ({ stdout: "", stderr: "Permission denied (publickey)." }),
    );
    assert.deepEqual(result, { status: "unavailable" });
  });

  it("pushes with the insteadOf env once the key works", async () => {
    const seenEnv: Record<string, string>[] = [];
    const result = await pushWithSshFallback(
      "https://github.com/yujeeloo-hue/ETHub.git",
      async (env) => {
        seenEnv.push(env);
        return { stdout: "", stderr: "To https://github.com/yujeeloo-hue/ETHub.git" };
      },
      async () => ({ stdout: "", stderr: "successfully authenticated" }),
    );
    assert.equal(result.status, "pushed");
    if (result.status === "pushed") {
      assert.match(result.output, /ETHub\.git/);
    }
    assert.equal(seenEnv.length, 1);
    assert.equal(seenEnv[0].GIT_CONFIG_KEY_0, "url.git@github.com:.insteadOf");
  });

  it("maps a failed ssh push to failed with its message", async () => {
    const result = await pushWithSshFallback(
      "https://github.com/yujeeloo-hue/ETHub.git",
      async () => {
        throw new Error("non-fast-forward");
      },
      async () => ({ stdout: "", stderr: "successfully authenticated" }),
    );
    assert.deepEqual(result, { status: "failed", message: "non-fast-forward" });
  });
});
