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

export const DEMO_HTML_MAX_BYTES = 1_000_000;

const DEMO_HTML_EXTS = new Set([".html", ".htm"]);

export const presentDemoDefinition: ToolDefinition = {
  name: "present_demo",
  description:
    "Present a self-contained single-file HTML demo inline with a generated parameter form. Write the file first with write_file (demos/<feature>/index.html; inline every asset, no CDN — offline networks aren't guaranteed). Params render as form controls beside the preview (a number with min/max becomes a slider); every change is posted into the page as postMessage({type: \"jellybot-demo-params\", values}), so apply it: window.addEventListener(\"message\", e => { if (e.data?.type === \"jellybot-demo-params\") apply(e.data.values); }) — values arrive exactly as declared (select = its option string, number = number, boolean = true/false). Returns immediately: end your turn. On Confirm you receive a user message \"Demo confirmed [demo:<id>]:\" plus the JSON values. Params are only for decisions the user must make before implementation — demo-only state switches belong inside the page; params:[] = layout confirmation. Card copy in English; page content any language. Main-conversation turns only.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to the demo .html.",
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
          "Only values the user must decide. Empty or omitted = pure layout confirmation.",
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
