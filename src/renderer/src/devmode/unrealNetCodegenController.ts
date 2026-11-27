
import {
  parsePushModelSetting,
  planUnrealNetCodegen,
  type NetCodegenEdit,
  type NetCodegenPlan,
} from "./unrealNetCodegen.js";
import { scanUnrealClass } from "./unrealNetScan.js";

export type UnrealNetCodegenDeps = {
  getActiveDocument: () => { path: string; text: string; line: number } | null;
  resolveCounterpart: (path: string) => Promise<string | null>;
  ensureOpen: (path: string) => Promise<void>;
  getDocumentText: (path: string) => string | null;
  applyEdits: (path: string, edits: readonly NetCodegenEdit[]) => boolean;
  activate: (path: string) => void;
  notice: (message: string, ttlMs?: number) => void;
  workspaceRoot: () => string | null;
  readTextFile: (path: string) => Promise<string | null>;
};

const HEADER_RE = /\.(?:h|hh|hpp|hxx|inl)$/i;
const SOURCE_RE = /\.(?:c|cc|cpp|cxx)$/i;

function dirOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const cut = norm.lastIndexOf("/");
  return cut <= 0 ? norm : norm.slice(0, cut);
}

function parentOf(dir: string): string {
  const cut = dir.lastIndexOf("/");
  return cut <= 0 ? dir : dir.slice(0, cut);
}

export class UnrealNetCodegenController {
  private readonly deps: UnrealNetCodegenDeps;
  private readonly pushModelByRoot = new Map<string, boolean>();

  constructor(deps: UnrealNetCodegenDeps) {
    this.deps = deps;
  }

  async run(): Promise<void> {
    const doc = this.deps.getActiveDocument();
    if (!doc) {
      this.deps.notice("Open a C++ header or source file first");
      return;
    }
    const isHeader = HEADER_RE.test(doc.path);
    const isSource = SOURCE_RE.test(doc.path);
    if (!isHeader && !isSource) {
      this.deps.notice("Not a C++ file — nothing generated");
      return;
    }

    const counterpart = await this.deps.resolveCounterpart(doc.path);
    const headerPath = isHeader ? doc.path : counterpart;
    const sourcePath = isHeader ? counterpart : doc.path;
    if (!headerPath) {
      this.deps.notice("No header found for this class — nothing generated");
      return;
    }

    if (headerPath !== doc.path) await this.deps.ensureOpen(headerPath);
    let headerText = this.deps.getDocumentText(headerPath);
    if (headerText === null) {
      this.deps.notice("Could not read the class header");
      return;
    }
    let sourceText: string | null = null;
    if (sourcePath) {
      if (sourcePath !== doc.path) await this.deps.ensureOpen(sourcePath);
      sourceText = this.deps.getDocumentText(sourcePath);
    }

    const pushModel = await this.detectPushModel(doc.path, headerPath);
    const caretMember =
      isHeader && this.caretInReflectionMember(headerText, doc.line);
    const plan = planUnrealNetCodegen({
      headerPath,
      headerText,
      sourcePath: sourceText ? sourcePath : null,
      sourceText,
      ...(isHeader ? { caretHeaderLine: doc.line } : {}),
      scope: caretMember ? "member" : "class",
      pushModel,
    });

    this.apply(plan, doc.path);
    void isSource;
  }

  private apply(plan: NetCodegenPlan, activePath: string): void {
    if (plan.files.length === 0) {
      const detail =
        plan.summary.alreadyPresent.length > 0
          ? ` — ${plan.summary.alreadyPresent.length} already present`
          : "";
      this.deps.notice(
        `${this.firstAdvisory(plan) ?? "Nothing to generate"}${detail}`,
        plan.advisories.length > 0 ? 8000 : 4000,
      );
      return;
    }
    let applied = 0;
    for (const file of plan.files) {
      if (this.deps.applyEdits(file.path, file.edits)) applied += 1;
    }
    if (applied === 0) {
      this.deps.notice("Could not apply codegen edits");
      return;
    }
    this.deps.activate(activePath);
    const parts: string[] = [];
    if (plan.summary.created.length > 0) {
      parts.push(`${plan.summary.created.length} added`);
    }
    if (plan.summary.alreadyPresent.length > 0) {
      parts.push(`${plan.summary.alreadyPresent.length} already present`);
    }
    const advisory = this.firstAdvisory(plan);
    const text = parts.length > 0 ? parts.join(" · ") : "Generated";
    this.deps.notice(
      advisory ? `${text} — ${advisory}` : `${text} · ⌘Z to undo · ⌘S to save`,
      advisory ? 9000 : 6000,
    );
  }

  private firstAdvisory(plan: NetCodegenPlan): string | null {
    return plan.advisories[0] ?? null;
  }

  private caretInReflectionMember(headerText: string, line: number): boolean {
    const scan = scanUnrealClass(headerText, line);
    if (!scan) return false;
    return scan.members.some(
      (member) => line >= member.line && line <= member.endLine,
    );
  }

  private async detectPushModel(
    activePath: string,
    headerPath: string,
  ): Promise<boolean> {
    const root = this.deps.workspaceRoot();
    const cacheKey = root ?? dirOf(headerPath);
    const cached = this.pushModelByRoot.get(cacheKey);
    if (cached !== undefined) return cached;

    const candidates: string[] = [];
    let dir = dirOf(headerPath || activePath);
    for (let depth = 0; depth < 8; depth++) {
      candidates.push(`${dir}/Config/DefaultEngine.ini`);
      const parent = parentOf(dir);
      if (parent === dir) break;
      if (root && dir === root) break;
      dir = parent;
    }
    if (root) candidates.push(`${root}/Config/DefaultEngine.ini`, `${root}/Config/DefaultGame.ini`);

    for (const candidate of candidates) {
      const text = await this.deps.readTextFile(candidate);
      if (text === null) continue;
      const enabled = parsePushModelSetting(text);
      this.pushModelByRoot.set(cacheKey, enabled);
      return enabled;
    }
    this.pushModelByRoot.set(cacheKey, false);
    return false;
  }
}
