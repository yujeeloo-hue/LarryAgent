import EditorWorker from "monaco-editor/editor/editor.worker.js?worker&inline";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker&inline";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker&inline";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker&inline";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker&inline";
import {
  conf as stockCppConf,
  language as stockCppLanguage,
} from "monaco-editor/languages/definitions/cpp/cpp.js";
import { language as stockLuaLanguage } from "monaco-editor/languages/definitions/lua/lua.js";
import type * as MonacoNs from "monaco-editor";
import { devModeScrollbarColors } from "./editorStyle.js";
import { DEV_MODE_EDITOR_PALETTES, getDevModeEditorPalette } from "../state/devModePreferences.js";
import { buildUnrealCppLanguage } from "./unrealCppTokens.js";
import { buildCppLanguageConfiguration } from "./cppLanguageConfig.js";
import { buildLuaLanguage, type StockLuaLanguage } from "./luaTokens.js";
import { TS_WORKER_MODE_CONFIGURATION } from "./tsFeatures.js";

export type MonacoApi = typeof MonacoNs;

type MonarchLanguageArg = Parameters<
  MonacoApi["languages"]["setMonarchTokensProvider"]
>[1];

export const DEV_MODE_THEME = "jellybot-dark";
export const DEV_MODE_LIGHT_THEME = "jellybot-light";
const DEV_MODE_CONTRAST_THEME = "jellybot-high-contrast";

export function resolveDevModeTheme(): string {
  switch (getDevModeEditorPalette()) {
    case "light": return DEV_MODE_LIGHT_THEME;
    case "contrast": return DEV_MODE_CONTRAST_THEME;
    default: return DEV_MODE_THEME;
  }
}

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
      deferTypeScriptToLanguageServer(monaco);
      monaco.languages.setMonarchTokensProvider(
        "lua",
        buildLuaLanguage(stockLuaLanguage as unknown as StockLuaLanguage) as MonarchLanguageArg,
      );
      monaco.editor.setTheme(resolveDevModeTheme());
      observeAppTheme(monaco);
      remeasureAfterFontsLoad(monaco);
      return monaco;
    })();
  }
  return monacoPromise;
}

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

function installUnrealCpp(monaco: MonacoApi): void {
  monaco.languages.setMonarchTokensProvider(
    "cpp",
    buildUnrealCppLanguage(stockCppLanguage) as MonarchLanguageArg,
  );
  const config = buildCppLanguageConfiguration(stockCppConf) as unknown as Parameters<
    MonacoApi["languages"]["setLanguageConfiguration"]
  >[1];
  monaco.languages.setLanguageConfiguration("cpp", config);
  monaco.languages.onLanguageEncountered("cpp", () => {
    void import("monaco-editor/languages/definitions/cpp/cpp.js")
      .catch(() => undefined)
      .then(() => {
        window.setTimeout(() => monaco.languages.setLanguageConfiguration("cpp", config), 0);
      });
  });
}

function deferTypeScriptToLanguageServer(monaco: MonacoApi): void {
  const { typescriptDefaults, javascriptDefaults } = monaco.typescript;
  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setModeConfiguration(TS_WORKER_MODE_CONFIGURATION);
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
  }
}

function remeasureAfterFontsLoad(monaco: MonacoApi): void {
  document.fonts?.ready
    .then(() => {
      try {
        monaco.editor.remeasureFonts();
      } catch {
        }
    })
    .catch(() => undefined);
}


const degradedLabels = new Set<string>();

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


