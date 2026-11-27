import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execGit } from "../git/execGit.js";
import { execSvn } from "./execSvn.js";
import { parseSvnStatus } from "./parseSvn.js";

export type SvnConflictKind = "text" | "tree";

export type SvnConflictEntry = {
  /** Path relative to the working copy root, always with POSIX separators. */
  path: string;
  kind: SvnConflictKind;
};

/**
 * `working` is SVN's only applicable option for a tree conflict: it keeps
 * whatever is on disk and just clears the conflict marker.
 */
export type SvnConflictChoice = "mine" | "theirs" | "both" | "working";

export type SvnConflictResolveResult =
  | { ok: true; remaining: string[] }
  | { ok: false; message: string };

export function toSvnPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Conflicts in the working copy (content, property and tree).
 *
 * Throws when `svn status` itself fails — a locked or broken working copy is
 * not the same thing as "no conflicts", and callers must not report it as one.
 */
export async function listSvnConflicts(root: string): Promise<SvnConflictEntry[]> {
  const { stdout } = await execSvn(root, ["status", "--quiet"]);
  const byPath = new Map<string, SvnConflictEntry>();
  for (const entry of parseSvnStatus(stdout)) {
    if (entry.kind !== "conflicted") continue;
    const path = toSvnPath(entry.path);
    // `svn status` lists the same path twice when content and properties both
    // conflict, and a ".mine" copy can show up as unversioned next to it.
    if (/\.(mine|r\d+)$/.test(path)) continue;
    const kind: SvnConflictKind = entry.treeConflict ? "tree" : "text";
    // A path can be both; the tree conflict is the one needing manual work.
    if (byPath.get(path)?.kind === "tree") continue;
    byPath.set(path, { path, kind });
  }
  return [...byPath.values()];
}

/**
 * Matches the path handed back by the panel against the working copy listing.
 * Windows `svn status` prints `Content\A.cpp`, the renderer may send either
 * separator, so both sides are normalised before comparing.
 */
