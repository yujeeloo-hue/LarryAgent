import {
  CommitPanelView,
  type CommitPanelFile,
  type CommitPanelGroup,
} from "./CommitPanelView.js";
import type {
  CollaborativeCommitFile,
  CollaborativeRequest,
  CollaborativeResult,
} from "../../../../../shared/collaborative.js";

export type CommitPanelOutcome =
  | {
      committed: true;
      hash: string;
      shortHash: string;
      subject: string;
      message: string;
      vcs: "git" | "svn";
      messageSource?: "llm" | "fallback";
    }
  | { committed: false };

type CollabEntry = {
  repositoryId: string;
  file: CollaborativeCommitFile;
};

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").trim();
}

function relativeTo(root: string, absPath: string): string {
  const norm = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root);
  const target = norm(absPath);
  if (!base || !target.startsWith(`${base}/`)) return "";
  return target.slice(base.length + 1);
}

async function loadCollaborativeGroups(bridge: JellyBotBridge, workspacePath: string): Promise<{
  groups: CommitPanelGroup[];
  entries: Map<string, CollabEntry>;
}> {
  const collabEntries = new Map<string, CollabEntry>();
  const groups: CommitPanelGroup[] = [];

  // Collaborative branches are optional: a workspace without a bound repository
  // just shows its own working copy.
  try {
    const state = await bridge.collaborativeBranch({
      workspacePath,
      op: "state",
    });
    for (const repository of state.repositories ?? []) {
      if (!repository || repository.materialized.length === 0) continue;
      const result = await bridge.collaborativeBranch({
        workspacePath,
        repositoryId: repository.id,
        op: "editor-commit-files",
        editorDrafts: {},
      } satisfies CollaborativeRequest);
      const commitFiles = result.commitFiles ?? [];
      for (const file of commitFiles) {
        if (!file.changed && !file.added) continue;
        const id = `${repository.id}:${file.side}`;
        collabEntries.set(id, { repositoryId: repository.id, file });
        // Working-copy files diff against the repository root, branch files
        // against their own checkout.
        const diffRoot =
          file.side === "right" ? repository.binding?.directory ?? "" : repository.root;
        const diffPath = diffRoot ? relativeTo(diffRoot, file.diskPath) : "";
        groups.push({
          id,
          kind: "Collaborative",
          branch: file.branch,
          files: [{
            id,
            path: file.diskPath,
            status: file.added ? "added" : "modified",
            insertions: 0,
            deletions: 0,
            binary: false,
            selectable: !file.unavailable,
            checked: !file.unavailable,
            ...(file.unavailable ? { note: file.unavailable } : {}),
            ...(diffRoot && diffPath ? { diff: { root: diffRoot, path: diffPath } } : {}),
          }],
        });
      }
    }
  } catch (err) {
    console.debug("[commit-panel] collaborative state unavailable", err);
  }
  return { groups, entries: collabEntries };
}

