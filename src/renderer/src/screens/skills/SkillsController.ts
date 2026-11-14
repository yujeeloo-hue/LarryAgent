import { formatRelativeTime } from "../../navigation/formatRelativeTime.js";
import { showSkillDialog } from "./SkillDialogView.js";
import { openSkillHistory } from "./SkillHistoryController.js";
import { skillOriginLabel, skillTextDiff } from "./skillDisplay.js";
import type {
  SkillCurationRow,
  SkillSuggestionRow,
  SkillsRow,
  SkillsView,
} from "./SkillsView.js";

function requireBridge(): NonNullable<Window["jellybot"]> {
  if (!window.jellybot) {
    throw new Error("JellyBot bridge is not available");
  }
  return window.jellybot;
}

/**
 * Skills screen — create / edit / enable / delete / install app-global skills,
 * plus history, deprecation, suggested changes and library curation.
 */
export class SkillsController {
  private destroyed = false;
  private skills: SkillRecord[] = [];
  private stats = new Map<string, SkillUsageStatsRow>();
  private proposals: SkillProposalView[] = [];
  private curation: SkillCurationStatus = { running: false };
  private query = "";
  /** Project slug → workspace display name, for folder headings. */
  private projectNames = new Map<string, string>();

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
    this.view.setOnHistory((id) => {
      void this.onHistory(id);
    });
    this.view.setOnDeprecate((id, deprecated) => {
      void this.onDeprecate(id, deprecated);
    });
    this.view.setOnResolveSuggestion((id, decision) => {
      void this.onResolveSuggestion(id, decision);
    });
    this.view.setOnCurateNow(() => {
      void this.onCurateNow();
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
    this.view.setOnHistory(null);
    this.view.setOnDeprecate(null);
    this.view.setOnResolveSuggestion(null);
    this.view.setOnCurateNow(null);
    this.view.root.remove();
  }

  private async reload(): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const bridge = requireBridge();
      const [skills, stats, proposals, curation] = await Promise.all([
        bridge.listSkills(),
        bridge.getSkillUsageStats().catch(() => [] as SkillUsageStatsRow[]),
        bridge.listSkillProposals().catch(() => [] as SkillProposalView[]),
        bridge.getSkillCurationStatus().catch(() => ({ running: false }) as SkillCurationStatus),
      ]);
      const workspaces = await bridge.listWorkspaces().catch(() => [] as Workspace[]);
      if (this.destroyed) return;
      this.skills = skills;
      this.stats = new Map(stats.map((row) => [row.skillId, row]));
      this.proposals = proposals;
      this.curation = curation;
      this.projectNames = new Map(
        workspaces
          .map((workspace) => [workspaceSlug(workspace.path), workspace.name] as const)
          .filter(([slug]) => slug !== ""),
      );
      this.renderFiltered();
      this.renderSuggestions();
      this.view.setCuration(curationRow(this.curation));
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to load skills.";
      this.view.setStatus(message, "error");
      this.skills = [];
      this.view.setSkills([]);
      this.view.setDeprecated([]);
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private renderFiltered(): void {
    const trimmed = this.query.trim();
    const visible = filterSkills(this.skills, this.query);
    const toRow = (skill: SkillRecord): SkillsRow =>
      skillRow(skill, this.stats.get(skill.id), this.projectNames);
    this.view.setSkills(
      visible.filter((s) => s.status !== "deprecated").map(toRow),
      {
        allSkills: this.skills.map(toRow),
        emptyMessage: trimmed
          ? `No skills match “${trimmed}”.`
          : "No skills configured.",
      },
    );
    this.view.setDeprecated(visible.filter((s) => s.status === "deprecated").map(toRow));
  }

  private renderSuggestions(): void {
    const names = new Map(this.skills.map((s) => [s.id, s.name]));
    this.view.setSuggestions(this.proposals.map((p) => suggestionRow(p, names)));
  }

  private async onHistory(id: string): Promise<void> {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) return;
    const restored = await openSkillHistory({ id: skill.id, name: skill.name });
    if (!restored || this.destroyed) return;
    await this.reload();
    if (!this.destroyed) this.view.setStatus(`Restored an earlier revision of “${skill.name}”.`);
  }

  private async onDeprecate(id: string, deprecated: boolean): Promise<void> {
    await this.runAction(
      async () => {
        await requireBridge().setSkillDeprecated({ id, deprecated });
      },
      deprecated ? "Failed to deprecate skill." : "Failed to reactivate skill.",
    );
  }

  private async onResolveSuggestion(id: string, decision: "accept" | "reject"): Promise<void> {
    await this.runAction(
      async () => {
        await requireBridge().resolveSkillProposal({ id, decision });
        return decision === "accept" ? "Suggestion applied." : "Suggestion rejected.";
      },
      "Failed to resolve suggestion.",
    );
  }

