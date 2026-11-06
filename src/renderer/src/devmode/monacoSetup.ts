/**
 * Monaco bootstrap for Dev Mode (plan: dev-mode-v1).
 *
 * - Lazy: nothing here (nor monaco itself, ~3MB) loads until the first Dev
 *   Mode toggle dynamically imports this module.
 * - file://-safe workers: vite `?worker&inline` emits blob-URL workers
 *   (CSP: `worker-src 'self' blob:` added in index.html). Classic `new
 *   Worker(file://…)` is blocked by Chromium — this is the only robust path.
 * - Degradation: if blob workers still fail (exotic CSP/policy), a null
 *   worker keeps the editor alive — Monarch tokenization runs on the main
 *   thread regardless; only language services (completion/validation for
 *   TS/JS/CSS/HTML/JSON) go dark. Warn once per label.
 */
// monaco-editor ≥0.5x exports remap subpaths under ./esm/vs/* — specifiers
// must NOT carry the esm/vs prefix (it would double-map and fail resolution).
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker&inline";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker&inline";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker&inline";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker&inline";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker&inline";
import {
  conf as stockCppConf,
  language as stockCppLanguage,
} from "monaco-editor/languages/definitions/cpp/cpp.js";
import type * as MonacoNs from "monaco-editor";
import { buildUnrealCppLanguage } from "./unrealCppTokens.js";
import { buildCppLanguageConfiguration } from "./cppLanguageConfig.js";

export type MonacoApi = typeof MonacoNs;

/** Argument type of setMonarchTokensProvider — IMonarchTokensProvider. */
type MonarchLanguageArg = Parameters<
  MonacoApi["languages"]["setMonarchTokensProvider"]
>[1];

export const DEV_MODE_THEME = "jellybot-dark";
export const DEV_MODE_LIGHT_THEME = "jellybot-dark-system-blue";

/** Keep the code canvas dark; only Light's editor interaction accent changes. */
export function resolveDevModeTheme(): string {
  return document.documentElement.dataset.theme === "light"
    ? DEV_MODE_LIGHT_THEME
    : DEV_MODE_THEME;
}

/**
 * Editor canvas + gutter color — matches the app's --bg-main surface
 * (rgba(8, 8, 8, 0.8)) so the canvas sits flush with the surrounding panes
 * and lets the macOS vibrancy peek through like the rest of the shell.
 * Exported because the editor host's 10px left padding (devmode.css) is
 * painted with this exact color so the gap reads as part of the gutter.
 */
export const DEV_MODE_EDITOR_BG = "#080808cc";

let monacoPromise: Promise<MonacoApi> | null = null;
let themeObserver: MutationObserver | null = null;

export function loadMonaco(): Promise<MonacoApi> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      const monaco = await import("monaco-editor");
      installWorkers();
      defineTheme(monaco);
      installUnrealCpp(monaco);
      monaco.editor.setTheme(resolveDevModeTheme());
      observeAppTheme(monaco);
      remeasureAfterFontsLoad(monaco);
      return monaco;
    })();
  }
  return monacoPromise;
}

