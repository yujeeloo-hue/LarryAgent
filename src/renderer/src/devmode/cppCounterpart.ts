
import {
  isCppHeaderPath,
  isCppSourcePath,
  siblingHeaderCandidates,
  siblingSourceCandidates,
} from "./cppHeaderOutline.js";

export type CounterpartKind = "header" | "source";

const HEADER_EXTS = [".h", ".hpp", ".hxx", ".hh"];
const SOURCE_EXTS = [".cpp", ".cc", ".cxx", ".c"];

export type CounterpartSearchOptions = {
  codeOnly?: boolean;
  limit?: number;
  deadlineMs?: number;
};

export type CounterpartSearchResult = {
  ok: boolean;
  files?: Array<{ path: string; rel: string }>;
  truncated?: boolean;
};

export type CounterpartSearchFn = (
  root: string,
  query: string,
  options?: CounterpartSearchOptions,
) =>
  | Promise<CounterpartSearchResult | null | undefined>
  | CounterpartSearchResult
  | null
  | undefined;

export function counterpartKind(path: string): CounterpartKind | null {
  if (isCppSourcePath(path)) return "header";
  if (isCppHeaderPath(path)) return "source";
  return null;
}

export function counterpartSearchScope(
  path: string,
): { root: string; subPath: string } | null {
  const norm = path.replace(/\\/g, "/");
  const segs = norm.split("/");
  if (segs.length < 2) return null;
  segs.pop();
  let cut = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    const name = segs[i]!.toLowerCase();
    if (name === "private" || name === "public" || name === "classes") {
      cut = i;
      break;
    }
  }
  if (cut === -1) return { root: segs.join("/"), subPath: "" };
  return {
    root: segs.slice(0, cut).join("/"),
    subPath: segs.slice(cut + 1).join("/"),
  };
}

function scoreLess(
  a: readonly (number | string)[],
  b: readonly (number | string)[],
): boolean {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return true;
    if (y === undefined) return false;
    return x < y;
  }
  return false;
}

export function pickCounterpartHit(
  hits: readonly { path: string; rel: string }[],
  base: string,
  kind: CounterpartKind,
  subPath: string,
): string | null {
  const lowerBase = base.toLowerCase();
  const exts = new Set(kind === "header" ? HEADER_EXTS : SOURCE_EXTS);
  const prefers = kind === "header" ? ["classes", "public"] : ["private"];
  let best: { path: string; score: (number | string)[] } | null = null;
  for (const hit of hits) {
    const rel = hit.rel.replace(/\\/g, "/");
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    if (name.slice(0, dot).toLowerCase() !== lowerBase) continue;
    if (!exts.has(name.slice(dot).toLowerCase())) continue;
    const dirSegs = rel.split("/");
    dirSegs.pop();
    const score = [
      prefers.includes(dirSegs[0]?.toLowerCase() ?? "") ? 0 : 1,
      dirSegs.slice(1).join("/") === subPath ? 0 : 1,
      dirSegs.length,
      rel,
    ];
    if (best === null || scoreLess(score, best.score)) {
      best = { path: hit.path.replace(/\\/g, "/"), score };
    }
  }
  return best?.path ?? null;
}

export type CounterpartIndexFn = (
  base: string,
) => readonly { path: string; rel: string }[] | null | undefined;

export async function resolveCppCounterpart(
  path: string,
  search: CounterpartSearchFn,
  exists?: (paths: string[]) => Promise<string[]> | string[] | null | undefined,
  index?: CounterpartIndexFn,
  trace?: (line: string) => void,
): Promise<string | null> {
  const kind = counterpartKind(path);
  if (!kind) return null;
  const norm = path.replace(/\\/g, "/");
  const m = /^(.*)\/([^/]+)\.[^./]+$/.exec(norm);
  if (!m) return null;
  const base = m[2]!;
  const lower = norm.toLowerCase();

  const candidates =
    kind === "header"
      ? siblingHeaderCandidates(path)
      : siblingSourceCandidates(path);
  if (exists && candidates.length > 0) {
    try {
      const found = await exists(candidates);
      const hit = (found ?? [])
        .map((p) => p.replace(/\\/g, "/"))
        .find((p) => p.toLowerCase() !== lower);
      trace?.(`exact: ${candidates.length} candidates, hit=${hit ?? "none"}`);
      if (hit) return hit;
    } catch (err) {
      trace?.(`exact: exists() threw ${String(err)}`);
    }
  } else {
    trace?.(`exact: skipped (${exists ? "no candidates" : "no bridge"})`);
  }

  const scope = counterpartSearchScope(path);

  if (index) {
    try {
      const hits = index(base);
      if (hits && hits.length > 0) {
        const hit = pickCounterpartIndexHit(hits, base, kind, scope?.subPath ?? "");
        trace?.(`index: ${hits.length} basename hits, hit=${hit ?? "none"}`);
        if (hit && hit.toLowerCase() !== lower) return hit;
      } else {
        trace?.("index: cold (0 hits)");
      }
    } catch (err) {
      trace?.(`index: threw ${String(err)}`);
    }
  } else {
    trace?.("index: not wired");
  }

  if (!scope || !scope.root) return null;
  let result: CounterpartSearchResult | null | undefined;
  try {
    result = await search(scope.root, base, {
      codeOnly: true,
      limit: 200,
      deadlineMs: 4000,
    });
  } catch (err) {
    trace?.(`walk: threw ${String(err)}`);
    return null;
  }
  if (!result?.ok || !result.files || result.files.length === 0) {
    trace?.(
      `walk: root=${scope.root} ok=${result?.ok ?? "threw"} files=${result?.files?.length ?? 0} truncated=${result?.truncated ?? "-"}`,
    );
    return null;
  }
  const hit = pickCounterpartHit(result.files, base, kind, scope.subPath);
  trace?.(`walk: ${result.files.length} hits, hit=${hit ?? "none"}`);
  return hit;
}

export function pickCounterpartIndexHit(
  hits: readonly { path: string; rel: string }[],
  base: string,
  kind: CounterpartKind,
  subPath: string,
): string | null {
  const resealed = hits.map((hit) => {
    const rel = hit.rel.replace(/\\/g, "/");
    const segs = rel.split("/");
    const name = segs.pop() ?? "";
    let marker = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i]!.toLowerCase();
      if (seg === "private" || seg === "public" || seg === "classes") {
        marker = i;
        break;
      }
    }
    const scoped =
      marker >= 0
        ? `${segs.slice(marker).join("/")}/${name}`
        : name;
    return { path: hit.path.replace(/\\/g, "/"), rel: scoped };
  });
  return pickCounterpartHit(resealed, base, kind, subPath);
}