  private async onCurateNow(): Promise<void> {
    this.view.setCuration({ text: "Curating the skill library…", running: true });
    this.view.setStatus(null);
    try {
      const status = await requireBridge().curateSkillsNow();
      if (this.destroyed) return;
      this.curation = status;
      await this.reload();
      if (this.destroyed) return;
      this.view.setCuration(curationRow(this.curation));
    } catch (err) {
      if (this.destroyed) return;
      this.view.setCuration({
        text: err instanceof Error ? err.message : "Curation failed.",
        running: false,
        kind: "error",
      });
    }
  }

  /** Busy → action → reload; the action may return a status line. */
  private async runAction(
    action: () => Promise<string | void>,
    failure: string,
  ): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const message = await action();
      if (this.destroyed) return;
      await this.reload();
      if (message && !this.destroyed) this.view.setStatus(message);
    } catch (err) {
      if (this.destroyed) return;
      this.view.setStatus(err instanceof Error ? err.message : failure, "error");
      this.view.setBusy(false);
    }
  }

  private async onAdd(): Promise<void> {
    const draft = await showSkillDialog({
      projectOptions: knownProjects(this.skills),
    });
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
      project: existing.project ?? "",
      projectOptions: knownProjects(this.skills),
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
    project: string;
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

function skillRow(
  skill: SkillRecord,
  stats: SkillUsageStatsRow | undefined,
  projectNames: ReadonlyMap<string, string>,
): SkillsRow {
  const slug = (skill.project ?? "").trim().toLowerCase();
  const rate = successRate(stats);
  return {
    id: skill.id,
    name: skill.name,
    enabled: skill.enabled,
    description: skill.description,
    body: skill.body,
    fileCount: Array.isArray(skill.files) ? skill.files.length : 0,
    originLabel: skillOriginLabel(skill.origin),
    projectLabel: slug ? (projectNames.get(slug) ?? slug) : "Universal",
    project: slug,
    usage: usageLine(stats),
    ...(stats && stats.uses > 0 ? { uses: stats.uses } : {}),
    ...(rate !== undefined ? { successRate: rate } : {}),
    deprecated: skill.status === "deprecated",
    ...(skill.supersededByName ? { supersededByName: skill.supersededByName } : {}),
  };
}

/** Clean-use percentage, null when never finished a use, undefined without stats. */
function successRate(stats: SkillUsageStatsRow | undefined): number | null | undefined {
  if (!stats) return undefined;
  if (stats.finished <= 0) return null;
  return Math.round((stats.successes / stats.finished) * 100);
}

function usageLine(stats: SkillUsageStatsRow | undefined): string {
  if (!stats || stats.uses === 0) return "Not used yet";
  const parts = [`Used ${stats.uses}×`, `last ${formatRelativeTime(stats.lastUsedAt)}`];
  if (stats.finished > 0) {
    parts.push(`${Math.round((stats.successes / stats.finished) * 100)}% success`);
  }
  if (stats.corrected > 0) parts.push(`corrected ${stats.corrected}×`);
  return parts.join(" · ");
}

const PROPOSAL_KIND_LABELS: Record<SkillProposalView["kind"], string> = {
  patch: "Edit",
  update: "Update",
  merge: "Merge",
  deprecate: "Deprecate",
};

function suggestionRow(
  proposal: SkillProposalView,
  names: Map<string, string>,
): SkillSuggestionRow {
  const targets = proposal.targetIds.map((id) => names.get(id) ?? id);
  return {
    id: proposal.id,
    kind: proposal.kind,
    title: `${PROPOSAL_KIND_LABELS[proposal.kind]} · ${targets.join(", ")}`,
    reason: proposal.reason,
    meta: `${skillOriginLabel(proposal.actor)} · ${formatRelativeTime(proposal.createdAt)}`,
    stale: proposal.stale,
    changes: proposal.changes.map((change) => ({
      name: change.skillId ? change.name : `${change.name} (new)`,
      diff: skillTextDiff(change.before, change.after),
    })),
  };
}

function curationRow(status: SkillCurationStatus): SkillCurationRow {
  if (status.running) return { text: "Reviewing skills…", running: true };
  const result = status.lastResult;
  if (!result) {
    return {
      text: "Not reviewed yet",
      running: false,
      kind: "idle",
    };
  }
  const when = formatRelativeTime(result.at);
  const text = result.error
    ? `Last curation failed ${when}: ${result.error}`
    : `${status.summary ?? "Last curation finished."} · ${when}`;
  return { text, running: false, kind: result.error ? "error" : "success" };
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

/** Distinct project slugs in the library, sorted (dialog picker choices). */
function knownProjects(skills: SkillRecord[]): string[] {
  const seen = new Set<string>();
  for (const skill of skills) {
    const slug = (skill.project ?? "").trim().toLowerCase();
    if (slug) seen.add(slug);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Folder key for a workspace path: its basename, lowercased. Mirrors
 * `skillProjectKey` in `src/skills/projectScope.ts` (main-side single source);
 * kept local so the renderer stays free of main-process imports.
 */
function workspaceSlug(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part && part !== "~");
  return (parts[parts.length - 1] ?? "").trim().toLowerCase();
}
