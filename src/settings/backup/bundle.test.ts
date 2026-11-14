import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AdmZip from "adm-zip";
import {
  configureCredentialCipherForTests,
  configureCredentialsRoot,
  configureLegacyKeyBridgeForTests,
  readApiKeyFromStore,
  writeApiKeyToStore,
} from "../../llm/credentials.js";
import { parseToolsConfig } from "../../toolsConfig/types.js";
import { readWorkspaceSettings } from "../readWorkspaceSettings.js";
import { writeWorkspaceSettings } from "../writeWorkspaceSettings.js";
import {
  BackupFormatError,
  BUNDLE_HEADER_ENTRY,
  BUNDLE_PAYLOAD_ENTRY,
  buildBackupBundle,
  openBackupPayload,
  payloadSections,
  readBackupHeader,
  type BackupPayload,
} from "./bundle.js";
import { BackupPassphraseError, encryptBackupPayload } from "./crypto.js";
import { collectBackup } from "./collectBackup.js";
import { applyBackup } from "./applyBackup.js";

const PLAIN_CIPHER = {
  mode: "plain" as const,
  encrypt: (s: string) => Buffer.from(s, "utf8").toString("base64"),
  decrypt: (p: string) => Buffer.from(p, "base64").toString("utf8"),
};

const PASSPHRASE = "pass-123";
const APP_VERSION = "0.7.0-test";

const LOGO_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xd3, 0x7f,
]);

