import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { parseDemoParams } from "../../session/demoParams.js";
export {
  isSliderNumberSpec,
  MAX_DEMO_PARAMS,
  parseDemoParams,
  sliderDecimals,
} from "../../session/demoParams.js";
export type {
  DemoParamSpec,
  DemoParamType,
  ParsedDemoParams,
} from "../../session/demoParams.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  isAbortError,
  resolveToolPath,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Raw demo HTML cap (plan D9): over → explicit error, never truncated. */
export const DEMO_HTML_MAX_BYTES = 1_000_000;

const DEMO_HTML_EXTS = new Set([".html", ".htm"]);

/** Default level: 0 — read-only display; the card never blocks the turn. */
export const presentDemoDefinition: ToolDefinition = {
  name: "present_demo",
  description:
    "Present a self-contained single-file HTML demo inline in the conversation, with a generated parameter form. Write the demo first with write_file (workspace convention: demos/<feature>/index.html; inline every asset — no relative files, and prefer no CDN/external resources: offline networks are not guaranteed). Declared params render as form controls (string, number, boolean, select, color) next to the embedded preview — number params with min/max render as a drag slider, so declare bounds whenever the value has a natural range; every change is posted into the page as postMessage({type: \"jellybot-demo-params\", values}) — apply values live with window.addEventListener(\"message\", (e) => { if (e.data?.type === \"jellybot-demo-params\") apply(e.data.values); }). values is keyed by param name and carries exactly the declared values — a select sends its option string verbatim (not a shorter alias), a number sends a number, a boolean true/false — so apply() must compare against those exact strings, or the preview silently ignores the change. The tool returns immediately (non-blocking): finish your turn after presenting. On Confirm the user's chosen values arrive as a user message formatted \"Demo confirmed [demo:<toolCallId>]:\" plus a JSON object of param values — use them to implement, or re-present an updated demo. Params are ONLY for choices that need the user's decision before implementation; anything used merely to demonstrate different states or scenarios in the preview (e.g. switching between loading / empty / error / success variants) must NOT be a param — build those into the page itself as its own controls (in-mockup buttons/tabs or URL hooks). params: [] renders a pure layout confirmation (preview + optional note + Confirm). Keep the card's title, prompt, and param labels in English (UI copy convention); demo page content may be any language. Main-conversation turns only (unavailable inside subagent turns).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to the demo HTML file (single-file, self-contained, .html).",
      },
      title: {
        type: "string",
        description: "Card title (defaults to the file name).",
      },
      prompt: {
        type: "string",
        description: "One-line guidance shown above the Confirm button.",
      },
      params: {
        type: "array",
        description:
          "Decision parameters rendered as a form on the card — only values the user must choose between. Do NOT include switches used just to demonstrate different states/scenarios; those belong inside the demo page as its own controls. Empty array (or omitted) = pure layout confirmation.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Param key in the confirmed JSON values object.",
            },
            label: {
              type: "string",
              description: "Human label for the form row (defaults to name).",
            },
            type: {
              type: "string",
              enum: ["string", "number", "boolean", "select", "color"],
              description: "Form control type.",
            },
            default: {
              description:
                "Initial value (required). Must match the control type; a select default must be one of options.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "select only: choice labels — at least 2, must include default.",
            },
            min: { type: "number", description: "number only: minimum value." },
            max: { type: "number", description: "number only: maximum value." },
            step: { type: "number", description: "number only: step increment." },
            placeholder: {
              type: "string",
              description: "string only: input placeholder.",
            },
            optional: {
              type: "boolean",
              description:
                "When true the value may be left empty (default false).",
            },
          },
          required: ["name", "type", "default"],
        },
      },
    },
    required: ["path"],
  },
  defaultPermissionLevel: 0,
};

export const presentDemoHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (context.subagentTurn === true) {
    return failureResult(
      "present_demo is main-turn only — present the demo from the main conversation (subagent windows have no confirm channel).",
      ToolReturnCode.GenericFailure,
    );
  }

  const pathArg = typeof args.path === "string" ? args.path : null;
  if (pathArg === null) {
    return failureResult(
      'Invalid arguments: "path" (absolute string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const parsedParams = parseDemoParams(args.params);
  if (!parsedParams.ok) {
    return failureResult(parsedParams.error, ToolReturnCode.InvalidArguments);
  }

  const resolved = resolveToolPath(pathArg, {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  });
  if (!resolved.ok) {
    return failureResult(resolved.reason, resolved.returnCode);
  }

  const absolute = resolved.path.absolute;
  const shown = displayPath(absolute);
  const ext = extname(absolute).toLowerCase();
  if (!DEMO_HTML_EXTS.has(ext)) {
    return failureResult(
      `Unsupported demo file type: ${shown}. Present a .html file (single-file, self-contained).`,
      ToolReturnCode.InvalidArguments,
    );
  }

  try {
    const info = await stat(absolute);
    const abortedAfterStat = abortIfSignaled(context.signal);
    if (abortedAfterStat) return abortedAfterStat;

    if (!info.isFile()) {
      return failureResult(
        `Not a file: ${shown}`,
        ToolReturnCode.InvalidArguments,
      );
    }
    if (info.size > DEMO_HTML_MAX_BYTES) {
      return failureResult(
        `Demo HTML is too large to present (${info.size} bytes > ${DEMO_HTML_MAX_BYTES} limit) — inline only what the demo needs.`,
        ToolReturnCode.GenericFailure,
      );
    }

    const html = await readFile(absolute);
    const abortedAfterRead = abortIfSignaled(context.signal);
    if (abortedAfterRead) return abortedAfterRead;

    const params = parsedParams.params;
    return {
      returnCode: ToolReturnCode.Success,
      content: [
        {
          type: "text",
          text:
            params.length > 0
              ? `Presented demo ${shown} (${params.length} settable params). Confirmed values will arrive as a user message.`
              : `Presented demo ${shown}. The user's confirmation will arrive as a user message.`,
        },
        {
          type: "attachment",
          kind: "file",
          uri: pathToFileURL(absolute).href,
          name: basename(absolute),
          mimeType: "text/html",
          sizeBytes: info.size,
          htmlBase64: html.toString("base64"),
        },
      ],
    };
  } catch (err) {
    if (isAbortError(err) || context.signal?.aborted) {
      return failureResult("Cancelled", ToolReturnCode.Cancelled);
    }
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return failureResult(`File not found: ${shown}`, ToolReturnCode.NotFound);
    }
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
