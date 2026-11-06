/**
 * Stack-frame source helpers, shared by the debug session (main) and the Debug
 * panel (renderer).
 *
 * When a frame's module has no line table — every Engine module, because the
 * attach allowlist skips their PDBs — lldb-dap does not answer `stackTrace`
 * with an empty `source`. It answers with a synthetic *disassembly* source:
 * `sourceReference` is set and the name/path describe the binary
 * (`UnrealEditor-Core.dll`, or LLDB's ``Module`Symbol`` label) instead of a
 * file. Treating that as a real file is why the panel showed a `.dll` on hover
 * and why the on-demand PDB loader decided the frame was already resolved.
 */

const BINARY_MODULE = /\.(?:dll|exe|so|dylib|pdb)$/i;

export type FrameLike = {
  name: string;
  line: number;
  moduleId?: string | number;
  source?: { path?: string; name?: string; sourceReference?: number };
};

/** Compile-time source path the editor can try to open, else null. */
export function frameSourceFile(frame: FrameLike): string | null {
  const source = frame.source;
  if (!source) return null;
  if ((source.sourceReference ?? 0) > 0) return null;
  const candidate = (source.path ?? source.name ?? "").trim();
  if (!candidate) return null;
  // ``Module`Symbol`` is LLDB's disassembly label, never a file.
  if (candidate.includes("`") || BINARY_MODULE.test(candidate)) return null;
  return candidate;
}

/** Module basename (`UnrealEditor-Core.dll`) owning the frame, if stated. */
export function frameModuleLabel(frame: FrameLike): string | null {
  let fallback: string | null = null;
  for (const token of [frame.source?.path, frame.source?.name, frame.name]) {
    const base = headToken(token);
    if (!base) continue;
    if (BINARY_MODULE.test(base)) return base;
    if (fallback === null && /[`!]/.test(token ?? "")) fallback = base;
  }
  return fallback;
}

/** Lowercase basename + stem, used to match a frame against `modules`. */
export function moduleKeysOf(pathOrName: string): string[] {
  const base = headToken(pathOrName)?.toLowerCase();
  if (!base) return [];
  const stem = base.replace(BINARY_MODULE, "");
  return stem && stem !== base ? [base, stem] : [base];
}

/** Match keys for the module that owns the frame (may be empty). */
export function frameModuleKeys(frame: FrameLike): string[] {
  const label = frameModuleLabel(frame);
  return label ? moduleKeysOf(label) : [];
}

/**
 * `E:/UE/Binaries/UnrealEditor-Core.dll`FMemory::Malloc` → the basename before
 * the symbol separator. LLDB uses a backtick; MSVC-style names use `!`.
 */
function headToken(token: string | undefined): string | null {
  const raw = token?.trim();
  if (!raw) return null;
  const head = raw.split(/[`!]/, 1)[0]?.trim();
  if (!head) return null;
  const base = head.replace(/\\/g, "/").split("/").pop()?.trim();
  return base || null;
}
