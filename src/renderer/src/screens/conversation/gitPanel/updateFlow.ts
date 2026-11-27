import { UpdatePanelView, type UpdateChunk } from "./UpdatePanelView.js";

export type UpdatePanelOutcome = {
  /** The working copy received at least one path. */
  updated: boolean;
  /** The user picked sides for the conflicts SVN reported. */
  resolved: boolean;
};

export type SvnUpdateEventInput = SvnUpdateEventPayload["event"];

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").trim();
}

function runId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `svn-update-${Date.now()}`;
}

/**
 * Opens the SVN update dialog and drives one `svn update` run to completion.
 * Resolves when the panel closes — the caller refreshes VCS status afterwards.
 */
export async function openSvnUpdatePanel(input: {
  root: string;
  paths: string[];
  onCommit?: (() => void) | undefined;
  onBusyChange?: (busy: boolean, label?: string) => void;
}): Promise<UpdatePanelOutcome> {
  const bridge = window.jellybot;
  const outcome: UpdatePanelOutcome = { updated: false, resolved: false };
  if (!bridge) return outcome;

  return new Promise<UpdatePanelOutcome>(resolve => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let fromRevision: string | null = null;
    let currentRun = "";
    let stopping = false;
    const applied = new Map<string, UpdateChunk>();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      currentRun = "";
      unsubscribe?.();
      unsubscribe = null;
      view.destroy();
      resolve(outcome);
    };

    const view = new UpdatePanelView({
      handlers: {
        onCancel: () => finish(),
        onStop: () => void stop(),
        onResume: () => void start(),
        onApply: () => void apply(),
        onCommit: input.onCommit
          ? () => {
              const commit = input.onCommit;
              finish();
              commit?.();
            }
          : undefined,
      },
    });

    const endRun = (): void => {
      currentRun = "";
      stopping = false;
      input.onBusyChange?.(false);
    };

    const handle = (event: SvnUpdateEventInput): void => {
      switch (event.type) {
        case "start":
          fromRevision = event.fromRevision;
          view.setScope(fromRevision ? `r${fromRevision}` : "");
          return;
        case "reset":
          stopping = false;
          view.showRunning();
          return;
        case "line":
          view.appendLine({ letter: event.letter, path: event.path, bytes: event.bytes });
          outcome.updated = true;
          return;
        case "progress":
          view.setProgress(event);
          return;
        case "checking":
          stopping = false;
          view.showCheckingConflicts();
          input.onBusyChange?.(false);
          return;
        case "done":
          endRun();
          outcome.updated ||= event.paths > 0;
          if (event.conflicts.length > 0) {
            view.showConflicts({ fromRevision, ...event });
            return;
          }
          view.showResult({ fromRevision, ...event });
          return;
        case "stopped":
          endRun();
          fromRevision = event.fromRevision ?? fromRevision;
          view.showStopped({ fromRevision, paths: event.paths, bytes: event.bytes });
          return;
        case "error":
          endRun();
          view.showError(event.message);
          return;
      }
    };

    const start = async (): Promise<void> => {
      currentRun = runId();
      const run = currentRun;
      fromRevision = null;
      view.showRunning();
      view.setScope("");
      input.onBusyChange?.(true);
      try {
        const started = await bridge.startSvnUpdate(input.root, run, input.paths);
        if (!started.ok && currentRun === run) {
          handle({ type: "error", message: started.message ?? "Could not start the update." });
        }
      } catch (err) {
        if (currentRun === run) handle({ type: "error", message: errorText(err) });
      }
    };

    const stop = async (): Promise<void> => {
      if (!currentRun || stopping) return;
      const run = currentRun;
      stopping = true;
      view.setBusy(true);
      view.showWorking("Stopping…");
      input.onBusyChange?.(true, "Stopping…");
      try {
        const stopped = await bridge.cancelSvnUpdate(run);
        if (!stopped.ok) throw new Error("Could not stop the update.");
      } catch (err) {
        if (currentRun !== run || !stopping) return;
        stopping = false;
        view.setBusy(false);
        view.setStatus(errorText(err), "error");
        input.onBusyChange?.(true);
      }
    };

    const apply = async (): Promise<void> => {
      const choices = view.choices();
      const pending = view.undecided();
      if (pending.length > 0) {
        view.setStatus(`${pending.length} undecided`, "error");
        return;
      }
      view.setBusy(true);
      input.onBusyChange?.(true, "Resolving conflicts…");
      view.showWorking("Resolving conflicts…");
      const failures: string[] = [];
      try {
        for (const [path, choice] of choices) {
          if (applied.has(path)) continue;
          try {
            const result = await bridge.resolveSvnConflict(input.root, path, choice);
            if (!result.ok) {
              failures.push(result.message);
              continue;
            }
            applied.set(path, choice);
            view.lockChoice(path);
          } catch (err) {
            failures.push(errorText(err));
          }
        }
        if (failures.length > 0) {
          view.setStatus(failures.join(" · "), "error");
          return;
        }
        outcome.resolved = true;
        const counts: Record<UpdateChunk, number> = { mine: 0, theirs: 0, both: 0, working: 0 };
        for (const choice of applied.values()) counts[choice] += 1;
        view.showApplied(counts);
      } finally {
        view.setBusy(false);
        input.onBusyChange?.(false);
      }
    };

    unsubscribe = bridge.onSvnUpdateEvent(payload => {
      if (payload.runId !== currentRun) return;
      handle(payload.event);
    });
    void start();
    view.mount();
  });
}
