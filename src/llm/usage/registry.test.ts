import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchUsageProviderKey,
  resolveUsageSources,
} from "./registry.js";
import type { ProviderUsageProfile } from "./types.js";

const KIMI_CODE: ProviderUsageProfile = {
  id: "p-kimi-code",
  name: "Kimi Code",
  baseUrl: "https://api.kimi.com/coding/v1",
};
const GLM: ProviderUsageProfile = {
  id: "p-glm",
  name: "GLM",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};
const KIMI: ProviderUsageProfile = {
  id: "p-kimi",
  name: "Kimi",
  baseUrl: "https://api.moonshot.cn/v1",
};
const DEEPSEEK: ProviderUsageProfile = {
  id: "p-deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
};
const OPENAI: ProviderUsageProfile = {
  id: "p-openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
};
const OPENROUTER: ProviderUsageProfile = {
  id: "p-openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
};
const QWEN: ProviderUsageProfile = {
  id: "p-qwen",
  name: "Qwen Code",
  baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
};
describe("matchUsageProviderKey", () => {
  it("maps the supported hosts and rejects others", () => {
    assert.equal(matchUsageProviderKey(KIMI_CODE.baseUrl), "kimi-code");
    assert.equal(matchUsageProviderKey(GLM.baseUrl), "glm-code");
    assert.equal(matchUsageProviderKey(KIMI.baseUrl), "kimi");
    assert.equal(matchUsageProviderKey(DEEPSEEK.baseUrl), "deepseek");
    assert.equal(matchUsageProviderKey(OPENROUTER.baseUrl), "openrouter");
    assert.equal(matchUsageProviderKey(QWEN.baseUrl), "qwen-code");
    assert.equal(
      matchUsageProviderKey("https://dashscope.aliyuncs.com/compatible-mode/v1"),
      null,
    );
    assert.equal(matchUsageProviderKey(OPENAI.baseUrl), null);
    assert.equal(matchUsageProviderKey("not a url"), null);
  });

  it("distinguishes api.kimi.com from api.moonshot.cn", () => {
    assert.equal(matchUsageProviderKey("https://api.kimi.com"), "kimi-code");
    assert.equal(matchUsageProviderKey("https://api.moonshot.cn/v1"), "kimi");
  });
});

describe("resolveUsageSources", () => {
  const keys = new Map<string, string>([
    ["p-kimi-code", "sk-kimi-x"],
    ["p-glm", "glm-key"],
    ["p-kimi", "sk-platform"],
    ["p-deepseek", "sk-ds"],
    ["p-openrouter", "sk-or"],
    ["p-qwen", "sk-sp"],
  ]);
  const readKey = (id: string): string | null => keys.get(id) ?? null;

  it("collects every supported provider", () => {
    const sources = resolveUsageSources(
      [KIMI_CODE, GLM, KIMI, DEEPSEEK, OPENROUTER, QWEN, OPENAI],
      readKey,
    );
    assert.deepEqual(
      sources.map((s) => s.adapter.key),
      ["kimi-code", "glm-code", "kimi", "deepseek", "openrouter", "qwen-code"],
    );
  });

  it("skips profiles without a stored key", () => {
    const sources = resolveUsageSources([GLM, DEEPSEEK], () => null);
    assert.deepEqual(sources, []);
  });

  it("dedupes per usage provider — first profile with a key wins", () => {
    const dup: ProviderUsageProfile = {
      id: "p-deepseek-2",
      name: "DeepSeek 2",
      baseUrl: "https://api.deepseek.com/v1",
    };
    const all = new Map(keys);
    all.set("p-deepseek-2", "sk-ds-2");
    const sources = resolveUsageSources([DEEPSEEK, dup], (id) =>
      all.get(id) ?? null,
    );
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.profile.id, "p-deepseek");
  });

  it("a duplicate without a key does not block a later keyed profile", () => {
    const dupNoKey: ProviderUsageProfile = {
      id: "p-deepseek-nokey",
      name: "DeepSeek no key",
      baseUrl: "https://api.deepseek.com",
    };
    const sources = resolveUsageSources([dupNoKey, DEEPSEEK], readKey);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.profile.id, "p-deepseek");
  });
});
