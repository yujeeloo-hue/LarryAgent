import { CommitDialogView } from "./CommitDialogView.js";
import type {
  CollaborativeEditorDraft,
  CollaborativeRequest,
  CollaborativeResult,
  CollaborativeSide,
} from "../../../shared/collaborative.js";

export type CommitDialogInput = {
  workspacePath: string;
  paths: string[];
  title: string;
};

export type CommitDialogResult =
  | { committed: true; subject: string; shortHash: string }
  | { committed: false };

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

type BranchCommitRequest = Pick<CollaborativeRequest, "commitFiles" | "editorDrafts" | "message"> & {
  op: "editor-commit-files" | "editor-commit-message" | "editor-commit";
};

export async function openBranchCommitDialog(input: {
  title: string;
  signal: AbortSignal;
  request: (request: BranchCommitRequest) => Promise<CollaborativeResult>;
  readDrafts: () => Partial<Record<CollaborativeSide, CollaborativeEditorDraft>>;
  onDraftSaved: (side: CollaborativeSide, draft: CollaborativeEditorDraft, result: CollaborativeResult) => void;
  isChatBusy: () => boolean;
}): Promise<void> {
  if (input.signal.aborted) return;
  const { commitFiles = [] } = await input.request({ op: "editor-commit-files", editorDrafts: input.readDrafts() });
  if (input.signal.aborted) return;

  return new Promise(resolve => {
    let closed = false;
    const close = (): void => {
      closed = true;
      input.signal.removeEventListener("abort", close);
      view.destroy();
      resolve();
    };
    const view = new CommitDialogView({
      title: input.title,
      files: [],
      branchFiles: commitFiles,
      handlers: {
        onCancel: close,
        onGenerate: () => void generate(),
        onCommit: message => void commit(message),
      },
    });

    const generate = async (): Promise<void> => {
      view.setBusy("generate");
      view.setStatus("Asking the model for a message…");
      try {
        const { commitMessage } = await input.request({
          op: "editor-commit-message",
          commitFiles: view.selectedBranchFiles(),
          editorDrafts: input.readDrafts(),
        });
        if (closed) return;
        if (!commitMessage) throw new Error("No commit message was generated");
        view.setMessage(commitMessage.message);
        view.setStatus(commitMessage.source === "llm" ? null : "No model available. A placeholder message was inserted.");
      } catch (error) {
        if (!closed) view.setStatus(`Could not generate a message — ${errorText(error)}`, "error");
      } finally {
        if (!closed) view.setBusy(null);
      }
    };

    const commit = async (message: string): Promise<void> => {
      if (input.isChatBusy()) {
        view.setStatus("Wait for the current turn to finish before committing.", "error");
        return;
      }
      const selected = view.selectedBranchFiles();
      view.setBusy("commit");
      view.setStatus("Committing selected files…");
      const errors: string[] = [];
      for (const file of selected) {
        view.setBranchStatus(file.side, "Committing…");
        try {
          const editorDrafts = input.readDrafts();
          const result = await input.request({ op: "editor-commit", commitFiles: [file], editorDrafts, message });
          if (closed) return;
          const draft = editorDrafts[file.side];
          if (result.draftSaved && draft) input.onDraftSaved(file.side, draft, result);
          if (!result.commit) {
            const retryFile = result.commitFiles?.[0];
            if (retryFile) view.refreshBranchFile(retryFile);
            throw new Error(result.commitError ?? "No commit was created");
          }
          view.setBranchStatus(file.side, `✓ ${result.commit.shortHash}`, true);
        } catch (error) {
          if (closed) return;
          view.setBranchStatus(file.side, "Failed");
          errors.push(`${file.branch}: ${errorText(error)}`);
        }
      }
      if (errors.length) {
        view.setBusy(null);
        view.setStatus(errors.join(" · "), "error");
      } else {
        view.finishBranches();
        view.setStatus("Selected files committed.");
      }
    };

    input.signal.addEventListener("abort", close, { once: true });
    if (commitFiles.every(file => !file.changed)) view.setStatus("No changes to commit.");
    view.mount();
  });
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").trim();
}
