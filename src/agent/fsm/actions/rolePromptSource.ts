/**
 * Shared dual-source prompt override resolution for role-related NodeActions.
 *
 * Priority: inline param > file param > built-in default (null).
 * Replacement semantics: the resolved body fully replaces the built-in
 * role template — it must carry any behavior instructions (step claims,
 * routing cooperation) the role needs.
 *
 * File paths: absolute, or relative to the workspace root. Without a
 * workspace root (stub path), relative paths defer (null) so in-memory
 * graphs stay runnable; absolute paths still resolve and surface config
 * errors early.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { FSMConfigError } from "../FSMConfigError.js";

export const ROLE_PROMPT_FILE_PARAM = "rolePromptFile";
export const ROLE_PROMPT_INLINE_PARAM = "rolePromptInline";

/** Custom param keys (e.g. SkillReflect reuses this as overlayFile/Inline). */
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

/**
 * Resolve a prompt override body, or null when unconfigured (fall back to
 * the built-in default template). Throws FSMConfigError
 * `ROLE_PROMPT_FILE_UNREADABLE` (message includes the path) when a
 * configured file cannot be read.
 */
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
  // Stub path without workspace root: relative file defers (not configured
  // yet); the host path resolves it against the real workspace root.
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
