import { ArrowDown, ArrowUp, Bot, Diff, GitCommitHorizontal, RefreshCw } from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";

/**
 * Conversation footer VCS chrome — Changes with +/- line counts, Commit,
 * Update, Pull, Push and the Subagent monitor. Commit click runs LLM message
 * generation + commit with no manual message UI. Update runs `svn update`
 * and appears only when the working copy is behind HEAD. Pull runs
 * `git pull` on the workspace Git repo, or on the associated engine repo
 * when the workspace itself is SVN, and appears only when that repo is
 * behind its upstream.
 * A pull conflict hands off to the merge-resolution flow.
 * Subagent button shows the live queued/running count.
 */
export class ConversationGitBarView {
  readonly root: HTMLElement;
  private readonly changesButton: HTMLButtonElement;
  private readonly commitButton: HTMLButtonElement;
  private readonly updateButton: HTMLButtonElement;
  private readonly pullButton: HTMLButtonElement;
  private readonly pushButton: HTMLButtonElement;
  private readonly pushLabelEl: HTMLSpanElement;
  private readonly updateLabelEl: HTMLSpanElement;
  private readonly pullLabelEl: HTMLSpanElement;
  /** Live monitor toggle — public for overlay outside-click anchor checks. */
  readonly subagentButton: HTMLButtonElement;
  private readonly subagentLabelEl: HTMLSpanElement;
  private readonly insertionsEl: HTMLSpanElement;
  private readonly deletionsEl: HTMLSpanElement;
  private readonly labelEl: HTMLSpanElement;
  private busy = false;
  private hasStats = false;
  private hasPush = false;
  /** Workspace is an SVN working copy. */
  private svnEnabled = false;
  /** Working copy root is behind repository HEAD. */
  private svnBehind = false;
  /** A Git toplevel exists (workspace or its engine). */
  private gitEnabled = false;
  /** Pull targets the engine repo, not the workspace itself. */
  private gitExternal = false;
  /** Behind count comes from workspace stats (same repo) rather than a side call. */
  private gitBehindFromWorkspace = false;
  private behindCount = 0;
  /** Last background fetch failed — upstream state unknown, keep Pull reachable. */
  private pullUncertain = false;
  private subagentCount = 0;

  onChanges: (() => void) | null = null;
  onCommit: (() => void) | null = null;
  onUpdate: (() => void) | null = null;
  onPull: (() => void) | null = null;
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

    this.updateButton = document.createElement("button");
    this.updateButton.type = "button";
    this.updateButton.className =
      "conversation-git-push-btn conversation-git-update-btn action-primary";
    this.updateButton.setAttribute("aria-label", "Update working copy");
    this.updateButton.title = "Update the SVN working copy";
    const updateIcon = createLucideIcon(RefreshCw, { size: 14 });
    updateIcon.classList.add("conversation-git-commit-icon");
    this.updateLabelEl = document.createElement("span");
    this.updateLabelEl.className = "conversation-git-push-label";
    this.updateLabelEl.textContent = "Update";
    this.updateButton.append(updateIcon, this.updateLabelEl);
    this.updateButton.hidden = true;
    this.updateButton.addEventListener("click", () => {
      if (this.busy) return;
      this.onUpdate?.();
    });