/** Follow runtime Light/Dark switches without rebuilding open editors. */
function observeAppTheme(monaco: MonacoApi): void {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => {
    monaco.editor.setTheme(resolveDevModeTheme());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

/**
 * Unreal C++ pack: replaces the stock cpp Monarch tokenizer with an
 * extended clone (reflection macros + specifier args, GENERATED/DECLARE/
 * IMPLEMENT families, UE type/bool naming). The stock definition is
 * dependency-free, so the static import stays tiny. The language
 * configuration is the stock one plus Rider-like editing rules
 * (cppLanguageConfig.ts); the language id remains "cpp".
 */
function installUnrealCpp(monaco: MonacoApi): void {
  monaco.languages.setMonarchTokensProvider(
    "cpp",
    buildUnrealCppLanguage(stockCppLanguage) as MonarchLanguageArg,
  );
  // Bracket auto-close / indent / doc-comment rules. Monaco's lazy loader
  // registers the stock cpp configuration asynchronously the first time a
  // cpp model appears, and the latest registration wins — so register ours
  // now and again right after that stock registration has landed.
  const config = buildCppLanguageConfiguration(stockCppConf) as unknown as Parameters<
    MonacoApi["languages"]["setLanguageConfiguration"]
  >[1];
  monaco.languages.setLanguageConfiguration("cpp", config);
  monaco.languages.onLanguageEncountered("cpp", () => {
    // Await the same module the stock loader imports, then yield a macrotask
    // so its continuation (setLanguageConfiguration) has already run.
    void import("monaco-editor/languages/definitions/cpp/cpp.js")
      .catch(() => undefined)
      .then(() => {
        window.setTimeout(() => monaco.languages.setLanguageConfiguration("cpp", config), 0);
      });
  });
}

/**
 * Webfont timing: the bundled "JetBrains Mono Var" loads asynchronously, so
 * Monaco can measure glyph widths with the fallback font first — cursor
 * misalignment / wrong wrapping that persists until something else triggers
 * a re-layout. Once every pending font settles, force Monaco to re-measure.
 * Cheap (no-op after the first run) and macOS-exact when no webfont loads.
 */
function remeasureAfterFontsLoad(monaco: MonacoApi): void {
  document.fonts?.ready
    .then(() => {
      try {
        monaco.editor.remeasureFonts();
      } catch {
        // older monaco without the API — a relayout also re-measures
        }
    })
    .catch(() => undefined);
}

// ------------------------------------------------------------------ workers

const degradedLabels = new Set<string>();

/** Structurally-satisfies Worker; language services silently no-op. */
function nullWorker(label: string): Worker {
  if (!degradedLabels.has(label)) {
    degradedLabels.add(label);
    console.warn(
      `[devmode] Monaco worker "${label}" unavailable — degrading to main-thread highlighting (language services off)`,
    );
  }
  return {
    postMessage: () => undefined,
    terminate: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
    onmessage: null,
    onerror: null,
  } as unknown as Worker;
}

function installWorkers(): void {
  const scope = self as typeof self & {
    MonacoEnvironment?: MonacoNs.Environment;
  };
  scope.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      try {
        switch (label) {
          case "typescript":
          case "javascript":
            return new TsWorker();
          case "json":
            return new JsonWorker();
          case "css":
          case "scss":
          case "less":
            return new CssWorker();
          case "html":
          case "handlebars":
          case "razor":
            return new HtmlWorker();
          default:
            return new EditorWorker();
        }
      } catch (err) {
        console.warn("[devmode] worker construction failed:", err);
        return nullWorker(label);
      }
    },
  };
}

// -------------------------------------------------------------------- theme

/**
 * Palette: app tokens (#141414 bg / #e8e8e8 fg / #7ec8c8 accent) + a
 * github-dark-flavoured syntax map so Dev Mode matches the File Reader /
 * chat code blocks (hljs github-dark).
 */
