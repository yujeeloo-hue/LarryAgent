import { showSkillDialog } from "./SkillDialogView.js";
import type { SkillsRow, SkillsView } from "./SkillsView.js";

function requireBridge(): NonNullable<Window["jellybot"]> {
  if (!window.jellybot) {
    throw new Error("JellyBot bridge is not available");
  }
  return window.jellybot;
}

/** Skills screen — create / edit / enable / delete / install app-global skills. */
export class SkillsController {
  private destroyed = false;
  private skills: SkillRecord[] = [];
  private query = "";

  constructor(private readonly view: SkillsView) {
    this.view.setOnQueryChange((query) => {
      this.query = query;
      this.renderFiltered();
    });
    this.view.setOnAdd(() => {
      void this.onAdd();
    });
    this.view.setOnInstallZip(() => {
      void this.onInstallZip();
    });
    this.view.setOnEdit((id) => {
      void this.onEdit(id);
    });
    this.view.setOnRemove((id) => {
      void this.onRemove(id);
    });
    this.view.setOnToggle((id, enabled) => {
      void this.onToggle(id, enabled);
    });
  }

  mount(): HTMLElement {
    void this.reload();
    return this.view.root;
  }

  destroy(): void {
    this.destroyed = true;
    this.view.setOnQueryChange(null);
    this.view.setOnAdd(null);
    this.view.setOnInstallZip(null);
    this.view.setOnEdit(null);
    this.view.setOnRemove(null);
    this.view.setOnToggle(null);
    this.view.root.remove();
  }

  private async reload(): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const skills = await requireBridge().listSkills();
      if (this.destroyed) return;
      this.skills = skills;
      this.renderFiltered();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to load skills.";
      this.view.setStatus(message, "error");
      this.skills = [];
      this.view.setSkills([]);
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private renderFiltered(): void {
    const trimmed = this.query.trim();
    this.view.setSkills(filterSkills(this.skills, this.query).map(toRow), {
      emptyMessage: trimmed
        ? `No skills match “${trimmed}”.`
        : "No skills configured.",
    });
  }

  private async onAdd(): Promise<void> {
    const draft = await showSkillDialog();
    if (!draft || this.destroyed) return;
    await this.persistUpsert(draft);
  }

  private async onInstallZip(): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const result = await requireBridge().installSkillZip();
      if (this.destroyed) return;
      if (!result) {
        this.view.setBusy(false);
        return;
      }
      const names = result.installed.map((s) => s.name).join(", ");
      const overwritten =
        result.overwritten.length > 0
          ? ` (replaced ${result.overwritten.join(", ")})`
          : "";
      this.view.setStatus(
        `Installed ${result.installed.length} skill(s): ${names}${overwritten}.`,
      );
      await this.reload();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to install skill package.";
      this.view.setStatus(message, "error");
      this.view.setBusy(false);
    }
  }

  private async onEdit(id: string): Promise<void> {
    const existing = this.skills.find((s) => s.id === id);
    if (!existing) return;
    const draft = await showSkillDialog({
      id: existing.id,
      name: existing.name,
      description: existing.description,
      body: existing.body,
      enabled: existing.enabled,
    });
    if (!draft || this.destroyed) return;
    await this.persistUpsert({ ...draft, id });
  }

  private async persistUpsert(draft: {
    id?: string;
    name: string;
    description: string;
    body: string;
    enabled: boolean;
  }): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      await requireBridge().upsertSkill(draft);
      if (this.destroyed) return;
      await this.reload();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to save skill.";
      this.view.setStatus(message, "error");
      this.view.setBusy(false);
    }
  }

  private async onRemove(id: string): Promise<void> {
    const existing = this.skills.find((s) => s.id === id);
    const name = existing?.name ?? "this skill";
    const bridge = requireBridge();
    const ok = await bridge.confirmDialog({
      title: "Remove skill",
      message: `Remove “${name}”? It will no longer appear in the agent catalog.`,
    });
    if (!ok || this.destroyed) return;

    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      await bridge.removeSkill(id);
      if (this.destroyed) return;
      await this.reload();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to remove skill.";
      this.view.setStatus(message, "error");
      this.view.setBusy(false);
    }
  }

  private async onToggle(id: string, enabled: boolean): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const record = await requireBridge().setSkillEnabled({ id, enabled });
      if (this.destroyed) return;
      this.patchSkill(record);
      this.renderFiltered();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to update skill.";
      this.view.setStatus(message, "error");
      await this.reload();
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private patchSkill(record: SkillRecord): void {
    const index = this.skills.findIndex((s) => s.id === record.id);
    if (index >= 0) {
      this.skills[index] = record;
    } else {
      this.skills.push(record);
    }
  }
}

function toRow(skill: SkillRecord): SkillsRow {
  return {
    id: skill.id,
    name: skill.name,
    enabled: skill.enabled,
    description: skill.description,
    body: skill.body,
    fileCount: Array.isArray(skill.files) ? skill.files.length : 0,
  };
}

function filterSkills(skills: SkillRecord[], query: string): SkillRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle),
  );
}
