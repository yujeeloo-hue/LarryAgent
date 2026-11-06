/**
 * Helpers for Monaco Go to Definition (F12 / Ctrl+click).
 * Pure — no monaco import so tests don't load the editor bundle.
 */

export type MonacoOpenerResource = {
  scheme: string;
  fsPath?: string;
  path?: string;
};

export type MonacoOpenerSelection = {
  startLineNumber?: number;
  startColumn?: number;
  lineNumber?: number;
  column?: number;
};

export type DefinitionOpenTarget = {
  path: string;
  line?: number;
  column?: number;
};

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

function fileStem(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.(?:gen\.cpp|generated\.h|generated\.cpp|[^.]+)$/i, "");
}

function isHeaderPath(path: string): boolean {
  return /\.(?:h|hpp|hxx|hh|inl)$/i.test(path);
}

function isSourcePath(path: string): boolean {
  return /\.(?:cpp|cc|cxx|c)$/i.test(path);
}

/** UHT output: `NFCharacter.gen.cpp` thunks and `*.generated.h` macro bodies. */
export function isUhtGeneratedPath(path: string): boolean {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  return (
    norm.endsWith(".gen.cpp") ||
    norm.endsWith(".generated.h") ||
    norm.endsWith(".generated.cpp")
  );
}

/**
 * `Server_PlayAudio` ↔ `Server_PlayAudio_Implementation`. UHT implements
 * the declared RPC (and BlueprintNativeEvent) as a generated thunk; the
 * handwritten body uses the `_Implementation` suffix.
 */
export function uhtThunkPair(
  word: string,
): { thunk: string; implementation: string } | null {
  if (!/^[A-Za-z_]\w+$/.test(word)) return null;
  const suffix = "_Implementation";
  if (word.endsWith(suffix)) {
    const thunk = word.slice(0, -suffix.length);
    if (!thunk) return null;
    return { thunk, implementation: word };
  }
  return { thunk: word, implementation: `${word}${suffix}` };
}

/**
 * Name to look up when F12 would land on a UHT thunk. Null when the jump
 * should stay on the target clangd or the text index already chose.
 */
export function uhtRedirectQuery(
  word: string,
  targets: readonly { path: string; line: number }[] | null | undefined,
  caret: { path: string; line: number },
  jump: { path: string; line: number } | null,
): string | null {
  const pair = uhtThunkPair(word);
  if (!pair) return null;
  const onImpl = word.endsWith("_Implementation");
  const wanted = onImpl ? pair.thunk : pair.implementation;
  const elsewhere = (targets ?? []).filter(
    (target) => !(samePath(target.path, caret.path) && target.line === caret.line),
  );
  const sawGenerated =
    elsewhere.some((target) => isUhtGeneratedPath(target.path)) ||
    (jump != null && isUhtGeneratedPath(jump.path));
  if (sawGenerated) {
    if (!jump || isUhtGeneratedPath(jump.path) || isHeaderPath(jump.path) || onImpl) {
      return wanted;
    }
    return null;
  }
  if (onImpl && (!jump || isHeaderPath(jump.path))) return wanted;
  // Declaration in the header, and no handwritten source of the same name.
  if (
    !onImpl &&
    isHeaderPath(caret.path) &&
    (!jump || isHeaderPath(jump.path)) &&
    !elsewhere.some((target) => isSourcePath(target.path) && !isUhtGeneratedPath(target.path))
  ) {
    return wanted;
  }
  return null;
}

export type UhtJumpCandidate = {
  name: string;
  path: string;
  line: number;
  container?: string;
  isImpl?: boolean;
};

function containerOf(candidate: UhtJumpCandidate): string {
  return (candidate.container ?? "").split("::").pop()?.toLowerCase() ?? "";
}

/**
 * Handwritten landing spot for a UHT thunk. From `Server_PlayAudio` this is
 * the `.cpp` `_Implementation`; from that body it is the header declaration.
 * Generated files are never chosen. Null when nothing matches the class or
 * the generated file's stem.
 */
