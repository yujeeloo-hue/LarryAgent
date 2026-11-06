import { ArrowUp, Bot, Diff, GitCommitHorizontal } from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";

/**
 * Conversation footer git chrome — Changes with +/- line counts, Commit and
 * Subagent monitor. Commit click runs LLM message generation + commit with no
 * manual message UI. Subagent button shows the live queued/running count.
 */
export class ConversationGitBarView {
  readonly root: HTMLElement;
  private readonly changesButton: HTMLButtonElement;
  private readonly commitButton: HTMLButtonElement;
  private readonly pushButton: HTMLButtonElement;
  private readonly pushLabelEl: HTMLSpanElement;
  /** Live monitor toggle — public for overlay outside-click anchor checks. */
  readonly subagentButton: HTMLButtonElement;
  private readonly subagentLabelEl: HTMLSpanElement;
  private readonly insertionsEl: HTMLSpanElement;
  private readonly deletionsEl: HTMLSpanElement;
  private readonly labelEl: HTMLSpanElement;
  private busy = false;
  private hasStats = false;
  private hasPush = false;
  private subagentCount = 0;

  onChanges: (() => void) | null = null;
  onCommit: (() => void) | null = null;
  onPush: (() => void) | null = null;
  onSubagents: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "conversation-git-bar";
    this.root.hidden = true;

    const row = document.createElement("div");
    row.className = "conversation-git-bar-row";

    this.changesButton = document.createElement("button");
    this.changesButton.type = "button";
    this.changesButton.className = "conversation-git-changes-btn";
    this.changesButton.setAttribute("aria-label", "View changes");
    this.changesButton.title = "Changes";
    const changesIcon = createLucideIcon(Diff, { size: 14 });
    changesIcon.classList.add("conversation-git-commit-icon");
    const changesLabel = document.createElement("span");
    changesLabel.className = "conversation-git-changes-label";
    changesLabel.textContent = "Changes";

    this.insertionsEl = document.createElement("span");
    this.insertionsEl.className = "conversation-git-insertions";

    this.deletionsEl = document.createElement("span");
    this.deletionsEl.className = "conversation-git-deletions";

    this.changesButton.append(
      changesIcon,
      changesLabel,
      this.insertionsEl,
      this.deletionsEl,
    );
    this.changesButton.addEventListener("click", () => {
      if (this.busy) return;
      this.onChanges?.();
    });

    this.commitButton = document.createElement("button");
    this.commitButton.type = "button";
    this.commitButton.className = "conversation-git-commit-btn action-primary";
    this.commitButton.setAttribute("aria-label", "Commit changes");

    const icon = createLucideIcon(GitCommitHorizontal, { size: 14 });
    icon.classList.add("conversation-git-commit-icon");

    this.labelEl = document.createElement("span");
    this.labelEl.className = "conversation-git-commit-label";
    this.labelEl.textContent = "Commit";

    this.commitButton.append(icon, this.labelEl);
    this.commitButton.addEventListener("click", () => {
      if (this.busy) return;
      this.onCommit?.();
    });

    this.pushButton = document.createElement("button");
    this.pushButton.type = "button";
    this.pushButton.className = "conversation-git-push-btn action-primary";
    this.pushButton.setAttribute("aria-label", "Push commits");
    this.pushButton.title = "Push";
    const pushIcon = createLucideIcon(ArrowUp, { size: 14 });
    pushIcon.classList.add("conversation-git-commit-icon");
    this.pushLabelEl = document.createElement("span");
    this.pushLabelEl.className = "conversation-git-push-label";
    this.pushLabelEl.textContent = "Push";
    this.pushButton.append(pushIcon, this.pushLabelEl);
    this.pushButton.hidden = true;
    this.pushButton.addEventListener("click", () => {
      if (this.busy) return;
      this.onPush?.();
    });

