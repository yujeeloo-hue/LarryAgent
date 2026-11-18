
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { FSMConfigError } from "../FSMConfigError.js";

export const ROLE_PROMPT_FILE_PARAM = "rolePromptFile";
export const ROLE_PROMPT_INLINE_PARAM = "rolePromptInline";

export type PromptSourceKeys = {
  inline?: string;
  file?: string;
};

function readStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

export async function resolvePromptOverride(
  params: Record<string, unknown>,
  workspacePath?: string,
  keys: PromptSourceKeys = {},
): Promise<string | null> {
  const inlineKey = keys.inline ?? ROLE_PROMPT_INLINE_PARAM;
  const fileKey = keys.file ?? ROLE_PROMPT_FILE_PARAM;

  const inline = readStringParam(params, inlineKey);
  if (inline !== undefined && inline.trim()) return inline;

  const file = readStringParam(params, fileKey);
  if (file === undefined || !file.trim()) return null;
  const rawPath = file.trim();

  const resolved = isAbsolute(rawPath)
    ? rawPath
    : workspacePath && workspacePath.trim()
      ? join(workspacePath, rawPath)
      : null;
  if (!resolved) return null;

  try {
    const content = await readFile(resolved, "utf-8");
    return content.trim() ? content : null;
  } catch (cause) {
    throw new FSMConfigError(
      "ROLE_PROMPT_FILE_UNREADABLE",
      `Cannot read prompt file "${resolved}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}
