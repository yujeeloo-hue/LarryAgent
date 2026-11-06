import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  LLM_REQUEST_TIMEOUT_MAX_MS,
  LLM_REQUEST_TIMEOUT_MIN_MS,
  resolveLlmRequestTimeoutMs,
  withSettingsDefaults,
} from "./types.js";
import { writeWorkspaceSettingsUnlocked } from "./writeWorkspaceSettings.js";

function baseSettings() {
  return {
    providers: [
      {
        id: "default",
        name: "Default",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4o-mini",
      },
    ],
    activeProviderId: "default",
  };
}

describe("llmRequestTimeoutMs settings", () => {
  it("survives a write → read → resolve round trip", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-timeout-"));
    await writeWorkspaceSettingsUnlocked(root, {
      ...baseSettings(),
      llmRequestTimeoutMs: 45_000,
    });

    const read = await readWorkspaceSettings(root);
    assert.equal(read?.llmRequestTimeoutMs, 45_000);

    const resolved = withSettingsDefaults(read);
    assert.equal(resolved.llmRequestTimeoutMs, 45_000);
  });

  it("falls back to the 30s default when unset or out of bounds", async () => {
    assert.equal(
      resolveLlmRequestTimeoutMs(null),
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
    assert.equal(
      resolveLlmRequestTimeoutMs({ ...baseSettings() }),
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
    // Below min / above max / non-finite are rejected by the resolver.
    assert.equal(
      resolveLlmRequestTimeoutMs({ ...baseSettings(), llmRequestTimeoutMs: 0 }),
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
    assert.equal(
      resolveLlmRequestTimeoutMs({
        ...baseSettings(),
        llmRequestTimeoutMs: LLM_REQUEST_TIMEOUT_MAX_MS + 1,
      }),
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
    assert.equal(
      resolveLlmRequestTimeoutMs({
        ...baseSettings(),
        llmRequestTimeoutMs: Number.NaN,
      }),
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
  });

  it("ignores out-of-bounds values at read time", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-timeout-bad-"));
    // Hand-craft an out-of-bounds file so write validation is bypassed.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ ...baseSettings(), llmRequestTimeoutMs: 700_000 }),
      "utf8",
    );
    const read = await readWorkspaceSettings(root);
    assert.equal(read?.llmRequestTimeoutMs, undefined);
    assert.equal(
      withSettingsDefaults(read).llmRequestTimeoutMs,
      DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    );
  });

  it("keeps bounds at 1s–600s", () => {
    assert.equal(LLM_REQUEST_TIMEOUT_MIN_MS, 1_000);
    assert.equal(LLM_REQUEST_TIMEOUT_MAX_MS, 600_000);
  });
});
