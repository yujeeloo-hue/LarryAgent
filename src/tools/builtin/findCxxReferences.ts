/**
 * `find_cxx_references` — compiler-accurate C++ references via the hosted
 * clangd engine (LSP `textDocument/references`).
 *
 * Unlike grep / the text index this resolves overloads, templates and
 * Unreal reflection macros (UCLASS/UPROPERTY, DECLARE_* delegates expand
 * to real references) and never confuses same-named symbols of different
 * classes. Requires a UBT-generated compile_commands.json
 * (`Build.bat -Mode=GenerateClangDatabase`); when the workspace has none,
 * the tool says so and points at grep instead of retrying.
 */

import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ClangdReferencesResult } from "../../main/clangd/types.js";
import type {
  ToolDefinition,
  ToolHandler,
} from "../types.js";
import {
  abortIfSignaled,
  displayPath,
  resolveToolPath,
  textResult,
  workspaceRootAbsolute,
} from "../pathUtil.js";

/** Structural slice of ClangdService — injected by main at startup. */
type ClangdServiceLike = {
  references(
    rootPath: string,
    request: {
      path: string;
      line: number;
      column?: number;
      symbol?: string;
      text?: string;
    },
  ): Promise<ClangdReferencesResult>;
  status(rootPath: string): Promise<
    | {
        ok: true;
        clangdPath: string;
        compileCommandsDir: string;
        engineRoot: string | null;
        running: boolean;
      }
    | { ok: false; message: string }
  >;
};

let clangdService: ClangdServiceLike | null = null;

/** Wire the running ClangdService singleton (Electron main). */
export function configureClangdService(service: ClangdServiceLike | null): void {
  clangdService = service;
}

const MAX_REFERENCES = 200;
const MAX_ROW_CHARS = 240;

export const findCxxReferencesDefinition: ToolDefinition = {
  name: "find_cxx_references",
  description:
    "Find all compiled references to the C++ symbol at a file position using clangd " +
    "(compiler-accurate: resolves overloads, templates, and Unreal reflection macros; " +
    "never confuses same-named symbols of different classes). Requires the workspace's " +
    "compile_commands.json (Unreal: Build.bat -Mode=GenerateClangDatabase). " +
    "Prefer this over grep when refactoring C++; fall back to grep for non-C++ files " +
    "or when it reports the engine as unavailable.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path of the file containing the symbol (use with read_file offsets).",
      },
      line: {
        type: "integer",
        description: "1-based line number of the symbol.",
      },
      column: {
        type: "integer",
        description:
          "1-based column of the symbol. Optional — omit and pass `symbol` to auto-locate it on the line.",
      },
      symbol: {
        type: "string",
        description:
          "Symbol name to locate on `line` when `column` is omitted.",
      },
    },
    required: ["path", "line"],
  },
  defaultPermissionLevel: 0,
};

export const findCxxReferencesHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!clangdService) {
    return textResult(
      "The clangd engine is unavailable in this host. Use grep for references.",
      ToolReturnCode.GenericFailure,
    );
  }
  const pathArg = typeof args.path === "string" ? args.path.trim() : "";
  if (!pathArg || typeof args.line !== "number") {
    return textResult(
      'Invalid arguments: "path" (string) and "line" (1-based number) are required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const root = workspaceRootAbsolute(context.workspacePath);
  const resolvedPath = resolveToolPath(pathArg, {
    workspacePath: root,
    allowOutsideWorkspace: true,
  });
  if (!resolvedPath.ok) {
    return textResult(
      `Invalid arguments: ${resolvedPath.reason}`,
      resolvedPath.returnCode,
    );
  }
  const request = {
    path: resolvedPath.path.absolute,
    line: args.line,
    ...(typeof args.column === "number" ? { column: args.column } : {}),
    ...(typeof args.symbol === "string" && args.symbol.trim()
      ? { symbol: args.symbol.trim() }
      : {}),
  };
  const result = await clangdService.references(root, request);
  if (abortIfSignaled(context.signal)) {
    return textResult("Cancelled.", ToolReturnCode.Cancelled);
  }
  if (!result.ok) {
    return textResult(
      `find_cxx_references failed: ${result.message}\n` +
        "Falling back is recommended: use grep for this turn.",
      ToolReturnCode.GenericFailure,
    );
  }
  const shownRoot = displayPath(root);
  const headerBase = `clangd references in ${shownRoot} — ${result.references.length} hit(s)`;
  if (result.references.length === 0) {
    return textResult(
      `${headerBase}\n(no matches — the symbol has no other users)`,
      ToolReturnCode.Success,
    );
  }
  const rows = result.references.slice(0, MAX_REFERENCES).map((ref) => {
    const label = `${displayPath(ref.path)}:${ref.line}:${ref.column}`;
    return label.length > MAX_ROW_CHARS
      ? `${label.slice(0, MAX_ROW_CHARS)}…`
      : label;
  });
  const notes =
    result.references.length > MAX_REFERENCES
      ? ` (truncated: showing first ${MAX_REFERENCES})`
      : "";
  return textResult(
    `${headerBase}${notes}\n${rows.join("\n")}`,
    ToolReturnCode.Success,
  );
};


