import { formatRelativeTime } from "../../navigation/formatRelativeTime.js";
import { skillOriginLabel, skillTextDiff } from "./skillDisplay.js";
import { SkillHistoryView, type SkillHistoryRow } from "./SkillHistoryView.js";

function requireBridge(): NonNullable<Window["jellybot"]> {
  if (!window.jellybot) throw new Error("JellyBot bridge is not available");
  return window.jellybot;
}

/**
 * Skill history dialog — list revisions, diff one against the live version,
 * restore it. Resolves `true` when a revision was restored.
 */
export function openSkillHistory(skill: { id: string; name: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const view = new SkillHistoryView();
    const controller = new SkillHistoryController(skill, view, (restored) => {
      view.close();
      resolve(restored);
    });
    view.open();
    void controller.load();
  });
}

class SkillHistoryController {
  private revisions: SkillRevisionEntry[] = [];
  private selected: number | null = null;
  private live: SkillRevisionContent | null = null;
  private closed = false;

  constructor(
    private readonly skill: { id: string; name: string },
    private readonly view: SkillHistoryView,
    private readonly done: (restored: boolean) => void,
  ) {
    view.setTitle(`History · ${skill.name}`);
    view.setOnClose(() => this.finish(false));
    view.setOnSelect((revision) => void this.select(revision));
    view.setOnRestore(() => void this.restore());
  }

  async load(): Promise<void> {
    this.view.setBusy(true);
    try {
      const bridge = requireBridge();
      this.revisions = await bridge.listSkillRevisions(this.skill.id);
      const current = this.revisions.find((r) => r.current);
      this.live = current
        ? await bridge.readSkillRevision({ id: this.skill.id, revision: current.revision })
        : null;
      if (this.closed) return;
      const first = this.revisions.find((r) => !r.current) ?? current;
      if (!first) {
        this.view.setRows([], null);
        this.view.setDetail({ heading: "No revisions yet.", diff: null, message: "Changes to this skill will be listed here.", canRestore: false });
        return;
      }
      await this.select(first.revision);
    } catch (err) {
      if (!this.closed) this.view.setStatus(err instanceof Error ? err.message : "Failed to load history.");
    } finally {
      if (!this.closed) this.view.setBusy(false);
    }
  }

  private async select(revision: number): Promise<void> {
    this.selected = revision;
    this.view.setRows(this.revisions.map(toRow), revision);
    this.view.setStatus(null);
    const entry = this.revisions.find((r) => r.revision === revision);
    if (!entry) return;
    if (entry.current) {
      this.view.setDetail({ heading: `Revision ${revision} is the live version.`, diff: null, message: "Pick an older revision to compare and restore it.", canRestore: false });
      return;
    }
    try {
      const content = await requireBridge().readSkillRevision({ id: this.skill.id, revision });
      if (this.closed || this.selected !== revision) return;
      const diff = skillTextDiff(this.live?.skillMd ?? "", content.skillMd);
      const fileNote = sameFiles(this.live?.files ?? [], content.files) ? "" : ` · files: ${content.files.length}`;
      this.view.setDetail({
        heading: `Restoring revision ${revision} changes the live version:${fileNote}`,
        diff: diff.length ? diff : null,
        message: "SKILL.md is identical to the live version.",
        canRestore: true,
      });
    } catch (err) {
      if (!this.closed) {
        this.view.setDetail({ heading: `Revision ${revision}`, diff: null, message: err instanceof Error ? err.message : "Failed to read revision.", canRestore: false });
      }
    }
  }

  private async restore(): Promise<void> {
    const revision = this.selected;
    if (revision === null) return;
    const bridge = requireBridge();
    const ok = await bridge.confirmDialog({
      title: "Restore revision",
      message: `Replace the live “${this.skill.name}” with revision ${revision}? The current version stays in history.`,
    });
    if (!ok || this.closed) return;
    this.view.setBusy(true);
    try {
      await bridge.restoreSkillRevision({ id: this.skill.id, revision });
      this.finish(true);
    } catch (err) {
      if (this.closed) return;
      this.view.setStatus(err instanceof Error ? err.message : "Failed to restore revision.");
      this.view.setBusy(false);
    }
  }

  private finish(restored: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.view.setOnClose(null);
    this.view.setOnSelect(null);
    this.view.setOnRestore(null);
    this.done(restored);
  }
}

function toRow(entry: SkillRevisionEntry): SkillHistoryRow {
  const when = formatRelativeTime(entry.savedAt);
  return {
    revision: entry.revision,
    current: entry.current,
    title: entry.current ? `Live · revision ${entry.revision}` : `Revision ${entry.revision}`,
    meta: entry.current
      ? `Updated ${when}`
      : `Replaced by ${skillOriginLabel(entry.replacedBy.actor)} · ${when}`,
    ...(entry.replacedBy.reason && !entry.current ? { reason: entry.replacedBy.reason } : {}),
  };
}

function sameFiles(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}