export function findSvnConflict(
  conflicts: readonly SvnConflictEntry[],
  path: string,
): SvnConflictEntry | null {
  const wanted = toSvnPath(path.trim()).replace(/^\.\//, "");
  if (!wanted) return null;
  return conflicts.find((entry) => entry.path === wanted) ?? null;
}

/** Rejects options SVN cannot apply to the kind of conflict at hand. */
export function svnConflictChoiceError(
  kind: SvnConflictKind,
  choice: SvnConflictChoice,
): string | null {
  if (kind === "tree") {
    return choice === "working"
      ? null
      : "SVN cannot take one side of a tree conflict — keep the working copy, then merge or delete the files by hand.";
  }
  return choice === "working"
    ? "Only a tree conflict can fall back to the working copy."
    : null;
}

/**
 * SVN leaves `<path>.mine` (the local side) next to `<path>.r<old>` (BASE) and
 * `<path>.r<new>` (the incoming side). Pick base/incoming by revision number.
 */
export function selectSvnConflictSides(
  entries: readonly string[],
  relativePath: string,
): { mine: string | null; base: string | null; incoming: string | null } {
  const normalized = relativePath.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dir = normalized.slice(0, Math.max(0, normalized.lastIndexOf("/")));
  let mine: string | null = null;
  const revisions: { rev: number; name: string }[] = [];

  for (const entry of entries) {
    if (entry === `${name}.mine`) {
      mine = entry;
      continue;
    }
    const match = new RegExp(`^${escapeRegExp(name)}\\.r(\\d+)$`).exec(entry);
    if (match?.[1]) revisions.push({ rev: Number(match[1]), name: entry });
  }

  revisions.sort((a, b) => a.rev - b.rev);
  const base = revisions[0]?.name ?? null;
  const incoming = revisions.length > 1 ? revisions[revisions.length - 1]!.name : null;

  const prefix = dir ? `${dir}/` : "";
  return {
    mine: mine ? `${prefix}${mine}` : null,
    base: base ? `${prefix}${base}` : null,
    incoming: incoming ? `${prefix}${incoming}` : null,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").trim();
}

async function looksBinary(absolutePath: string): Promise<boolean> {
  try {
    const buffer = await readFile(absolutePath);
    return buffer.subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
}

async function writeUnion(
  root: string,
  relativePath: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const absolute = join(root, relativePath);
  const sides = selectSvnConflictSides(
    await readdir(dirname(absolute)).catch(() => [] as string[]),
    relativePath,
  );
  if (!sides.mine || !sides.base || !sides.incoming) {
    return {
      ok: false,
      message: `SVN left no conflict copies for ${relativePath} — open it in Dev Mode to merge by hand.`,
    };
  }
  const [mine, base, incoming] = await Promise.all([
    readFile(join(root, sides.mine)),
    readFile(join(root, sides.base)),
    readFile(join(root, sides.incoming)),
  ]);
  if (mine.subarray(0, 8192).includes(0) || incoming.subarray(0, 8192).includes(0)) {
    return { ok: false, message: `${relativePath} is binary — pick one side.` };
  }

  const dir = await mkdtemp(join(tmpdir(), "jellybot-svn-merge-"));
  try {
    const oursFile = join(dir, "ours");
    const baseFile = join(dir, "base");
    const theirsFile = join(dir, "theirs");
    await writeFile(oursFile, mine);
    await writeFile(baseFile, base);
    await writeFile(theirsFile, incoming);
    const { stdout } = await execGit(root, [
      "merge-file",
      "-p",
      "--union",
      oursFile,
      baseFile,
      theirsFile,
    ]);
    await writeFile(absolute, stdout, "utf8");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: `Could not combine both sides of ${relativePath} — ${errorText(err)}`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function resolveSvnConflict(
  root: string,
  relativePathRaw: string,
  choice: SvnConflictChoice,
): Promise<SvnConflictResolveResult> {
  const relativePath = toSvnPath(relativePathRaw.trim());
  if (!relativePath) return { ok: false, message: "No file was given." };

  let conflicts: SvnConflictEntry[];
  try {
    conflicts = await listSvnConflicts(root);
  } catch (err) {
    return {
      ok: false,
      message: `Could not read the working copy status — ${errorText(err)}`,
    };
  }

  const conflict = findSvnConflict(conflicts, relativePath);
  if (!conflict) {
    return { ok: false, message: `${relativePath} is not conflicted.` };
  }
  const choiceError = svnConflictChoiceError(conflict.kind, choice);
  if (choiceError) return { ok: false, message: `${relativePath}: ${choiceError}` };

  const absolute = join(root, conflict.path);
  if (choice === "both" && (await looksBinary(absolute))) {
    return { ok: false, message: `${relativePath} is binary — pick one side.` };
  }

  try {
    if (choice === "both") {
      const merged = await writeUnion(root, conflict.path);
      if (!merged.ok) return merged;
      await execSvn(root, ["resolve", "--accept", "working", "--", conflict.path]);
    } else {
      await execSvn(root, [
        "resolve",
        "--accept",
        choice === "mine" ? "mine-full" : choice === "theirs" ? "theirs-full" : "working",
        "--",
        conflict.path,
      ]);
    }
  } catch (err) {
    const side =
      choice === "mine"
        ? "local"
        : choice === "theirs"
          ? "incoming"
          : choice === "both"
            ? "combined"
            : "working";
    return {
      ok: false,
      message: `Could not keep the ${side} version of ${relativePath} — ${errorText(err)}`,
    };
  }

  // Advisory only: the resolve itself already succeeded.
  const remaining = await listSvnConflicts(root).then(
    (entries) => entries.map((entry) => entry.path),
    () => [] as string[],
  );
  return { ok: true, remaining };
}