    this.pullButton = document.createElement("button");
    this.pullButton.type = "button";
    // Twin of the Push button — shares its chrome class (zero CSS churn)
    // plus its own hook class for styling/testing.
    this.pullButton.className =
      "conversation-git-push-btn conversation-git-pull-btn action-primary";
    this.pullButton.setAttribute("aria-label", "Pull latest changes");
    this.pullButton.title = "Pull latest changes from the upstream branch";
    const pullIcon = createLucideIcon(ArrowDown, { size: 14 });
    pullIcon.classList.add("conversation-git-commit-icon");
    this.pullLabelEl = document.createElement("span");
    this.pullLabelEl.className = "conversation-git-push-label";
    this.pullLabelEl.textContent = "Pull";
    this.pullButton.append(pullIcon, this.pullLabelEl);
    this.pullButton.hidden = true;
    this.pullButton.addEventListener("click", () => {
      if (this.busy) return;
      this.onPull?.();
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
      this.updateButton,
      this.pullButton,
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
    behindCount?: number;
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
    // Workspace Git: behind count rides the same stats scan. An engine Git
    // repo is a different toplevel — setGitBehind owns that count.
    if (this.gitBehindFromWorkspace) {
      this.behindCount =
        stats?.isRepo === true ? Math.max(0, stats.behindCount ?? 0) : 0;
      this.applyPullVisibility();
    }
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

  /** Root visible when git stats exist, a sync action is offered, or subagents are live. */
  private applyVisibility(): void {
    const visible =
      this.hasStats ||
      this.hasPush ||
      !this.updateButton.hidden ||
      !this.pullButton.hidden ||
      this.subagentCount > 0;
    this.root.hidden = !visible;
    if (!visible) {
      // Hidden bar → reset any transient commit busy state (old hide behavior).
      this.busy = false;
      this.commitButton.disabled = false;
      this.changesButton.disabled = false;
      this.pushButton.disabled = false;
      this.updateButton.disabled = false;
      this.pullButton.disabled = false;
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
    this.updateButton.disabled = busy;
    this.pullButton.disabled = busy;
    this.commitButton.classList.toggle("is-loading", busy);
    this.labelEl.textContent = busy ? (label ?? "Committing…") : "Commit";
  }

  /** Push-in-flight state — mirrors setBusy but scoped to the Push button. */
  setPushBusy(busy: boolean): void {
    this.busy = busy;
    this.commitButton.disabled = busy;
    this.changesButton.disabled = busy;
    this.pushButton.disabled = busy;
    this.updateButton.disabled = busy;
    this.pullButton.disabled = busy;
    this.pushLabelEl.textContent = busy ? "Pushing…" : "Push";
  }

  /** Update-in-flight state — `svn update` on the workspace working copy. */
  setUpdateBusy(busy: boolean): void {
    this.busy = busy;
    this.commitButton.disabled = busy;
    this.changesButton.disabled = busy;
    this.pushButton.disabled = busy;
    this.updateButton.disabled = busy;
    this.pullButton.disabled = busy;
    this.updateLabelEl.textContent = busy ? "Updating…" : "Update";
  }

  /** Pull-in-flight state — mirrors setPushBusy but scoped to the Pull button. */
  setPullBusy(busy: boolean): void {
    this.busy = busy;
    this.commitButton.disabled = busy;
    this.changesButton.disabled = busy;
    this.pushButton.disabled = busy;
    this.updateButton.disabled = busy;
    this.pullButton.disabled = busy;
    this.pullLabelEl.textContent = busy ? "Pulling…" : "Pull";
  }

  /**
   * Background-fetch outcome. A failed check does not reveal Pull: the
   * button means commits are waiting. The title notes an unknown count
   * only while a positive behind count is already showing.
   */
  setPullUncertain(uncertain: boolean): void {
    this.pullUncertain = uncertain;
    this.applyPullVisibility();
    this.applyVisibility();
  }

  /**
   * Which sync buttons exist. Update tracks SVN at the workspace. Pull
   * tracks a Git toplevel — `workspace` when that toplevel is this project,
   * `external` when it is the associated engine. Neither button is inferred
   * from `isRepo` (SVN stats also set that flag).
   */
  setSyncTargets(targets: { svn: boolean; git: "none" | "workspace" | "external" }): void {
    this.svnEnabled = targets.svn;
    if (!this.svnEnabled) this.svnBehind = false;
    this.gitEnabled = targets.git !== "none";
    this.gitExternal = targets.git === "external";
    this.gitBehindFromWorkspace = targets.git === "workspace";
    if (!this.gitEnabled) {
      this.behindCount = 0;
      this.pullUncertain = false;
    }
    this.applyUpdateVisibility();
    this.applyPullVisibility();
    this.applyVisibility();
  }

  /** Behind count for an engine (or other non-workspace) Git toplevel. */
  setGitBehind(count: number): void {
    if (!this.gitEnabled || this.gitBehindFromWorkspace) return;
    this.behindCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    this.applyPullVisibility();
    this.applyVisibility();
  }

  /** True only when a poll has seen HEAD ahead of the working copy. */
  setSvnBehind(behind: boolean): void {
    this.svnBehind = behind && this.svnEnabled;
    this.applyUpdateVisibility();
    this.applyVisibility();
  }

  private applyUpdateVisibility(): void {
    this.updateButton.hidden = !(this.svnEnabled && this.svnBehind);
    this.updateButton.disabled = this.busy;
  }

  /** Pull shows only when the Git target has commits we have not pulled. */
  private applyPullVisibility(): void {
    const show = this.gitEnabled && this.behindCount > 0;
    this.pullButton.hidden = !show;
    this.pullButton.disabled = this.busy;
    const where = this.gitExternal
      ? "the engine Git repository"
      : "the upstream branch";
    this.pullButton.title =
      this.behindCount > 0
        ? this.gitExternal
          ? `Pull engine — ${this.behindCount} commit(s) behind`
          : `Pull — ${this.behindCount} commit(s) behind the upstream`
        : this.pullUncertain
          ? "Pull latest changes (upstream status unknown — last check failed)"
          : `Pull latest changes from ${where}`;
  }
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  return String(Math.floor(n));
}
