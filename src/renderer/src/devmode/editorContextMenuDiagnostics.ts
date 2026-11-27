import type { editor, IDisposable } from "monaco-editor";
import type { MonacoApi } from "./monacoSetup.js";

const SETTLE_MS = 400;
const POLL_MS = 25;

type DiagnosticsMonaco = {
  editor: Pick<MonacoApi["editor"], "MouseTargetType" | "EditorOption">;
};

export function contextMenuVisible(root: ParentNode): boolean {
  const views: Element[] = Array.from(root.querySelectorAll(".context-view"));
  root.querySelectorAll(".shadow-root-host").forEach((host) => {
    host.shadowRoot?.querySelectorAll(".context-view").forEach((view) => views.push(view));
  });
  return views.some(
    (view) =>
      view instanceof HTMLElement &&
      view.style.display !== "none" &&
      view.childElementCount > 0,
  );
}

function describeElement(element: Element | null): string | null {
  if (!element) return null;
  const className = typeof element.className === "string" ? element.className.trim() : "";
  return (className ? `${element.tagName.toLowerCase()}.${className}` : element.tagName.toLowerCase()).slice(0, 80);
}

export function trackEditorContextMenu(
  monaco: DiagnosticsMonaco,
  target: editor.ICodeEditor,
  surface: string,
): IDisposable {
  const runs = new Set<() => void>();
  const menuTargets = new Set<number>([
    monaco.editor.MouseTargetType.CONTENT_TEXT,
    monaco.editor.MouseTargetType.CONTENT_EMPTY,
    monaco.editor.MouseTargetType.TEXTAREA,
  ]);
  const listener = target.onContextMenu((event) => {
    const startedAt = performance.now();
    const documentFocused = document.hasFocus();
    const menuShown = contextMenuVisible(document);
    const injectedText =
      event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT &&
      (event.target.detail as { injectedText?: unknown }).injectedText != null;
    const menuOption = target.getOption(monaco.editor.EditorOption.contextmenu);
    let windowBlurs = 0;
    let windowFocuses = 0;
    let menuHiddenAfterMs: number | null = null;
    const onBlur = (): void => {
      windowBlurs++;
    };
    const onFocus = (): void => {
      windowFocuses++;
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    const poll = window.setInterval(() => {
      if (menuShown && menuHiddenAfterMs === null && !contextMenuVisible(document)) {
        menuHiddenAfterMs = Math.round(performance.now() - startedAt);
      }
    }, POLL_MS);
    const stop = (): void => {
      runs.delete(stop);
      window.clearInterval(poll);
      window.clearTimeout(timer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
    const timer = window.setTimeout(() => {
      stop();
      window.jellybot?.logEditorContextMenu?.({
        surface,
        targetType: String(monaco.editor.MouseTargetType[event.target.type] ?? event.target.type),
        menuExpected: menuOption && menuTargets.has(event.target.type) && !injectedText,
        menuShown,
        menuOpenAfterSettle: contextMenuVisible(document),
        menuHiddenAfterMs,
        menuOption,
        hasModel: target.getModel() !== null,
        defaultPrevented: event.event.browserEvent.defaultPrevented,
        documentFocused,
        documentFocusedAfter: document.hasFocus(),
        visibility: document.visibilityState,
        windowBlurs,
        windowFocuses,
        activeElement: describeElement(document.activeElement),
      });
    }, SETTLE_MS);
    runs.add(stop);
  });
  return {
    dispose: () => {
      listener.dispose();
      for (const stop of Array.from(runs)) stop();
    },
  };
}