    this.subagentButton = document.createElement("button");
    this.subagentButton.type = "button";
    this.subagentButton.className = "conversation-git-subagent-btn";
    this.subagentButton.setAttribute("aria-label", "View running subagents");
    this.subagentButton.title = "Running subagents";
    const subagentIcon = createLucideIcon(Bot, { size: 14 });
    subagentIcon.classList.add("conversation-git-commit-icon");
    this.subagentLabelEl = document.createElement("span");
    this.subagentLabelEl.className = "conversation-git-subagent-label";
    this.subagentLabelEl.textContent = "Subagent";
    this.subagentButton.append(subagentIcon, this.subagentLabelEl);
    this.subagentButton.hidden = true;
    this.subagentButton.addEventListener("click", () => {
      this.onSubagents?.();
    });

    row.append(
      this.changesButton,
      this.commitButton,
      this.pushButton,
      this.subagentButton,
    );
    this.root.append(row);
  }

  /** Hide unless there is a visible +N and/or -M count. */
  setStats(stats: {
    isRepo: boolean;
    insertions: number;
    deletions: number;
    dirtyFileCount: number;
    aheadCount?: number;
  } | null): void {
    const insertions = stats?.isRepo === true ? Math.max(0, stats.insertions) : 0;
    const deletions = stats?.isRepo === true ? Math.max(0, stats.deletions) : 0;
    this.hasStats = insertions > 0 || deletions > 0;
    // Push visibility rides the ahead count — a tree that is dirty-free
    // right after a commit keeps the bar alive via unpushed commits.
    const ahead =
      stats?.isRepo === true ? Math.max(0, stats.aheadCount ?? 0) : 0;
    this.hasPush = ahead > 0;
    this.pushButton.hidden = !this.hasPush;
    this.pushButton.disabled = this.busy;
    this.pushLabelEl.textContent = "Push";
    this.pushButton.title =
      ahead > 0 ? `Push — ${ahead} unpushed commit(s)` : "Push";
    // With stats the bar may stay alive via the Push button alone — hide
    // Changes/Commit so a fully-committed tree only shows what applies.
    this.changesButton.hidden = !this.hasStats;
    this.commitButton.hidden = !this.hasStats;
    if (!this.hasStats) {
      this.commitButton.disabled = false;
      this.changesButton.disabled = false;
      this.commitButton.classList.remove("is-loading");
      this.labelEl.textContent = "Commit";
      this.insertionsEl.hidden = true;
      this.deletionsEl.hidden = true;
    } else {
      this.insertionsEl.textContent = `+${formatCount(insertions)}`;
      this.deletionsEl.textContent = `-${formatCount(deletions)}`;
      this.insertionsEl.hidden = insertions <= 0;
      this.deletionsEl.hidden = deletions <= 0;
    }
    this.applyVisibility();
  }

  /** Live queued/running subagent count; 0 hides the button. */
  setSubagentCount(count: number): void {
    const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (next === this.subagentCount) return;
    this.subagentCount = next;
    this.subagentLabelEl.textContent =
      next > 0 ? `Subagent · ${next}` : "Subagent";
    this.applyVisibility();
  }

  /** Root visible when git stats exist OR any subagent is live. */
  private applyVisibility(): void {
    const visible = this.hasStats || this.hasPush || this.subagentCount > 0;
    this.root.hidden = !visible;
    if (!visible) {
      // Hidden bar → reset any transient commit busy state (old hide behavior).
      this.busy = false;
      this.commitButton.disabled = false;
      this.changesButton.disabled = false;
      this.pushButton.disabled = false;
      this.commitButton.classList.remove("is-loading");
      this.labelEl.textContent = "Commit";
    }
    this.subagentButton.hidden = this.subagentCount <= 0;
    this.subagentButton.classList.toggle(
      "is-running",
      this.subagentCount > 0,
    );
  }

  setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    this.commitButton.disabled = busy;
    this.changesButton.disabled = busy;
    this.pushButton.disabled = busy;
    this.commitButton.classList.toggle("is-loading", busy);
    this.labelEl.textContent = busy ? (label ?? "Committing…") : "Commit";
  }

  /** Push-in-flight state — mirrors setBusy but scoped to the Push button. */
  setPushBusy(busy: boolean): void {
    this.busy = busy;
    this.commitButton.disabled = busy;
    this.changesButton.disabled = busy;
    this.pushButton.disabled = busy;
    this.pushLabelEl.textContent = busy ? "Pushing…" : "Push";
  }
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  return String(Math.floor(n));
}
