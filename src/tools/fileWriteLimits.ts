import { createHash } from "node:crypto";

/**
 * Tools whose bulk text arg (`content` / `patch`) is stubbed on the
 * model wire (DB/UI keep full). Prevents write/V4A bodies from
 * re-entering Hot context on later iterations. Replace-mode
 * old_string/new_string stay on the wire so the model can retry.
 */
export const FILE_CONTENT_WIRE_STUB_TOOLS = new Set([
  "write_file",
  "patch",
  "write_plan_doc",
]);

/** Marker on wire-only stubs — not a callable tool argument. */
export const FILE_CONTENT_WIRE_OMITTED = "content_omitted" as const;

export type FileContentDigest = {
  contentChars: number;
  contentBytes: number;
  contentSha256: string;
};

export function digestFileContent(content: string): FileContentDigest {
  const contentBytes = Buffer.byteLength(content, "utf8");
  const contentSha256 = createHash("sha256")
    .update(content, "utf8")
    .digest("hex")
    .slice(0, 12);
  return {
    contentChars: content.length,
    contentBytes,
    contentSha256,
  };
}

/**
 * Model-wire replacement for write `content`.
 * No fake `content` string — models must not re-submit this as a tool call.
 */
export function stubFileContentArgsForWire(args: {
  path?: unknown;
  content: string;
}): Record<string, string | number> {
  const digest = digestFileContent(args.content);
  return {
    path: typeof args.path === "string" ? args.path : "",
    _wire: FILE_CONTENT_WIRE_OMITTED,
    contentChars: digest.contentChars,
    contentBytes: digest.contentBytes,
    contentSha256: digest.contentSha256,
  };
}

/**
 * Model-wire replacement for V4A `patch` (and legacy GNU `patch_text`):
 * keeps path/mode/replace_all visible and swaps only the bulk body for a
 * digest stub the model cannot re-submit as a tool call.
 */
export function stubPatchArgsForWire<T extends Record<string, unknown>>(
  args: T,
): Record<string, unknown> {
  const bulkKey =
    typeof args.patch === "string"
      ? "patch"
      : typeof args.patch_text === "string"
        ? "patch_text"
        : null;
  if (bulkKey === null) {
    return { ...args };
  }
  const bulk = args[bulkKey] as string;
  const digest = digestFileContent(bulk);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === bulkKey) continue;
    out[key] = value;
  }
  out._wire = FILE_CONTENT_WIRE_OMITTED;
  out.patchChars = digest.contentChars;
  out.patchBytes = digest.contentBytes;
  out.patchSha256 = digest.contentSha256;
  return out;
}

export function formatWriteFileSuccess(
  shownPath: string,
  content: string,
): string {
  const d = digestFileContent(content);
  return `Wrote ${shownPath} (${d.contentChars} chars, ${d.contentBytes} bytes, sha256=${d.contentSha256})`;
}
