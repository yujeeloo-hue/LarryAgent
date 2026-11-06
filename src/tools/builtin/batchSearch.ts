import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  cancelledResult,
  failureResult,
  textResult,
} from "../pathUtil.js";
import { runGrep } from "./grep.js";
import { runSymbolSearch } from "./symbols.js";

const MAX_QUERIES = 10;

/** Default level: 0. */
export const batchSearchDefinition: ToolDefinition = {
  name: "batch_search",
  description:
    "Run multiple searches in one call: content greps ({pattern}) and " +
    "workspace symbol-index lookups ({symbols}) can be mixed freely.",
  parameters: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description:
                "Content search pattern (JavaScript RegExp) — use for references and arbitrary text.",
            },
            symbols: {
              type: "string",
              description:
                "Symbol name lookup over the workspace symbol index (C++/TS/JS/CSS definitions, e.g. createTurnHost, .toolbar) — use for 'where is X defined'.",
            },
            kind: {
              type: "string",
              description:
                'Optional symbol kind filter: "class" | "interface" | "struct" | "enum" | "type" | "function" | "variable" (symbols queries only).',
            },
            path: {
              type: "string",
              description: "Optional absolute path to limit this query.",
            },
          },
          additionalProperties: false,
          description:
            "Provide exactly one of pattern (content grep) or symbols (index lookup) per query.",
        },
        description: "One or more search queries to run (min 1).",
      },
    },
    required: ["queries"],
  },
  defaultPermissionLevel: 0,
};

type BatchQuery =
  | { mode: "grep"; pattern: string; path?: string }
  | { mode: "symbols"; query: string; kind?: string; path?: string };

function readQuery(
  value: unknown,
): { query: BatchQuery } | { error: string } {
  if (!value || typeof value !== "object") {
    return { error: "each query must be an object" };
  }
  const obj = value as JsonObject;
  const hasPattern =
    typeof obj.pattern === "string" && obj.pattern.length > 0;
  const hasSymbols =
    typeof obj.symbols === "string" && obj.symbols.trim().length > 0;
  if (hasPattern && hasSymbols) {
    return { error: "provide only one of pattern or symbols per query" };
  }
  if (!hasPattern && !hasSymbols) {
    return { error: "pattern or symbols (string) required" };
  }
  const path =
    typeof obj.path === "string" && obj.path.trim().length > 0
      ? obj.path
      : undefined;

  if (hasPattern) {
    return { query: { mode: "grep", pattern: obj.pattern as string, ...(path !== undefined ? { path } : {}) } };
  }
  const query = { mode: "symbols" as const, query: (obj.symbols as string).trim(), ...(path !== undefined ? { path } : {}) };
  if (typeof obj.kind === "string" && obj.kind.trim().length > 0) {
    return { query: { ...query, kind: obj.kind.trim() } };
  }
  return { query };
}

function sectionLabel(query: BatchQuery): string {
  if (query.mode === "grep") {
    return `${query.pattern}${query.path ? ` @ ${query.path}` : ""}`;
  }
  const bits = [`symbols:"${query.query}"`];
  if (query.kind) bits.push(`kind=${query.kind}`);
  if (query.path) bits.push(`@ ${query.path}`);
  return bits.join(" ");
}

export const batchSearchHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const queriesRaw = args.queries;
  if (!Array.isArray(queriesRaw)) {
    return failureResult(
      'Invalid arguments: "queries" (array) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (queriesRaw.length === 0) {
    return failureResult(
      'Invalid arguments: "queries" must contain at least one query.',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (queriesRaw.length > MAX_QUERIES) {
    return failureResult(
      `Too many queries (${queriesRaw.length}; max ${MAX_QUERIES}).`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const sections: string[] = [];
  let anyFailure = false;
  for (const raw of queriesRaw) {
    const midAbort = abortIfSignaled(context.signal);
    if (midAbort) return midAbort;

    const parsed = readQuery(raw);
    if ("error" in parsed) {
      anyFailure = true;
      sections.push(`===== invalid query =====\nERROR: ${parsed.error}`);
      continue;
    }
    const query = parsed.query;

    let result: { text: string; returnCode: number };
    if (query.mode === "grep") {
      result = await runGrep({
        pattern: query.pattern,
        context,
        ...(query.path !== undefined ? { path: query.path } : {}),
      });
      if (result.returnCode === ToolReturnCode.Cancelled) {
        return cancelledResult(result.text);
      }
    } else {
      result = await runSymbolSearch({
        query: query.query,
        kind: query.kind,
        path: query.path,
        context,
      });
    }
    if (result.returnCode !== ToolReturnCode.Success) {
      anyFailure = true;
    }
    sections.push(`===== ${sectionLabel(query)} =====\n${result.text}`);
  }

  return textResult(
    sections.join("\n\n"),
    anyFailure ? ToolReturnCode.GenericFailure : ToolReturnCode.Success,
  );
};
