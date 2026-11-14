/**
 * Ghost-text completion for the Dev Mode editor.
 * Monaco paints the insertion; this module only decides when to ask and
 * cancels the in-flight request when the caret moves.
 */
import type * as MonacoTypes from "monaco-editor";
import {
  INLINE_PREFIX_CHARS,
  INLINE_SUFFIX_CHARS,
  sliceCompletionWindow,
} from "../../../llm/inlineCompletion.js";

const DEBOUNCE_MS = 160;

export type InlineCompletionHost = {
  isEnabled(): boolean;
  isDiffOpen(): boolean;
  isReadOnly(): boolean;
  sessionId(): string | null;
  workspacePath(): string | null;
};

type Cancellation = {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
};

type InlineModel = MonacoTypes.editor.ITextModel;

type CompleteBridge = {
  completeInlineCode?: (req: {
    requestId: string;
    sessionId?: string;
    workspacePath?: string;
    languageId: string;
    fileName: string;
    prefix: string;
    suffix: string;
  }) => Promise<{ text: string }>;
  cancelInlineCode?: (requestId: string) => void;
};

function bridge(): CompleteBridge {
  return (window as { jellybot?: CompleteBridge }).jellybot ?? {};
}

function fileNameOf(model: InlineModel): string {
  const path = model.uri.fsPath || model.uri.path || "";
  return (path.split(/[/\\]/).pop() ?? "").slice(0, 80);
}

function suggestIsOpen(editor: MonacoTypes.editor.IStandaloneCodeEditor): boolean {
  const contribution = editor.getContribution("editor.contrib.suggestController") as {
    model?: { state?: number };
  } | null;
  const state = contribution?.model?.state;
  return typeof state === "number" && state !== 0;
}

function windowAt(
  model: InlineModel,
  position: { lineNumber: number; column: number },
): { prefix: string; suffix: string } | null {
  const offset = model.getOffsetAt(position);
  const length = model.getValueLength();
  const start = Math.max(0, offset - (INLINE_PREFIX_CHARS + 400));
  const end = Math.min(length, offset + INLINE_SUFFIX_CHARS + 400);
  const startPos = model.getPositionAt(start);
  const endPos = model.getPositionAt(end);
  const slice = model.getValueInRange({
    startLineNumber: startPos.lineNumber,
    startColumn: startPos.column,
    endLineNumber: endPos.lineNumber,
    endColumn: endPos.column,
  });
  return sliceCompletionWindow(slice, offset - start);
}

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `inline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function attachInlineCompletion(
  monaco: {
    languages: {
      registerInlineCompletionsProvider(
        selector: string,
        provider: unknown,
      ): { dispose(): void };
    };
  },
  editor: MonacoTypes.editor.IStandaloneCodeEditor,
  host: InlineCompletionHost,
): { dispose(): void } {
  let activeId: string | null = null;

  const registration = monaco.languages.registerInlineCompletionsProvider("*", {
    debounceDelayMs: DEBOUNCE_MS,
    displayName: "Completion",
    provideInlineCompletions: async (
      model: InlineModel,
      position: { lineNumber: number; column: number },
      _context: unknown,
      token: Cancellation,
    ) => {
      const empty = { items: [] as { insertText: string }[] };
      if (!host.isEnabled() || host.isDiffOpen() || host.isReadOnly()) return empty;
      if (editor.getModel()?.uri.path !== model.uri.path) return empty;
      if (!editor.hasTextFocus()) return empty;
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) return empty;
      if (suggestIsOpen(editor)) return empty;
      const api = bridge().completeInlineCode;
      if (!api) return empty;
      const window = windowAt(model, position);
      if (!window) return empty;
      if (token.isCancellationRequested) return empty;

      if (activeId) bridge().cancelInlineCode?.(activeId);
      const id = requestId();
      activeId = id;
      const cancel = (): void => {
        if (activeId === id) activeId = null;
        bridge().cancelInlineCode?.(id);
      };
      const sub = token.onCancellationRequested(cancel);
      try {
        const sessionId = host.sessionId();
        const workspacePath = host.workspacePath();
        const result = await api({
          requestId: id,
          languageId: model.getLanguageId(),
          fileName: fileNameOf(model),
          prefix: window.prefix,
          suffix: window.suffix,
          ...(sessionId ? { sessionId } : {}),
          ...(workspacePath ? { workspacePath } : {}),
        });
        if (token.isCancellationRequested || activeId !== id) return empty;
        const text = typeof result?.text === "string" ? result.text : "";
        if (!text.trim()) return empty;
        return {
          items: [{ insertText: text }],
          enableForwardStability: true,
        };
      } catch {
        return empty;
      } finally {
        sub.dispose();
        if (activeId === id) activeId = null;
      }
    },
  });

  return {
    dispose(): void {
      if (activeId) bridge().cancelInlineCode?.(activeId);
      activeId = null;
      registration.dispose();
    },
  };
}
