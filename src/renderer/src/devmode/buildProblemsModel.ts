import type { BuildDiagnostic } from "./buildDiagnostics.js";

export class BuildProblemsModel {
  private readonly byId = new Map<string, BuildDiagnostic>();
  private errors: BuildDiagnostic[] = [];
  private warnings: BuildDiagnostic[] = [];
  selectedId: string | null = null;

  get size(): number {
    return this.errors.length + this.warnings.length;
  }

  get errorCount(): number {
    return this.errors.length;
  }

  get warningCount(): number {
    return this.warnings.length;
  }

  at(index: number): BuildDiagnostic {
    return index < this.errors.length ? this.errors[index]! : this.warnings[index - this.errors.length]!;
  }

  get(id: string): BuildDiagnostic | undefined {
    return this.byId.get(id);
  }

  add(items: readonly BuildDiagnostic[]): boolean {
    let added = false;
    for (const item of items) {
      if (this.byId.has(item.id)) continue;
      this.byId.set(item.id, item);
      (item.severity === "error" ? this.errors : this.warnings).push(item);
      added = true;
    }
    return added;
  }

  select(id: string | null): boolean {
    if (this.selectedId === id) return false;
    this.selectedId = id;
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.errors = [];
    this.warnings = [];
    this.selectedId = null;
  }
}
