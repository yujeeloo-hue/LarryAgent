/**
 * UBT / MSVC log hints and the compile gate for later Launch (P2).
 */

export type BuildGate =
  | { ok: true }
  | { ok: false; message: string };

const PDB_LOCK_RE =
  /LNK1104|cannot open (file|output)|being used by another process|The process cannot access the file/i;

/** Last useful failure line plus PDB-lock guidance when it applies. */
export function ubtFailureHint(buffer: string): string | null {
  const text = buffer.trim();
  if (!text) return "Build failed (no compiler output).";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errorLines = lines.filter(
    (l) =>
      /\berror\b/i.test(l) ||
      /^Result:\s*Failed/i.test(l) ||
      /Build failed/i.test(l),
  );
  const last = (errorLines.length > 0 ? errorLines : lines).at(-1) ?? "";
  if (PDB_LOCK_RE.test(text)) {
    return (
      `Build failed — a binary or PDB is locked (close Unreal Editor and retry). Last error: ${last}`
    );
  }
  return last ? `Build failed — ${last}` : "Build failed.";
}

export function buildAllowsLaunch(lastBuild: {
  status: string;
  buffer?: string;
} | null | undefined): BuildGate {
  if (!lastBuild) {
    return {
      ok: false,
      message: "Build has not succeeded yet — run Build (DebugGame Editor) first",
    };
  }
  if (lastBuild.status === "running") {
    return { ok: false, message: "Build is still running" };
  }
  if (lastBuild.status !== "done") {
    const hint = lastBuild.buffer ? ubtFailureHint(lastBuild.buffer) : null;
    return {
      ok: false,
      message: hint ?? `Last build ended with status "${lastBuild.status}"`,
    };
  }
  return { ok: true };
}
