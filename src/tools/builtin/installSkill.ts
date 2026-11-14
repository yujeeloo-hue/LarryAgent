import { isAbsolute, resolve } from "node:path";
import { skillManager } from "../../skills/manager.js";
import { formatSkillSummary } from "../../skills/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 1 (full-permissions gate). */
export const installSkillDefinition: ToolDefinition = {
  name: "install_skill",
  description: "Install skill packages from a local zip.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to a .zip skill package.",
      },
      overwrite: {
        type: "boolean",
        description: "Replace existing skills with the same name. Default false.",
      },
      enabled: {
        type: "boolean",
        description: "Enable installed skills in the catalog. Default true.",
      },
      name: {
        type: "string",
        description: "Optional: install only this skill slug from a multi-pack zip.",
      },
    },
    required: ["path"],
  },
  defaultPermissionLevel: 1,
};

export const installSkillHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const pathRaw = typeof args.path === "string" ? args.path.trim() : "";
  if (!pathRaw) {
    return failureResult(
      'Invalid arguments: "path" (absolute zip path) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (!isAbsolute(pathRaw)) {
    return failureResult(
      'Invalid arguments: "path" must be an absolute file path.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const zipPath = resolve(pathRaw);
  if (!zipPath.toLowerCase().endsWith(".zip")) {
    return failureResult(
      'Invalid arguments: "path" must point to a .zip file.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const overwrite =
    typeof args.overwrite === "boolean" ? args.overwrite : false;
  const enabled = typeof args.enabled === "boolean" ? args.enabled : true;
  const name =
    typeof args.name === "string" && args.name.trim()
      ? args.name.trim()
      : undefined;

  try {
    const result = await skillManager.installFromZip(zipPath, {
      overwrite,
      enabled,
      name,
    });
    try {
      await skillManager.reloadFromDisk();
    } catch (err) {
      console.error("[skills] reloadFromDisk failed after install", err);
    }
    const lines = result.installed.map((r) => formatSkillSummary(r));
    const overwritten =
      result.overwritten.length > 0
        ? `\nOverwritten: ${result.overwritten.join(", ")}`
        : "";
    return textResult(
      `Installed ${result.installed.length} skill(s) from ${zipPath}.${overwritten}\n\n${lines.join("\n\n")}`,
      ToolReturnCode.Success,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to install skill.";
    const notFound = /not found/i.test(message);
    return failureResult(
      message,
      notFound ? ToolReturnCode.NotFound : ToolReturnCode.GenericFailure,
    );
  }
};
