import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { AttachmentPart } from "../../session/types.js";
import type { ToolExecuteContext } from "../types.js";
import {
  DEMO_HTML_MAX_BYTES,
  isSliderNumberSpec,
  MAX_DEMO_PARAMS,
  parseDemoParams,
  presentDemoHandler,
  sliderDecimals,
} from "./presentDemo.js";

let TMP = "";
let OUTSIDE = "";

before(() => {
  TMP = mkdtempSync(join(tmpdir(), "jb-presentdemo-"));
  OUTSIDE = mkdtempSync(join(tmpdir(), "jb-presentdemo-out-"));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

function ctx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
  return {
    workspacePath: TMP,
    fullPermissionsEnabled: true,
    sessionId: "present-demo-test",
    toolCallId: "call_present_demo_1",
    ...overrides,
  };
}

type HandlerResult = Awaited<ReturnType<typeof presentDemoHandler>>;

function textOf(result: HandlerResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function attachmentOf(result: HandlerResult): AttachmentPart | undefined {
  return result.content.find(
    (part): part is AttachmentPart => part.type === "attachment",
  );
}

function errorOf(parsed: ReturnType<typeof parseDemoParams>): string {
  return parsed.ok ? "" : parsed.error;
}

const DEMO_HTML = "<!doctype html><html><body><h1>Demo</h1></body></html>";

describe("parseDemoParams", () => {
  it("missing / null params → empty list", () => {
    assert.deepEqual(parseDemoParams(undefined), { ok: true, params: [] });
    assert.deepEqual(parseDemoParams(null), { ok: true, params: [] });
  });

  it("rejects non-array params", () => {
    assert.match(errorOf(parseDemoParams("x")), /must be an array/);
  });

  it("normalizes labels and trims select options", () => {
    const parsed = parseDemoParams([
      {
        name: "density",
        type: "select",
        default: "compact",
        options: [" compact ", "cozy"],
      },
      { name: "height", type: "number", default: 28, min: 20, max: 44, step: 1 },
    ]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.params[0]!.label, "density");
    assert.deepEqual(parsed.params[0]!.options, ["compact", "cozy"]);
    assert.equal(parsed.params[0]!.default, "compact");
    assert.equal(parsed.params[1]!.min, 20);
    assert.equal(parsed.params[1]!.max, 44);
  });

  it("rejects duplicate names", () => {
    const parsed = parseDemoParams([
      { name: "a", type: "string", default: "x" },
      { name: "a", type: "string", default: "y" },
    ]);
    assert.match(errorOf(parsed), /duplicated/);
  });

  it("marks bounded numbers as slider specs and derives readout decimals", () => {
    const spec = (over: Record<string, unknown>) =>
      ({ name: "a", label: "a", type: "number", default: 1, ...over }) as never;
    assert.equal(isSliderNumberSpec(spec({ min: 0, max: 10 })), true);
    assert.equal(isSliderNumberSpec(spec({})), false);
    assert.equal(isSliderNumberSpec(spec({ min: 5, max: 5 })), false);
    assert.equal(isSliderNumberSpec(spec({ min: 5, max: 1 })), false);
    assert.equal(sliderDecimals(1), 0);
    assert.equal(sliderDecimals(0.05), 2);
    assert.equal(sliderDecimals(undefined), 0);
    assert.equal(sliderDecimals(-1), 0);
  });

  it("rejects unknown control type", () => {
    const parsed = parseDemoParams([{ name: "a", type: "range", default: 1 }]);
    assert.match(errorOf(parsed), /type must be one of/);
  });

  it("rejects number default with wrong type", () => {
    const parsed = parseDemoParams([
      { name: "h", type: "number", default: "28" },
    ]);
    assert.match(errorOf(parsed), /params\[0\]\.default must be a finite number/);
  });

  it("rejects boolean default with wrong type", () => {
    const parsed = parseDemoParams([
      { name: "on", type: "boolean", default: "yes" },
    ]);
    assert.match(errorOf(parsed), /must be a boolean/);
  });

  it("rejects select with fewer than 2 options", () => {
    const parsed = parseDemoParams([
      { name: "d", type: "select", default: "a", options: ["a"] },
    ]);
    assert.match(errorOf(parsed), /at least 2 choices/);
  });

  it("rejects select default not among options", () => {
    const parsed = parseDemoParams([
      { name: "d", type: "select", default: "z", options: ["a", "b"] },
    ]);
    assert.match(errorOf(parsed), /not among/);
  });

  it("rejects min > max", () => {
    const parsed = parseDemoParams([
      { name: "h", type: "number", default: 5, min: 10, max: 4 },
    ]);
    assert.match(errorOf(parsed), /min must be ≤/);
  });

  it("rejects default outside the number bounds", () => {
    const below = parseDemoParams([
      { name: "h", type: "number", default: 10, min: 20 },
    ]);
    assert.match(errorOf(below), /below .*min/);
    const above = parseDemoParams([
      { name: "h", type: "number", default: 50, max: 44 },
    ]);
    assert.match(errorOf(above), /above .*max/);
  });

  it("rejects non-positive step", () => {
    const parsed = parseDemoParams([
      { name: "h", type: "number", default: 10, step: 0 },
    ]);
    assert.match(errorOf(parsed), /step must be a positive number/);
  });

  it("caps the declared param count", () => {
    const many = Array.from({ length: MAX_DEMO_PARAMS + 1 }, (_, i) => ({
      name: `p${i}`,
      type: "string",
      default: "v",
    }));
    assert.match(errorOf(parseDemoParams(many)), /at most/);
  });
});

describe("presentDemoHandler", () => {
  it("requires path", async () => {
    const result = await presentDemoHandler({}, ctx());
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(textOf(result), /"path"/);
  });

  it("refuses subagent turns", async () => {
    const p = join(TMP, "demo.html");
    writeFileSync(p, DEMO_HTML);
    const result = await presentDemoHandler(
      { path: p },
      ctx({ subagentTurn: true }),
    );
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    assert.match(textOf(result), /main-turn only/);
  });

  it("requires an .html file", async () => {
    const p = join(TMP, "demo.txt");
    writeFileSync(p, "not html");
    const result = await presentDemoHandler({ path: p }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(textOf(result), /\.html/);
  });

  it("missing file → NotFound", async () => {
    const result = await presentDemoHandler(
      { path: join(TMP, "missing.html") },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.NotFound);
  });

  it("rejects outside-workspace paths without bypass", async () => {
    const p = join(OUTSIDE, "demo.html");
    writeFileSync(p, DEMO_HTML);
    const result = await presentDemoHandler(
      { path: p },
      ctx({ fullPermissionsEnabled: false }),
    );
    assert.equal(result.returnCode, ToolReturnCode.PermissionDenied);
  });

  it("success: text + inline html attachment", async () => {
    const p = join(TMP, "demo.html");
    writeFileSync(p, DEMO_HTML);
    const result = await presentDemoHandler(
      {
        path: p,
        params: [
          { name: "height", type: "number", default: 28, min: 20, max: 44 },
          { name: "accent", type: "color", default: "#3b82f6" },
        ],
      },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(
      textOf(result),
      /Presented demo .*demo\.html \(2 settable params\)/,
    );
    const att = attachmentOf(result);
    assert.ok(att, "attachment part exists");
    assert.equal(att!.kind, "file");
    assert.equal(att!.mimeType, "text/html");
    assert.ok(att!.uri.startsWith("file://"));
    assert.equal(att!.name, "demo.html");
    assert.equal(att!.sizeBytes, Buffer.byteLength(DEMO_HTML));
    assert.equal(
      Buffer.from(att!.htmlBase64 ?? "", "base64").toString("utf8"),
      DEMO_HTML,
    );
  });

  it("zero params: pure layout confirmation text", async () => {
    const p = join(TMP, "layout.html");
    writeFileSync(p, DEMO_HTML);
    const result = await presentDemoHandler({ path: p }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.doesNotMatch(textOf(result), /settable params/);
    assert.match(textOf(result), /confirmation will arrive/);
    assert.ok(attachmentOf(result));
  });

  it("rejects demo HTML over the 1 MB cap", async () => {
    const p = join(TMP, "big.html");
    writeFileSync(p, `<!--${"a".repeat(DEMO_HTML_MAX_BYTES)}-->`);
    const result = await presentDemoHandler({ path: p }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    assert.match(textOf(result), /too large/);
  });

  it("invalid params surface the field error", async () => {
    const p = join(TMP, "demo2.html");
    writeFileSync(p, DEMO_HTML);
    const result = await presentDemoHandler(
      { path: p, params: [{ name: "x", type: "number", default: "nope" }] },
      ctx(),
    );
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(textOf(result), /params\[0\]\.default/);
  });
});
