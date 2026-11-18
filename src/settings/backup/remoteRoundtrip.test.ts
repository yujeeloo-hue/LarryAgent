import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureCredentialsRoot,
  readApiKeyFromStore,
  writeApiKeyToStore,
} from "../../llm/credentials.js";
import { collectBackup } from "./collectBackup.js";
import { applyBackup } from "./applyBackup.js";

test("backup round-trips remote relay settings", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "jb-backup-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "jb-backup-b-"));
  configureCredentialsRoot(join(rootA, "credentials"));
  await mkdir(join(rootA, "credentials"), { recursive: true }).catch(() => {});

  const remote = {
    enabled: true,
    serverUrl: "https://relay.example.com/relay",
    deviceId: "dev-123",
    deviceName: "Mac Studio",
    mode: "full",
    pushActivity: "active",
  };
  await writeFile(
    join(rootA, "settings.json"),
    JSON.stringify({
      providers: [
        {
          id: "default",
          name: "Default",
          baseUrl: "https://api.deepseek.com/v1",
          modelId: "deepseek-v4-pro",
        },
      ],
      activeProviderId: "default",
      themeId: "dark",
      remote,
    }),
    "utf8",
  );

  await writeApiKeyToStore("jbk_test_relay_key", "remote-relay");

  const payload = await collectBackup({ userDataRoot: rootA });
  assert.ok(payload.settings, "settings section present");
  assert.deepEqual(
    payload.settings.remote,
    { enabled: true, serverUrl: "https://relay.example.com/relay", mode: "full", pushActivity: "active" },
    "remote exported minus device identity",
  );
  assert.ok(!("deviceId" in (payload.settings.remote ?? {})), "deviceId never exported");
  assert.ok(!("deviceName" in (payload.settings.remote ?? {})), "deviceName never exported");
  assert.equal(
    payload.secrets?.keys["remote-relay"],
    "jbk_test_relay_key",
    "relay key exported in secrets",
  );

  configureCredentialsRoot(join(rootB, "credentials"));
  await applyBackup(payload, { userDataRoot: rootB });
  assert.equal(
    await readApiKeyFromStore("remote-relay"),
    "jbk_test_relay_key",
    "relay key restored to credential store",
  );
  const restored = JSON.parse(await readFile(join(rootB, "settings.json"), "utf8"));
  assert.equal(restored.remote?.enabled, true);
  assert.equal(restored.remote?.serverUrl, "https://relay.example.com/relay");
  assert.equal(restored.remote?.deviceId, "");
  assert.equal(restored.remote?.deviceName, "");
  assert.equal(restored.remote?.mode, "full");
  assert.equal(restored.remote?.pushActivity, "active");
});
