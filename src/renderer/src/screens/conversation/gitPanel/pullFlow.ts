import { PullPanelView, type PullPanelFile } from "./PullPanelView.js";

export type PullPanelOutcome = {
  /** A pull (or merge completion) changed the working tree. */
  pulled: boolean;
  /** The merge was aborted back to the pre-pull state. */
  aborted: boolean;
};

type PreviewFile = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
};

function toPanelFiles(files: readonly PreviewFile[]): PullPanelFile[] {
  return files.map(file => ({
    path: file.path,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
  }));
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").trim();
}

function upstreamLabel(preview: { upstream: string; branch: string }): string {
  if (preview.upstream) return preview.upstream;
  if (preview.branch) return preview.branch;
  return "git";
}

export async function openPullPanel(input: {
  /** Repository root, not necessarily the workspace folder. */
  gitRoot: string;
  isChatBusy: () => boolean;
  /** Hands the conflicts to a CoCo session; false when no session could start. */
  startMergeSession: ((conflicts: string[], repoRoot: string) => boolean) | null;
  onEnableCoco: () => void;
  onBusyChange?: (busy: boolean, label?: string) => void;
}): Promise<PullPanelOutcome> {
  const bridge = window.jellybot;
  const outcome: PullPanelOutcome = { pulled: false, aborted: false };
  if (!bridge) return outcome;

  return new Promise<PullPanelOutcome>(resolve => {
    let settled = false;
    let conflicts: string[] = [];
    let incoming: PullPanelFile[] = [];

    const finish = (): void => {
      if (settled) return;
      settled = true;
      input.onBusyChange?.(false);
      view.destroy();
      resolve(outcome);
    };

    const rerenderMerge = (): void => {
      view.showMerge(conflicts, incoming);
    };

    const view = new PullPanelView({
      handlers: {
        onCancel: () => finish(),
        onPull: () => void pull(),
        onAbort: () => void abort(),
        onApply: () => void apply(),
        onResolveAi: () => void resolveWithAi(),
        onEnableCoco: () => {
          input.onEnableCoco();
          finish();
        },
        onReviewConflicts: () => rerenderMerge(),
        onRetryPreview: () => void loadPreview(),
      },
    });

    const loadPreview = async (): Promise<void> => {
      view.showLoading();
      input.onBusyChange?.(true, "Reading preview…");
      try {
        const preview = await bridge.getPullPreview(input.gitRoot);
        if (settled) return;
        if (!preview.isRepo) {
          view.showPreviewError("Git repository unavailable.");
          return;
        }
        conflicts = preview.conflicts;
        incoming = toPanelFiles(preview.incoming);
        view.setHeader(`Git Pull · ${upstreamLabel(preview)}`, "");
        if (preview.merging) {
          rerenderMerge();
        } else if (!preview.upstream) {
          view.showPreviewError("No upstream branch configured.");
        } else {
          view.showPreview(incoming, preview.behind, preview.ahead);
        }
      } catch (err) {
        if (!settled) view.showPreviewError(errorText(err));
      } finally {
        if (!settled) input.onBusyChange?.(false);
      }
    };

    const runOperation = async (text: string, operation: () => Promise<void>): Promise<void> => {
      view.setBusy(true);
      view.showWorking(text);
      input.onBusyChange?.(true, text);
      try {
        await operation();
      } catch (err) {
        view.setStatus(errorText(err), "error");
      } finally {
        view.setBusy(false);
        if (!settled) input.onBusyChange?.(false);
      }
    };

    const pull = async (): Promise<void> => {
      if (input.isChatBusy()) {
        view.setStatus("Wait for the current turn to finish before pulling.", "error");
        return;
      }
      await runOperation("Pulling…", async () => {
        const result = await bridge.pullWorkspace(input.gitRoot);
        conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
        if (conflicts.length > 0) {
          rerenderMerge();
          return;
        }
        if (!result.ok) throw new Error(result.message ?? "Pull failed");
        outcome.pulled = result.updated !== false;
        finish();
      });
    };

    const abort = async (): Promise<void> => {
      await runOperation("Aborting merge…", async () => {
        const result = await bridge.abortWorkspaceMerge(input.gitRoot);
        if (!result.ok) throw new Error(result.message ?? "Abort failed");
        outcome.pulled = false;
        outcome.aborted = true;
        view.showDone("Merge aborted.");
      });
    };

    const apply = async (): Promise<void> => {
      const choices = view.choices();
      const pending = view.undecided();
      if (pending.length > 0) {
        view.setStatus(`${pending.length} file${pending.length === 1 ? "" : "s"} still need a side.`, "error");
        return;
      }
      await runOperation(choices.size ? "Staging resolutions…" : "Finishing merge…", async () => {
        const failures: string[] = [];
        for (const [path, choice] of choices) {
          try {
            const result = await bridge.resolveMergeConflict(input.gitRoot, path, choice);
            if (!result.ok) failures.push(result.message);
            else conflicts = conflicts.filter(file => file !== path);
          } catch (err) {
            failures.push(errorText(err));
          }
        }
        if (choices.size) rerenderMerge();
        if (failures.length > 0) throw new Error(failures.join(" · "));
        if (choices.size) {
          view.setBusy(true);
          view.showWorking("Finishing merge…");
          input.onBusyChange?.(true, "Finishing merge…");
        }
        const done = await bridge.finishMerge(input.gitRoot);
        if (!done.ok) throw new Error(done.message);
        outcome.pulled = true;
        view.showDone(`Merge committed as ${done.shortHash}.`);
      });
    };

    const resolveWithAi = async (): Promise<void> => {
      if (input.isChatBusy()) {
        view.setStatus("Wait for the current turn to finish before starting a session.", "error");
        return;
      }
      if (conflicts.length === 0) return;
      await runOperation("Starting task session…", async () => {
        const snapshot = await bridge.cocoSnapshot().catch(() => null);
        const files = conflicts.slice();
        if (!snapshot?.settings.enabled || !input.startMergeSession?.(files, input.gitRoot)) {
          view.showAi({ state: "blocked", workspacePath: input.gitRoot, files });
          return;
        }
        view.showAi({ state: "started", workspacePath: input.gitRoot, files });
        setTimeout(finish, 1200);
      });
    };

    void loadPreview();
    view.mount();
  });
}
