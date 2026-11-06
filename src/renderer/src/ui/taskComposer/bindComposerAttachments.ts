import type { TaskComposerView } from "./TaskComposerView.js";

export type PendingAttachment = {
  id: string;
  path: string;
  name: string;
  kind: string;
  mimeType: string;
  sizeBytes?: number;
};

type PickMode = "images" | "files";

function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

/**
 * Bind Image + Attachments buttons, the shared chip strip, and file
 * drag-and-drop on a composer. Controllers own send / busy state via
 * syncSendEnabled.
 */
export function bindComposerAttachments(input: {
  composer: TaskComposerView;
  syncSendEnabled: () => void;
}): {
  getAttachments: () => PendingAttachment[];
  /** Re-attach drafts (STOP-rollback restore) — path-deduped, then renders. */
  restore: (drafts: PendingAttachment[]) => void;
  clear: () => void;
  destroy: () => void;
} {
  let items: PendingAttachment[] = [];
  let picking = false;
  /** enter/leave counter — children fire pairs of events; 0 = truly outside. */
  let dragDepth = 0;

  const render = (): void => {
    input.composer.setAttachments(
      items.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        ...(item.sizeBytes !== undefined
          ? { sizeBytes: item.sizeBytes }
          : {}),
      })),
    );
    input.syncSendEnabled();
  };

  const mergeDrafts = (
    drafts: Iterable<{
      path: string;
      name: string;
      kind: string;
      mimeType: string;
      sizeBytes?: number;
    }>,
  ): void => {
    const existing = new Set(items.map((item) => item.path));
    let added = false;
    for (const draft of drafts) {
      if (existing.has(draft.path)) continue;
      const next: PendingAttachment = {
        id: crypto.randomUUID(),
        path: draft.path,
        name: draft.name,
        kind: draft.kind,
        mimeType: draft.mimeType,
      };
      if (typeof draft.sizeBytes === "number") {
        next.sizeBytes = draft.sizeBytes;
      }
      items.push(next);
      existing.add(draft.path);
      added = true;
    }
    if (added) render();
  };

  const bridge = window.jellybot;

  const pickFiles = async (mode: PickMode): Promise<void> => {
    if (picking) return;
    if (typeof bridge?.pickAttachmentFiles !== "function") {
      window.alert(
        "Restart the app to enable attachments (preload outdated).",
      );
      return;
    }
    picking = true;
    try {
      const picked = await bridge.pickAttachmentFiles(mode);
      if (!picked.length) return;
      mergeDrafts(picked);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      window.alert(message);
    } finally {
      picking = false;
    }
  };

  const onImagesClick = (): void => {
    void pickFiles("images");
  };
  const onAttachmentsClick = (): void => {
    void pickFiles("files");
  };

  const onDragEnter = (event: DragEvent): void => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    input.composer.setFileDragOver(true);
  };

  const onDragOver = (event: DragEvent): void => {
    if (!dragHasFiles(event)) return;
    // Required so the browser lets us handle the drop (no default insert /
    // navigation of the dropped file path).
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent): void => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) input.composer.setFileDragOver(false);
  };

  const onDrop = (event: DragEvent): void => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    input.composer.setFileDragOver(false);

    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    if (
      typeof bridge?.attachmentPathForFile !== "function" ||
      typeof bridge.resolveAttachmentPaths !== "function"
    ) {
      window.alert(
        "Restart the app to enable attachments (preload outdated).",
      );
      return;
    }

    const paths = files
      .map((file) => bridge.attachmentPathForFile(file))
      .filter((path) => path.length > 0);
    if (paths.length === 0) return;

    void bridge
      .resolveAttachmentPaths(paths)
      .then((drafts) => {
        // Unreadable / directory paths are filtered out main-side.
        mergeDrafts(drafts);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        window.alert(message);
      });
  };

  const root = input.composer.root;
  root.addEventListener("dragenter", onDragEnter);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("dragleave", onDragLeave);
  root.addEventListener("drop", onDrop);

  input.composer.setOnRemoveAttachment((id) => {
    items = items.filter((item) => item.id !== id);
    render();
  });
  input.composer.imagesButton.addEventListener("click", onImagesClick);
  input.composer.attachmentsButton.addEventListener(
    "click",
    onAttachmentsClick,
  );
  render();

  return {
    getAttachments: () => items.map((item) => ({ ...item })),
    restore: (drafts: PendingAttachment[]) => {
      mergeDrafts(drafts);
    },
    clear: () => {
      items = [];
      render();
    },
    destroy: () => {
      root.removeEventListener("dragenter", onDragEnter);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
      input.composer.imagesButton.removeEventListener("click", onImagesClick);
      input.composer.attachmentsButton.removeEventListener(
        "click",
        onAttachmentsClick,
      );
      input.composer.setOnRemoveAttachment(null);
      input.composer.setFileDragOver(false);
      items = [];
    },
  };
}