function defineTheme(monaco: MonacoApi): void {
  const darkTheme: MonacoNs.editor.IStandaloneThemeData = {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "e8e8e8" },
      { token: "comment", foreground: "8b949e", fontStyle: "italic" },
      { token: "keyword", foreground: "ff7b72" },
      { token: "keyword.flow", foreground: "ff7b72" },
      { token: "string", foreground: "a5d6ff" },
      { token: "string.escape", foreground: "79c0ff" },
      { token: "string.escape.delimiter", foreground: "8b949e" },
      { token: "number", foreground: "79c0ff" },
      { token: "number.hex", foreground: "79c0ff" },
      { token: "regexp", foreground: "7ee787" },
      { token: "regexp.escape", foreground: "79c0ff" },
      { token: "type", foreground: "7ec8c8" },
      { token: "type.identifier", foreground: "7ec8c8" },
      { token: "namespace", foreground: "7ec8c8" },
      { token: "annotation", foreground: "d2a8ff" },
      { token: "annotation.ue", foreground: "d2a8ff", fontStyle: "bold" },
      { token: "annotation.ue.meta", foreground: "b392f0", fontStyle: "italic" },
      { token: "function", foreground: "d2a8ff" },
      { token: "support.function", foreground: "d2a8ff" },
      { token: "identifier", foreground: "e8e8e8" },
      { token: "variable", foreground: "ffa657" },
      { token: "variable.ue", foreground: "ffa657" },
      { token: "variable.predefined", foreground: "ffa657" },
      { token: "variable.parameter", foreground: "ffa657" },
      { token: "constant", foreground: "79c0ff" },
      { token: "operator", foreground: "ff7b72" },
      { token: "delimiter", foreground: "e8e8e8" },
      { token: "delimiter.html", foreground: "8b949e" },
      { token: "tag", foreground: "7ee787" },
      { token: "metatag", foreground: "ff7b72" },
      { token: "attribute.name", foreground: "79c0ff" },
      { token: "attribute.value", foreground: "a5d6ff" },
      { token: "attribute.value.html", foreground: "a5d6ff" },
      // Unreal C++ pack (unrealCppTokens.ts): reflection macros, their
      // specifier args, macro families, and UE type/bool naming.
      { token: "keyword.ue", foreground: "ffa657", fontStyle: "bold" },
      { token: "type.ue", foreground: "7ec8c8" },
    ],
    colors: {
      "editor.background": DEV_MODE_EDITOR_BG,
      "editor.foreground": "#e8e8e8",
      "editorLineNumber.foreground": "#4d545c",
      "editorLineNumber.activeForeground": "#9a9a9a",
      "editorCursor.foreground": "#7ec8c8",
      "editor.selectionBackground": "#7ec8c838",
      "editor.inactiveSelectionBackground": "#7ec8c820",
      "editor.lineHighlightBackground": "#ffffff08",
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background1": "#ffffff0f",
      "editorIndentGuide.activeBackground1": "#ffffff26",
      "editorWhitespace.foreground": "#ffffff1a",
      "editorBracketMatch.background": "#7ec8c826",
      "editorBracketMatch.border": "#7ec8c866",
      "editorGutter.background": DEV_MODE_EDITOR_BG,
      // Side-by-side diff: same add/remove hues as the chat diff cards
      // (#3fb950 / --danger #f85149). The +/- gutter signs are tinted to
      // match in devmode.css.
      "diffEditor.insertedLineBackground": "#3fb95021",
      "diffEditor.insertedTextBackground": "#3fb95033",
      "diffEditor.removedLineBackground": "#f8514921",
      "diffEditor.removedTextBackground": "#f8514933",
      "diffEditorGutter.insertedLineBackground": "#3fb9501a",
      "diffEditorGutter.removedLineBackground": "#f851491a",
      "diffEditorOverview.insertedForeground": "#3fb95066",
      "diffEditorOverview.removedForeground": "#f8514966",
      "diffEditor.border": "#ffffff12",
      "diffEditor.diagonalFill": "#ffffff0d",
      "editorWidget.background": "#1b1b1b",
      "editorWidget.border": "#ffffff12",
      "editorHoverWidget.border": "#ffffff12",
      // Right-click context menu (light-DOM chrome styled in devmode.css):
      // darker frosted surface + the app's hover wash on rows instead
      // of VS Code's default blue selection.
      "menu.background": "#0f0f0ff2",
      "menu.foreground": "#e8e8e8",
      "menu.separatorBackground": "#ffffff14",
      "editorActionList.background": "#0f0f0ff2",
      "editorActionList.foreground": "#e8e8e8",
      "editorActionList.focusBackground": "#7ec8c826",
      "editorActionList.focusForeground": "#e8e8e8",
      // Suggest list: same frosted surface as the context menu; the row
      // highlight itself is drawn by devmode.css (inset, rounded).
      "editorSuggestWidget.background": "#0f0f0ff2",
      "editorSuggestWidget.border": "#ffffff2e",
      "editorSuggestWidget.foreground": "#d4d4d4",
      "editorSuggestWidget.selectedForeground": "#f2f2f2",
      "editorSuggestWidget.selectedBackground": "#7ec8c826",
      "editorSuggestWidget.highlightForeground": "#7ec8c8",
      "editorSuggestWidget.focusHighlightForeground": "#9fdcdc",
      "editorHoverWidget.background": "#1b1b1b",
      // F12 peek panel (go-to-definition / references): same surface
      // language as the context menu — dark frost, accent selection, file
      // names in the teal we use for types. Chrome (radius/shadow/rows)
      // is finished in devmode.css.
      "peekView.border": "#ffffff2e",
      "peekViewTitle.background": "#101010",
      "peekViewTitleLabel.foreground": "#e8e8e8",
      "peekViewTitleDescription.foreground": "#8b949e",
      "peekViewEditor.background": DEV_MODE_EDITOR_BG,
      "peekViewEditorGutter.background": DEV_MODE_EDITOR_BG,
      "peekViewEditor.matchHighlightBackground": "#7ec8c838",
      "peekViewResult.background": "#0f0f0f",
      "peekViewResult.fileForeground": "#7ec8c8",
      "peekViewResult.lineForeground": "#c9c9c9",
      "peekViewResult.matchHighlightBackground": "#7ec8c838",
      "peekViewResult.selectionBackground": "#7ec8c826",
      "list.focusBackground": "#7ec8c826",
      "list.focusForeground": "#e8e8e8",
      "list.activeSelectionBackground": "#7ec8c826",
      "list.activeSelectionForeground": "#e8e8e8",
      "list.inactiveSelectionBackground": "#ffffff12",
      "list.hoverBackground": "#ffffff0d",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff24",
      "scrollbarSlider.activeBackground": "#7ec8c840",
      "editorOverviewRuler.border": "#00000000",
      "editor.findMatchBackground": "#7ec8c838",
      "editor.findMatchHighlightBackground": "#7ec8c826",
      "editor.selectionHighlightBackground": "#7ec8c818",
    },
  };
  monaco.editor.defineTheme(DEV_MODE_THEME, darkTheme);
  monaco.editor.defineTheme(DEV_MODE_LIGHT_THEME, {
    ...darkTheme,
    colors: {
      ...darkTheme.colors,
      /* Light keeps the editor/terminal island dark, but aligns every
         interactive highlight with the system-blue application chrome. */
      "editorCursor.foreground": "#007aff",
      "editor.selectionBackground": "#007aff38",
      "editor.inactiveSelectionBackground": "#007aff20",
      "editorBracketMatch.background": "#007aff26",
      "editorBracketMatch.border": "#007aff66",
      "editorActionList.focusBackground": "#007aff26",
      "editorSuggestWidget.selectedBackground": "#007aff26",
      "editorSuggestWidget.highlightForeground": "#58a6ff",
      "editorSuggestWidget.focusHighlightForeground": "#79b8ff",
      "peekViewEditor.matchHighlightBackground": "#007aff38",
      "peekViewResult.fileForeground": "#58a6ff",
      "peekViewResult.matchHighlightBackground": "#007aff38",
      "peekViewResult.selectionBackground": "#007aff26",
      "list.focusBackground": "#007aff26",
      "list.activeSelectionBackground": "#007aff26",
      "scrollbarSlider.activeBackground": "#007aff40",
      "editor.findMatchBackground": "#007aff38",
      "editor.findMatchHighlightBackground": "#007aff26",
      "editor.selectionHighlightBackground": "#007aff18",
    },
  });
}