export async function openCommitPanel(input: {
  workspacePath: string;
  workspaceName: string;
  providerId?: string | undefined;
  isChatBusy: () => boolean;
  onBusyChange?: (busy: boolean, label?: string) => void;
}): Promise<CommitPanelOutcome> {
  const bridge = window.jellybot;
  if (!bridge) return { committed: false };

  return new Promise<CommitPanelOutcome>(resolve => {
    let settled = false;
    let outcome: CommitPanelOutcome = { committed: false };
    let groups: CommitPanelGroup[] = [];
    let vcs: "git" | "svn" = "git";
    const committedIds = new Set<string>();
    const workspaceIds = new Set<string>();
    let collabEntries = new Map<string, CollabEntry>();
    let messageSource: "llm" | "fallback" | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      input.onBusyChange?.(false);
      view.destroy();
      resolve(outcome);
    };

    // The diff opens in the same standalone Changes window the git bar uses,
    // focused on the double-clicked file.
    const openDiff = (file: CommitPanelFile): void => {
      const target = file.diff;
      if (!target) {
        view.setStatus(`No diff available for ${file.path}.`, "error");
        return;
      }
      view.setStatus(null);
      void bridge
        .openWorkspaceChangesWindow(target.root, target.path)
        .catch(err => {
          if (settled) return;
          view.setStatus(`Could not open the diff — ${errorText(err)}`, "error");
        });
    };

    const selectedWorkspacePaths = (): string[] =>
      view.selectedIds().filter(id => workspaceIds.has(id));

    const selectedCollab = (): CollabEntry[] =>
      view
        .selectedIds()
        .map(id => collabEntries.get(id))
        .filter((entry): entry is CollabEntry => !!entry);

    const view = new CommitPanelView({
      title: `Commit · ${input.workspaceName}`,
      groups: null,
      handlers: {
        onCancel: finish,
        onGenerate: () => void generate(),
        onCommit: message => void commit(message),
        onOpenDiff: file => openDiff(file),
      },
    });

    const load = async (): Promise<void> => {
      input.onBusyChange?.(true, "Reading files…");
      try {
        const [changes, branch, collaborative] = await Promise.all([
          bridge.listWorkingTreeChanges(input.workspacePath),
          bridge.getGitBranchInfo(input.workspacePath).catch(() => null),
          loadCollaborativeGroups(bridge, input.workspacePath),
        ]);
        if (settled) return;
        collabEntries = collaborative.entries;
        groups = collaborative.groups;
        const isSvn = changes.vcs === "svn";
        vcs = isSvn ? "svn" : "git";
        if (changes.isRepo) {
          view.setTitle(`${isSvn ? "SVN" : "Git"} Commit · ${input.workspaceName}`);
        }
        if (changes.isRepo && changes.files.length) {
          const files: CommitPanelFile[] = changes.files.map(file => ({
            id: file.path,
            path: file.path,
            status: file.status,
            insertions: file.insertions,
            deletions: file.deletions,
            binary: file.binary,
            conflicted: file.conflicted === true,
            selectable: !file.conflicted,
            checked: !file.conflicted,
            diff: { root: input.workspacePath, path: file.path },
          }));
          for (const file of files) workspaceIds.add(file.id);
          groups.unshift({ id: "workspace", kind: "Working copy", branch: (!isSvn && branch?.branch) || "workspace", files });
        }
        view.setGroups(groups, changes.isRepo ? undefined : "Working copy unavailable.");
      } catch (err) {
        if (!settled) {
          view.setGroups([], "Could not load changed files.");
          view.setStatus(errorText(err), "error");
        }
      } finally {
        if (!settled) input.onBusyChange?.(false);
      }
    };

    const generate = async (): Promise<void> => {
      const paths = selectedWorkspacePaths();
      view.setBusy("generate");
      input.onBusyChange?.(true, "Generating…");
      view.setStatus("Asking the model for a message…");
      try {
        const result = await bridge.prepareCommit(
          input.workspacePath,
          input.providerId,
          paths.length > 0 ? paths : undefined,
        );
        if (settled) return;
        messageSource = result.messageSource;
        view.setMessage(result.draftMessage);
        view.setStatus(
          result.messageSource === "llm"
            ? null
            : "No model available — placeholder message inserted.",
          result.messageSource === "llm" ? undefined : "error",
        );
      } catch (err) {
        if (!settled) view.setStatus(`Could not generate a message — ${errorText(err)}`, "error");
      } finally {
        if (!settled) {
          view.setBusy(null);
          input.onBusyChange?.(false);
        }
      }
    };

    const commit = async (message: string): Promise<void> => {
      if (input.isChatBusy()) {
        view.setStatus("Wait for the current turn to finish before committing.", "error");
        return;
      }
      const paths = selectedWorkspacePaths();
      const collab = selectedCollab();
      view.setBusy("commit");
      view.showCommitting();
      input.onBusyChange?.(true, "Committing…");
      const failures: string[] = [];

      try {
        if (paths.length > 0) {
          try {
            const created = await bridge.commitWorkspace({
              workspacePath: input.workspacePath,
              message,
              paths,
            });
            outcome = {
              committed: true,
              hash: created.hash,
              shortHash: created.shortHash,
              subject: created.subject,
              message: created.message,
              vcs,
              ...(messageSource ? { messageSource } : {}),
            };
            for (const path of paths) committedIds.add(path);
          } catch (err) {
            failures.push(errorText(err));
          }
        }

        for (const entry of collab) {
          try {
            const result: CollaborativeResult = await bridge.collaborativeBranch({
              workspacePath: input.workspacePath,
              repositoryId: entry.repositoryId,
              op: "editor-commit",
              commitFiles: [entry.file],
              editorDrafts: {},
              message,
            });
            if (!result.commit) {
              failures.push(`${entry.file.branch}: ${result.commitError ?? "No commit was created"}`);
              continue;
            }
            committedIds.add(`${entry.repositoryId}:${entry.file.side}`);
            if (!outcome.committed) {
              outcome = {
                committed: true,
                hash: result.commit.shortHash,
                shortHash: result.commit.shortHash,
                subject: result.commit.subject,
                message,
                vcs,
                ...(messageSource ? { messageSource } : {}),
              };
            }
          } catch (err) {
            failures.push(`${entry.file.branch}: ${errorText(err)}`);
          }
        }
      } finally {
        view.setBusy(null);
        input.onBusyChange?.(false);
      }

      if (failures.length > 0) {
        if (committedIds.size) {
          view.setGroups(groups.map(group => ({
            ...group,
            files: group.files.filter(file => !committedIds.has(file.id)),
          })));
        }
        view.setStatus(failures.join(" · "), "error");
      } else if (outcome.committed) {
        finish();
      } else {
        view.setStatus("No files were committed.", "error");
      }
    };

    view.mount();
    void load();
  });
}
