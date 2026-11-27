
const BINARY_MODULE = /\.(?:dll|exe|so|dylib|pdb)$/i;

export type FrameLike = {
  name: string;
  line: number;
  moduleId?: string | number;
  source?: { path?: string; name?: string; sourceReference?: number };
};

export function frameSourceFile(frame: FrameLike): string | null {
  const source = frame.source;
  if (!source) return null;
  if ((source.sourceReference ?? 0) > 0) return null;
  const candidate = (source.path ?? source.name ?? "").trim();
  if (!candidate) return null;
  if (candidate.includes("`") || BINARY_MODULE.test(candidate)) return null;
  return candidate;
}

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

export function moduleKeysOf(pathOrName: string): string[] {
  const base = headToken(pathOrName)?.toLowerCase();
  if (!base) return [];
  const stem = base.replace(BINARY_MODULE, "");
  return stem && stem !== base ? [base, stem] : [base];
}

export function frameModuleKeys(frame: FrameLike): string[] {
  const label = frameModuleLabel(frame);
  return label ? moduleKeysOf(label) : [];
}

function headToken(token: string | undefined): string | null {
  const raw = token?.trim();
  if (!raw) return null;
  const head = raw.split(/[`!]/, 1)[0]?.trim();
  if (!head) return null;
  const base = head.replace(/\\/g, "/").split("/").pop()?.trim();
  return base || null;
}
