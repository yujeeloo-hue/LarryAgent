/**
 * Dev Mode commit dialog — logic.
 *
 * Owns the bridge calls behind the dialog: `prepareCommit` for the model-written
 * draft and `commitWorkspace` for the commit itself, both scoped to the paths
 * the user picked in the Solution Outline.
 */
import { CommitDialogView } from "./CommitDialogView.js";

export type CommitDialogInput = {
  workspacePath: string;
  /** Workspace-relative paths to commit (never empty). */
  paths: string[];
  /** Dialog heading, e.g. `Commit "App.tsx"`. */
  title: string;
};

export type CommitDialogResult =
  | { committed: true; subject: string; shortHash: string }
  | { committed: false };

/**
 * Show the dialog and resolve once the user commits or dismisses it.
 * The dialog stays open on failure so the message is not lost.
 */
export function openCommitDialog(
  input: CommitDialogInput,
): Promise<CommitDialogResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommitDialogResult): void => {
      if (settled) return;
      settled = true;
      view.destroy();
      resolve(result);
    };

    const view = new CommitDialogView({
      title: input.title,
      files: input.paths,
      handlers: {
        onCancel: () => finish({ committed: false }),
        onGenerate: () => void generate(),
        onCommit: (message) => void commit(message),
      },
    });

    const generate = async (): Promise<void> => {
      const bridge = window.jellybot;
      if (!bridge) return;
      view.setBusy("generate");
      view.setStatus("Asking the model for a message…");
      try {
        const result = await bridge.prepareCommit(
          input.workspacePath,
          undefined,
          input.paths,
        );
        view.setMessage(result.draftMessage);
        view.setStatus(
          result.messageSource === "llm"
            ? null
            : "No model available — placeholder message inserted.",
          result.messageSource === "llm" ? "info" : "error",
        );
      } catch (err) {
        view.setStatus(
          `Could not generate a message — ${errorText(err)}`,
          "error",
        );
      } finally {
        view.setBusy(null);
      }
    };

    const commit = async (message: string): Promise<void> => {
      const bridge = window.jellybot;
      if (!bridge) return;
      view.setBusy("commit");
      view.setStatus("Committing…");
      try {
        const result = await bridge.commitWorkspace({
          workspacePath: input.workspacePath,
          message,
          paths: input.paths,
        });
        finish({
          committed: true,
          subject: result.subject,
          shortHash: result.shortHash,
        });
      } catch (err) {
        view.setBusy(null);
        view.setStatus(`Commit failed — ${errorText(err)}`, "error");
      }
    };

    view.mount();
  });
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron wraps handler throws with an IPC prefix — strip it for the card.
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").trim();
}