const FSM_GRAPH_BODY = `${JSON.stringify({ nodes: [1, 2, 3] }, null, 2)}\n`;
const FSM_INDEX_BODY = `${JSON.stringify({ version: 1, order: ["graph-1"] }, null, 2)}\n`;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("backup bundle round trip", () => {
  let sourceRoot = "";
  let targetRoot = "";
  let payload: BackupPayload;
  let bundleBytes: Buffer;

  before(async () => {
    sourceRoot = mkdtempSync(join(tmpdir(), "jb-bk-src-"));

    // settings.json — through the sanctioned writer.
    await writeWorkspaceSettings(sourceRoot, {
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          modelId: "deepseek-v4-flash",
        },
      ],
      activeProviderId: "deepseek",
      themeId: "light",
      contextLimitTokens: 200_000,
    });

    // tools.json — raw file with an MCP URL that embeds a key.
    await writeFile(
      join(sourceRoot, "tools.json"),
      `${JSON.stringify(
        {
          version: 1,
          mcpServers: [
            {
              id: "tavily",
              name: "Tavily",
              enabled: true,
              transport: {
                type: "http",
                url: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-secret",
              },
            },
          ],
          skills: [{ id: "uuid-1", name: "futuapi", enabled: true }],
          toolPermissionOverrides: { run_shell: 2 },
          shellSafety: { enabled: true, fatalPolicy: "ask" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // skills — one package (incl. binary asset) + one dir without SKILL.md.
    await mkdir(join(sourceRoot, "skills/futuapi/scripts"), { recursive: true });
    await mkdir(join(sourceRoot, "skills/futuapi/assets"), { recursive: true });
    await mkdir(join(sourceRoot, "skills/notaskill"), { recursive: true });
    await writeFile(
      join(sourceRoot, "skills/futuapi/SKILL.md"),
      "---\nname: futuapi\n---\n\nFutu market data.\n",
      "utf8",
    );
    await writeFile(
      join(sourceRoot, "skills/futuapi/scripts/run.py"),
      "print('hi')\n",
      "utf8",
    );
    await writeFile(join(sourceRoot, "skills/futuapi/assets/logo.bin"), LOGO_BYTES);
    await writeFile(
      join(sourceRoot, "skills/notaskill/README.md"),
      "no SKILL.md here\n",
      "utf8",
    );

    // user-memory.json
    await writeFile(
      join(sourceRoot, "user-memory.json"),
      `${JSON.stringify({ version: 1, updatedAt: 1_700_000_000_123, profile: "Joji test profile" })}\n`,
      "utf8",
    );

    // fsm-graphs — real files + a .bak that must be excluded.
    await mkdir(join(sourceRoot, "fsm-graphs"), { recursive: true });
    await writeFile(join(sourceRoot, "fsm-graphs/graph-1.json"), FSM_GRAPH_BODY, "utf8");
    await writeFile(join(sourceRoot, "fsm-graphs/index.json"), FSM_INDEX_BODY, "utf8");
    await writeFile(
      join(sourceRoot, "fsm-graphs/graph-1.json.bak-20260829"),
      "stale\n",
      "utf8",
    );

    // credentials — plain cipher keeps the test off OS keychains.
    configureCredentialsRoot(sourceRoot);
    configureCredentialCipherForTests(PLAIN_CIPHER);
    configureLegacyKeyBridgeForTests(null);
    await writeApiKeyToStore("sk-chat-xyz", "deepseek");
    await writeApiKeyToStore("sk-cos-secret", "object-storage");

    payload = await collectBackup({ userDataRoot: sourceRoot });
    bundleBytes = buildBackupBundle(payload, PASSPHRASE, APP_VERSION);
  });

  after(async () => {
    configureCredentialCipherForTests(undefined);
    configureLegacyKeyBridgeForTests(undefined);
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  it("collects all six sections, excluding non-packages and .bak files", () => {
    assert.deepEqual(payloadSections(payload), [
      "settings",
      "tools",
      "secrets",
      "skills",
      "userMemory",
      "fsmGraphs",
    ]);
    assert.ok(payload.settings);
    assert.ok(payload.tools);
    assert.ok(payload.secrets);
    assert.ok(payload.skills);
    assert.ok(payload.userMemory);
    assert.ok(payload.fsmGraphs);

    assert.deepEqual(Object.keys(payload.secrets!.keys).sort(), [
      "deepseek",
      "object-storage",
    ]);
    assert.deepEqual(
      payload.skills!.map((s) => s.name),
      ["futuapi"],
    );
    assert.deepEqual(
      payload.skills![0]!.files.map((f) => f.path).sort(),
      ["SKILL.md", "assets/logo.bin", "scripts/run.py"],
    );
    assert.deepEqual(
      payload.fsmGraphs!.map((f) => f.path).sort(),
      ["graph-1.json", "index.json"],
    );
  });

  it("seals the bundle: no plaintext secrets anywhere in the bytes", () => {
    const haystack = bundleBytes.toString("latin1");
    assert.ok(!haystack.includes("sk-chat-xyz"));
    assert.ok(!haystack.includes("sk-cos-secret"));
    assert.ok(!haystack.includes("tvly-secret"));
    assert.ok(!haystack.includes("Joji test profile"));
  });

  it("reads a plaintext header summary without the passphrase", () => {
    const header = readBackupHeader(bundleBytes);
    assert.equal(header.format, "jellybot-backup");
    assert.equal(header.version, 2);
    assert.equal(header.appVersion, APP_VERSION);
    assert.equal(header.sections.length, 6);
    assert.ok(!Number.isNaN(Date.parse(header.exportedAt)));
  });

  it("rejects a wrong passphrase", () => {
    assert.throws(
      () => openBackupPayload(bundleBytes, "wrong-pass"),
      BackupPassphraseError,
    );
  });

  it("applies to a fresh root and restores everything byte-exact", async () => {
    targetRoot = mkdtempSync(join(tmpdir(), "jb-bk-dst-"));
    // applyBackup writes API keys via the module-global credentials root —
    // point it at the target root BEFORE applying (same contract as main).
    configureCredentialsRoot(targetRoot);
    const restored = openBackupPayload(bundleBytes, PASSPHRASE);
    assert.deepEqual(restored, payload);

    const result = await applyBackup(restored, { userDataRoot: targetRoot });
    assert.deepEqual(result.applied.sort(), [
      "fsmGraphs",
      "secrets",
      "settings",
      "skills",
      "tools",
      "userMemory",
    ]);

    // settings
    const settings = await readWorkspaceSettings(targetRoot);
    assert.equal(settings?.themeId, "light");
    assert.equal(settings?.providers[0]?.id, "deepseek");
    assert.equal(settings?.contextLimitTokens, 200_000);

    // tools (MCP URL with embedded key survives)
    const toolsRaw = await readFile(join(targetRoot, "tools.json"), "utf8");
    const tools = parseToolsConfig(JSON.parse(toolsRaw));
    assert.equal(tools.mcpServers[0]?.id, "tavily");
    assert.equal(
      tools.mcpServers[0]?.transport.type === "http"
        ? tools.mcpServers[0].transport.url
        : "",
      "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-secret",
    );
    assert.deepEqual(tools.shellSafety, { enabled: true, fatalPolicy: "ask" });

    // secrets re-encrypted into this root's store
    assert.equal(await readApiKeyFromStore("deepseek"), "sk-chat-xyz");
    assert.equal(await readApiKeyFromStore("object-storage"), "sk-cos-secret");

    // skills — text + binary byte-exact; non-package not restored
    assert.equal(
      await readFile(join(targetRoot, "skills/futuapi/SKILL.md"), "utf8"),
      "---\nname: futuapi\n---\n\nFutu market data.\n",
    );
    const logo = await readFile(join(targetRoot, "skills/futuapi/assets/logo.bin"));
    assert.equal(Buffer.compare(logo, LOGO_BYTES), 0);
    assert.ok(!(await pathExists(join(targetRoot, "skills/notaskill"))));

    // user memory
    const memory = JSON.parse(
      await readFile(join(targetRoot, "user-memory.json"), "utf8"),
    ) as { updatedAt: number; profile: string };
    assert.equal(memory.updatedAt, 1_700_000_000_123);
    assert.equal(memory.profile, "Joji test profile");

    // fsm graphs — exactly the two real files, no .bak copies
    assert.equal(
      await readFile(join(targetRoot, "fsm-graphs/graph-1.json"), "utf8"),
      FSM_GRAPH_BODY,
    );
    assert.equal(
      await readFile(join(targetRoot, "fsm-graphs/index.json"), "utf8"),
      FSM_INDEX_BODY,
    );
    assert.deepEqual(
      (await readdir(join(targetRoot, "fsm-graphs"))).sort(),
      ["graph-1.json", "index.json"],
    );
  });

  it("re-apply over an existing root backs up replaced files first", async () => {
    const restored = openBackupPayload(bundleBytes, PASSPHRASE);
    const result = await applyBackup(restored, { userDataRoot: targetRoot });
    assert.ok(result.backups.length >= 3);
    const names = await readdir(targetRoot);
    assert.ok(names.some((n) => /^settings\.json\.bak-/.test(n)));
    assert.ok(names.some((n) => /^tools\.json\.bak-/.test(n)));
    assert.ok(names.some((n) => /^llm-api-keys\.json\.bak-/.test(n)));
    const skillsDir = await readdir(join(targetRoot, "skills"));
    assert.ok(skillsDir.some((n) => /^futuapi\.bak-/.test(n)));
    // The live copies are still there and intact.
    assert.ok(await pathExists(join(targetRoot, "skills/futuapi/SKILL.md")));
    assert.ok(await pathExists(join(targetRoot, "settings.json")));
  });

  it("rejects non-zip bytes and missing entries", () => {
    assert.throws(
      () => readBackupHeader(Buffer.from("this is not a zip")),
      BackupFormatError,
    );
    const headerOnly = new AdmZip();
    headerOnly.addFile(
      BUNDLE_HEADER_ENTRY,
      Buffer.from(
        `${JSON.stringify({
          format: "jellybot-backup",
          version: 1,
          exportedAt: new Date().toISOString(),
          appVersion: "0.0.0",
          sections: ["settings"],
        })}\n`,
        "utf8",
      ),
    );
    assert.throws(
      () => openBackupPayload(headerOnly.toBuffer(), PASSPHRASE),
      BackupFormatError,
    );
  });

  it("rejects future bundle versions outright", () => {
    const zip = new AdmZip();
    zip.addFile(
      BUNDLE_HEADER_ENTRY,
      Buffer.from(
        `${JSON.stringify({
          format: "jellybot-backup",
          version: 99,
          exportedAt: new Date().toISOString(),
          appVersion: "9.9.9",
          sections: ["settings"],
        })}\n`,
        "utf8",
      ),
    );
    assert.throws(
      () => readBackupHeader(zip.toBuffer()),
      /Unsupported backup version/,
    );
  });

  it("rejects invalid payload shapes after decryption", () => {
    const buildHandBundle = (payloadObject: unknown): Buffer => {
      const zip = new AdmZip();
      zip.addFile(
        BUNDLE_HEADER_ENTRY,
        Buffer.from(
          `${JSON.stringify({
            format: "jellybot-backup",
            version: 1,
            exportedAt: new Date().toISOString(),
            appVersion: "0.0.0",
            sections: ["settings"],
          })}\n`,
          "utf8",
        ),
      );
      zip.addFile(
        BUNDLE_PAYLOAD_ENTRY,
        Buffer.from(
          `${JSON.stringify(encryptBackupPayload(JSON.stringify(payloadObject), PASSPHRASE))}\n`,
          "utf8",
        ),
      );
      return zip.toBuffer();
    };

    // settings is a string, not an object
    assert.throws(
      () => openBackupPayload(buildHandBundle({ settings: "nope" }), PASSPHRASE),
      BackupFormatError,
    );
    // skill package without SKILL.md
    assert.throws(
      () =>
        openBackupPayload(
          buildHandBundle({
            skills: [
              {
                name: "ok-skill",
                files: [{ path: "readme.md", data: Buffer.from("x").toString("base64") }],
              },
            ],
          }),
          PASSPHRASE,
        ),
      BackupFormatError,
    );
    // traversal path inside a skill
    assert.throws(
      () =>
        openBackupPayload(
          buildHandBundle({
            skills: [
              {
                name: "ok-skill",
                files: [
                  { path: "SKILL.md", data: Buffer.from("x").toString("base64") },
                  { path: "../evil.txt", data: Buffer.from("x").toString("base64") },
                ],
              },
            ],
          }),
          PASSPHRASE,
        ),
      BackupFormatError,
    );
    // absolute path in fsmGraphs
    assert.throws(
      () =>
        openBackupPayload(
          buildHandBundle({
            fsmGraphs: [{ path: "/etc/passwd", data: Buffer.from("x").toString("base64") }],
          }),
          PASSPHRASE,
        ),
      BackupFormatError,
    );
    // cocoSettings is a string, not an object
    assert.throws(
      () =>
        openBackupPayload(
          buildHandBundle({ cocoSettings: "nope" }),
          PASSPHRASE,
        ),
      BackupFormatError,
    );
  });
});

describe("backup bundle v2 — CoCo settings section", () => {
  const COCO_SETTINGS = {
    enabled: true,
    providerId: "c48c7c45",
    fastProviderId: "",
    hourlyTokens: 120_000,
    dailyTokens: 2_000_000,
    timezone: "Asia/Shanghai",
    excludedWorkspaceIds: ["ws-local-1", "ws-local-2"],
    fullPermissions: true,
    heartbeatMinutes: 30,
    repairLimit: 3,
    reportTime: "09:30",
    historyRetentionDays: 90,
    compactTriggerRatio: 0.75,
    iterationProtectTokenRatio: 0.3,
  };

  it("collects cocoSettings via the injected reader and strips machine-local ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "jb-bk-coco-src-"));
    try {
      const payload = await collectBackup({
        userDataRoot: root,
        readCocoSettings: () => COCO_SETTINGS,
      });
      assert.ok(payload.cocoSettings);
      assert.ok(!("excludedWorkspaceIds" in payload.cocoSettings));
      assert.equal(payload.cocoSettings.enabled, true);
      assert.equal(payload.cocoSettings.reportTime, "09:30");

      assert.deepEqual(payloadSections(payload), [
        "cocoSettings",
      ]);
      const bytes = buildBackupBundle(payload, PASSPHRASE, APP_VERSION);
      const header = readBackupHeader(bytes);
      assert.equal(header.version, 2);
      assert.deepEqual(header.sections, ["cocoSettings"]);
      const reopened = openBackupPayload(bytes, PASSPHRASE);
      assert.deepEqual(reopened.cocoSettings, payload.cocoSettings);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits the section when the reader is absent or yields nothing usable", async () => {
    const root = mkdtempSync(join(tmpdir(), "jb-bk-coco-none-"));
    try {
      const noReader = await collectBackup({ userDataRoot: root });
      assert.equal(noReader.cocoSettings, null);
      const throwing = await collectBackup({
        userDataRoot: root,
        readCocoSettings: () => {
          throw new Error("engine not ready");
        },
      });
      assert.equal(throwing.cocoSettings, null);
      const nonObject = await collectBackup({
        userDataRoot: root,
        readCocoSettings: () => "garbage",
      });
      assert.equal(nonObject.cocoSettings, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies cocoSettings through the injected writer and fails when it throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "jb-bk-coco-dst-"));
    try {
      const seen: unknown[] = [];
      const payload: BackupPayload = {
        settings: null,
        cocoSettings: { ...COCO_SETTINGS, excludedWorkspaceIds: [] },
        tools: null,
        secrets: null,
        skills: null,
        userMemory: null,
        fsmGraphs: null,
      };
      const result = await applyBackup(payload, {
        userDataRoot: root,
        writeCocoSettings: async (settings) => {
          seen.push(structuredClone(settings));
        },
      });
      assert.deepEqual(result.applied, ["cocoSettings"]);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], { ...COCO_SETTINGS, excludedWorkspaceIds: [] });

      // Writer failure fails the whole apply (existing error semantics).
      await assert.rejects(
        applyBackup(payload, {
          userDataRoot: root,
          writeCocoSettings: () => {
            throw new Error("validateSettings rejected");
          },
        }),
        /validateSettings rejected/,
      );

      // Section present but no writer wired → refuse before any write.
      await assert.rejects(
        applyBackup(payload, { userDataRoot: root }),
        BackupFormatError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reads v1 bundles (no cocoSettings section)", () => {
    const zip = new AdmZip();
    zip.addFile(
      BUNDLE_HEADER_ENTRY,
      Buffer.from(
        `${JSON.stringify({
          format: "jellybot-backup",
          version: 1,
          exportedAt: new Date().toISOString(),
          appVersion: "1.6.4",
          sections: ["settings"],
        })}\n`,
        "utf8",
      ),
    );
    zip.addFile(
      BUNDLE_PAYLOAD_ENTRY,
      Buffer.from(
        `${JSON.stringify(
          encryptBackupPayload(
            JSON.stringify({
              settings: {
                providers: [
                  {
                    id: "deepseek",
                    name: "DeepSeek",
                    baseUrl: "https://api.deepseek.com/v1",
                    modelId: "deepseek-v4-flash",
                  },
                ],
                activeProviderId: "deepseek",
              },
            }),
            PASSPHRASE,
          ),
        )}\n`,
        "utf8",
      ),
    );
    const header = readBackupHeader(zip.toBuffer());
    assert.equal(header.version, 1);
    const payload = openBackupPayload(zip.toBuffer(), PASSPHRASE);
    assert.equal(payload.cocoSettings, null);
    assert.equal(payload.settings?.activeProviderId, "deepseek");
  });
});
