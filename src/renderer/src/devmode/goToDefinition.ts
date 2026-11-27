
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

export function isUhtGeneratedPath(path: string): boolean {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  return (
    norm.endsWith(".gen.cpp") ||
    norm.endsWith(".generated.h") ||
    norm.endsWith(".generated.cpp")
  );
}

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
  if (
    !onImpl &&
    (jump ? isHeaderPath(jump.path) : isHeaderPath(caret.path)) &&
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

export function pickUhtHandwrittenTarget(input: {
  word: string;
  caret: { path: string; line: number };
  container?: string | null;
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
  return null;
}

export const CTRL_CLICK_GOTO_CONTRIBUTION =
  "editor.contrib.gotodefinitionatposition";

export function disableCtrlClickGoto(
  editor: {
    getContribution(id: string): unknown;
  } | null | undefined,
): void {
  const contribution = editor?.getContribution(CTRL_CLICK_GOTO_CONTRIBUTION) as
    | { dispose?: () => void }
    | null
    | undefined;
  contribution?.dispose?.();
}

export function pickJumpTarget<T extends { path: string; line: number }>(
  targets: readonly T[] | null | undefined,
  caret: { path: string; line: number },
): T | null {
  for (const target of targets ?? []) {
    if (isUhtGeneratedPath(target.path)) continue;
    if (samePath(target.path, caret.path) && target.line === caret.line) continue;
    return target;
  }
  return null;
}

export function definitionTargetFromOpener(
  resource: MonacoOpenerResource,
  selectionOrPosition?: MonacoOpenerSelection | null,
): DefinitionOpenTarget | null {
  if (resource.scheme !== "file") return null;
  const raw = resource.fsPath || resource.path || "";
  if (!raw) return null;
  const path = raw.replace(/\\/g, "/");
  if (isUhtGeneratedPath(path)) return null;
  const line =
    selectionOrPosition?.startLineNumber ?? selectionOrPosition?.lineNumber;
  const column =
    selectionOrPosition?.startColumn ?? selectionOrPosition?.column;
  const target: DefinitionOpenTarget = { path };
  if (line && line > 0) target.line = line;
  if (column && column > 0) target.column = column;
  return target;
}