function defineTheme(monaco: MonacoApi): void {
  const darkTheme: MonacoNs.editor.IStandaloneThemeData = {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "e4e9f2" },
      { token: "comment", foreground: "8290a8", fontStyle: "italic" },
      { token: "keyword", foreground: "ff6edb" },
      { token: "keyword.flow", foreground: "ff6edb" },
      { token: "keyword.type", foreground: "39dfff" },
      { token: "string", foreground: "57e6ad" },
      { token: "string.key.json", foreground: "39dfff" },
      { token: "string.value.json", foreground: "57e6ad" },
      { token: "string.escape", foreground: "72cde9" },
      { token: "string.escape.delimiter", foreground: "8290a8" },
      { token: "number", foreground: "ffbd6a" },
      { token: "number.hex", foreground: "ffbd6a" },
      { token: "regexp", foreground: "57e6ad" },
      { token: "regexp.escape", foreground: "72cde9" },
      { token: "type", foreground: "39dfff" },
      { token: "type.identifier", foreground: "39dfff" },
      { token: "namespace", foreground: "39dfff" },
      { token: "annotation", foreground: "c696ff" },
      { token: "annotation.ue", foreground: "c696ff", fontStyle: "bold" },
      { token: "annotation.ue.meta", foreground: "a994cf", fontStyle: "italic" },
      { token: "function", foreground: "b49aff" },
      { token: "support.function", foreground: "b49aff" },
      { token: "identifier", foreground: "e4e9f2" },
      { token: "variable", foreground: "ffbd6a" },
      { token: "variable.ue", foreground: "ffbd6a" },
      { token: "variable.predefined", foreground: "ffbd6a" },
      { token: "variable.parameter", foreground: "ffbd6a" },
      { token: "constant", foreground: "ffbd6a" },
      { token: "operator", foreground: "72cde9" },
      { token: "delimiter", foreground: "e4e9f2" },
      { token: "delimiter.html", foreground: "8290a8" },
      { token: "tag", foreground: "57e6ad" },
      { token: "metatag", foreground: "ff6edb" },
      { token: "attribute.name", foreground: "39dfff" },
      { token: "attribute.value", foreground: "57e6ad" },
      { token: "attribute.value.html", foreground: "57e6ad" },
      { token: "keyword.ue", foreground: "ffbd6a", fontStyle: "bold" },
      { token: "type.ue", foreground: "39dfff" },
      { token: "class", foreground: "39dfff" },
      { token: "struct", foreground: "39dfff" },
      { token: "interface", foreground: "39dfff" },
      { token: "enum", foreground: "39dfff" },
      { token: "typeParameter", foreground: "39dfff" },
      { token: "parameter", foreground: "ffbd6a" },
      { token: "property", foreground: "72cde9" },
      { token: "enumMember", foreground: "ffbd6a" },
      { token: "method", foreground: "b49aff" },
      { token: "event", foreground: "b49aff" },
      { token: "macro", foreground: "ff6edb" },
      { token: "decorator", foreground: "c696ff" },
    ],
    colors: {
      "editor.background": DEV_MODE_EDITOR_BG,
      "editor.foreground": "#e4e9f2",
      "editorLineNumber.foreground": "#566172",
      "editorLineNumber.activeForeground": "#aab4c3",
      "editorCursor.foreground": "#00e5ff",
      "editor.selectionBackground": "#00e5ff26",
      "editor.inactiveSelectionBackground": "#00e5ff14",
      "editor.lineHighlightBackground": "#ffffff06",
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background1": "#ffffff0f",
      "editorIndentGuide.activeBackground1": "#ffffff26",
      "editorWhitespace.foreground": "#ffffff1a",
      "editorBracketMatch.background": "#00e5ff26",
      "editorBracketMatch.border": "#00e5ff66",
      "editorGutter.background": DEV_MODE_EDITOR_BG,
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
      "menu.background": "#0f0f0ff2",
      "menu.foreground": "#e4e9f2",
      "menu.separatorBackground": "#ffffff14",
      "editorActionList.background": "#0f0f0ff2",
      "editorActionList.foreground": "#e4e9f2",
      "editorActionList.focusBackground": "#00e5ff26",
      "editorActionList.focusForeground": "#e4e9f2",
      "editorSuggestWidget.background": "#0f0f0ff2",
      "editorSuggestWidget.border": "#ffffff2e",
      "editorSuggestWidget.foreground": "#d4d4d4",
      "editorSuggestWidget.selectedForeground": "#f2f2f2",
      "editorSuggestWidget.selectedBackground": "#00e5ff26",
      "editorSuggestWidget.highlightForeground": "#00e5ff",
      "editorSuggestWidget.focusHighlightForeground": "#79edff",
      "editorGhostText.foreground": "#9aa8bd",
      "editorGhostText.background": "#00000000",
      "editorHoverWidget.background": "#1b1b1b",
      "peekView.border": "#ffffff2e",
      "peekViewTitle.background": "#101010",
      "peekViewTitleLabel.foreground": "#e4e9f2",
      "peekViewTitleDescription.foreground": "#8290a8",
      "peekViewEditor.background": DEV_MODE_EDITOR_BG,
      "peekViewEditorGutter.background": DEV_MODE_EDITOR_BG,
      "peekViewEditor.matchHighlightBackground": "#00e5ff38",
      "peekViewResult.background": "#0f0f0f",
      "peekViewResult.fileForeground": "#39dfff",
      "peekViewResult.lineForeground": "#c9c9c9",
      "peekViewResult.matchHighlightBackground": "#00e5ff38",
      "peekViewResult.selectionBackground": "#00e5ff26",
      "list.focusBackground": "#00e5ff26",
      "list.focusForeground": "#e4e9f2",
      "list.activeSelectionBackground": "#00e5ff26",
      "list.activeSelectionForeground": "#e4e9f2",
      "list.inactiveSelectionBackground": "#ffffff12",
      "list.hoverBackground": "#ffffff0d",
      ...devModeScrollbarColors,
      "editorOverviewRuler.border": "#00000000",
      "editor.findMatchBackground": "#00e5ff38",
      "editor.findMatchHighlightBackground": "#00e5ff26",
      "editor.selectionHighlightBackground": "#00e5ff18",
    },
  };
  monaco.editor.defineTheme(DEV_MODE_THEME, darkTheme);
  for (const [theme, base, palette] of [
    [DEV_MODE_LIGHT_THEME, "vs", DEV_MODE_EDITOR_PALETTES.light],
    [DEV_MODE_CONTRAST_THEME, "hc-black", DEV_MODE_EDITOR_PALETTES.contrast],
  ] as const) {
    monaco.editor.defineTheme(theme, {
      base,
      inherit: true,
      rules: [
        { token: "", foreground: palette.text.slice(1) },
        { token: "keyword", foreground: palette.keyword.slice(1) },
        { token: "string", foreground: palette.string.slice(1) },
        { token: "function", foreground: palette.function.slice(1) },
      ],
      colors: { "editor.background": palette.background, "editor.foreground": palette.text },
    });
  }
}