export function pickUhtHandwrittenTarget(input: {
  word: string;
  caret: { path: string; line: number };
  /** Qualifier at the caret (`ANFCharacter::Server_PlayAudio`). */
  container?: string | null;
  /** `.gen.cpp` / `.generated.h` path clangd returned, when there is one. */
  generatedPath?: string | null;
  candidates: readonly UhtJumpCandidate[];
}): { path: string; line: number } | null {
  const pair = uhtThunkPair(input.word);
  if (!pair) return null;
  const onImpl = input.word.endsWith("_Implementation");
  const wanted = onImpl ? pair.thunk : pair.implementation;
  const matches = input.candidates.filter((candidate) => {
    if (candidate.name !== wanted) return false;
    if (isUhtGeneratedPath(candidate.path)) return false;
    if (samePath(candidate.path, input.caret.path) && candidate.line === input.caret.line) {
      return false;
    }
    return true;
  });
  if (matches.length === 0) return null;

  const prefer = (list: readonly UhtJumpCandidate[]): UhtJumpCandidate => {
    const score = (candidate: UhtJumpCandidate): number => {
      let value = 0;
      if (onImpl) {
        if (!candidate.isImpl) value += 10;
        if (isHeaderPath(candidate.path)) value += 5;
      } else if (candidate.isImpl || isSourcePath(candidate.path)) {
        value += 10;
      }
      return value;
    };
    return [...list].sort(
      (a, b) => score(b) - score(a) || a.line - b.line || (a.path < b.path ? -1 : 1),
    )[0]!;
  };

  const located = (candidate: UhtJumpCandidate) => ({
    path: candidate.path,
    line: candidate.line,
  });
  const hint = input.container?.split("::").pop()?.toLowerCase() ?? "";
  if (hint) {
    const sameClass = matches.filter((candidate) => containerOf(candidate) === hint);
    if (sameClass.length > 0) return located(prefer(sameClass));
  }
  const stem = (
    input.generatedPath ? fileStem(input.generatedPath) : fileStem(input.caret.path)
  ).toLowerCase();
  if (stem) {
    const sameFile = matches.filter(
      (candidate) => fileStem(candidate.path).toLowerCase() === stem,
    );
    if (sameFile.length > 0) return located(prefer(sameFile));
  }
  // A lone hit in some other class is a different function, not this thunk.
  return null;
}

/**
 * When the text index already has the other side of this symbol, F12 waits
 * only this long for clangd. A warm file answers inside the window (and
 * wins, because the AST is more accurate for overloads). A cold file is
 * still building its preamble — clangd would otherwise hold the jump for
 * tens of seconds — so the index jump is taken and the clangd request is
 * cancelled. Engine symbols with no index hit still wait on clangd.
 */
export const DEFINITION_TEXT_GRACE_MS = 200;

/**
 * Resolve `promise` if it settles within `ms`, otherwise null.
 * The caller cancels the underlying clangd query when this returns null
 * so a cold preamble cannot keep the jump queued.
 */
export function raceWithGrace<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * First F12 target that is not the caret's own line. When the caret sits on
 * a declaration and the only answer is that declaration itself (clangd has
 * not indexed the implementation yet, or the text ranker's same-file bonus
 * wins), skipping it lets the next candidate — the `.cpp` definition — win,
 * Rider-style. Null when every target is the caret line.
 */
export function pickJumpTarget<T extends { path: string; line: number }>(
  targets: readonly T[] | null | undefined,
  caret: { path: string; line: number },
): T | null {
  for (const target of targets ?? []) {
    if (samePath(target.path, caret.path) && target.line === caret.line) continue;
    return target;
  }
  return null;
}

/** Map a Monaco opener URI + selection to a workspace file jump. */
export function definitionTargetFromOpener(
  resource: MonacoOpenerResource,
  selectionOrPosition?: MonacoOpenerSelection | null,
): DefinitionOpenTarget | null {
  if (resource.scheme !== "file") return null;
  const raw = resource.fsPath || resource.path || "";
  if (!raw) return null;
  const path = raw.replace(/\\/g, "/");
  const line =
    selectionOrPosition?.startLineNumber ?? selectionOrPosition?.lineNumber;
  const column =
    selectionOrPosition?.startColumn ?? selectionOrPosition?.column;
  const target: DefinitionOpenTarget = { path };
  if (line && line > 0) target.line = line;
  if (column && column > 0) target.column = column;
  return target;
}
