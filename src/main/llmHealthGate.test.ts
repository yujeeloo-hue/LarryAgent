import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  checkLlmHealthGated,
  resetLlmHealthGateForTests,
  type LlmProbeResult,
} from "./llmHealthGate.js";
import {
  recordLlmEndpointActivity,
  llmActivityKey,
  resetLlmHealthActivityForTests,
} from "../llm/healthActivity.js";

const IDENTITY = llmActivityKey({
  endpointUrl: "https://gw.example.com/v2/chat/completions",
  apiKey: "k",
  model: "m",
});

afterEach(() => {
  resetLlmHealthGateForTests();
  resetLlmHealthActivityForTests();
});

function failingProbe(): () => Promise<LlmProbeResult> {
  return async () => {
    throw new Error("network down");
  };
}

describe("llm health gate", () => {
  it("recent activity short-circuits without probing", async () => {
    recordLlmEndpointActivity(IDENTITY, Date.now());
    let probeCalls = 0;
    const result = await checkLlmHealthGated(
      { identity: IDENTITY },
      {
        probe: async () => {
          probeCalls += 1;
          return { ok: false };
        },
      },
    );
    assert.equal(probeCalls, 0);
    assert.deepEqual(result, { ok: true, reason: "recent_activity" });
  });

  it("force bypasses the activity gate", async () => {
    recordLlmEndpointActivity(IDENTITY, Date.now());
    let probeCalls = 0;
    const result = await checkLlmHealthGated(
      { identity: IDENTITY, force: true },
      {
        probe: async () => {
          probeCalls += 1;
          return { ok: true };
        },
      },
    );
    assert.equal(probeCalls, 1);
    assert.equal(result.ok, true);
  });

  it("reuses a fresh finished probe for staggered duplicate callers", async () => {
    let probeCalls = 0;
    const probe = async (): Promise<LlmProbeResult> => {
      probeCalls += 1;
      return { ok: false, reason: "http_401" };
    };
    const first = await checkLlmHealthGated({ identity: IDENTITY }, { probe });
    const second = await checkLlmHealthGated({ identity: IDENTITY }, { probe });
    assert.equal(probeCalls, 1);
    assert.equal(first.ok, false);
    // The stored result — including its failure reason — is returned as-is.
    assert.equal(second.reason, "http_401");
    // Past the TTL a new probe runs.
    await checkLlmHealthGated(
      { identity: IDENTITY, probeResultTtlMs: -1 },
      { probe },
    );
    assert.equal(probeCalls, 2);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    let resolve!: (r: LlmProbeResult) => void;
    const gate = new Promise<LlmProbeResult>((r) => {
      resolve = r;
    });
    let probeCalls = 0;
    const probe = async (): Promise<LlmProbeResult> => {
      probeCalls += 1;
      return gate;
    };
    const p1 = checkLlmHealthGated({ identity: IDENTITY }, { probe });
    const p2 = checkLlmHealthGated({ identity: IDENTITY }, { probe });
    resolve({ ok: true });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(probeCalls, 1);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
  });

  it("probe rejection propagates and clears the in-flight slot", async () => {
    const first = checkLlmHealthGated(
      { identity: IDENTITY },
      { probe: failingProbe() },
    );
    const second = checkLlmHealthGated(
      { identity: IDENTITY },
      { probe: failingProbe() },
    );
    await assert.rejects(() => first, /network down/);
    await assert.rejects(() => second, /network down/);
    // Slot cleared — next call starts a fresh attempt instead of reusing.
    await assert.rejects(
      () =>
        checkLlmHealthGated({ identity: IDENTITY }, { probe: failingProbe() }),
      /network down/,
    );
  });
});
