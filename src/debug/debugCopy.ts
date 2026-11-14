/** User-facing debug copy. Unreal vs Electron vs web — never hardcode one recipe in the panel. */

export type DebugRecipe = "unreal" | "electron" | "web";

export function isCdpRecipe(
  recipe?: DebugRecipe | null,
): recipe is "electron" | "web" {
  return recipe === "electron" || recipe === "web";
}

export function debugButtonTitle(kind: DebugRecipe | null | undefined): string {
  if (kind === "electron") return "Debug — launch Electron with breakpoints";
  if (kind === "web") {
    return "Debug — launch the Node server and Chrome with breakpoints";
  }
  if (kind === "unreal") {
    return "Debug — launch Unreal Editor with on-demand symbols";
  }
  return "Debug — launch the app with breakpoints";
}

export function debugColumnTitle(recipe?: DebugRecipe): "Sessions" | "Threads" {
  return isCdpRecipe(recipe) ? "Sessions" : "Threads";
}

export function debugEmptyTargets(recipe?: DebugRecipe): string {
  return isCdpRecipe(recipe) ? "No sessions" : "No threads";
}

/** Contextual head on the Debug tab — not “C++ Debug” for Electron/web. */
export function debugPanelContextTitle(
  kind: DebugRecipe | null | undefined,
): string {
  if (kind === "electron") return "Electron Debug";
  if (kind === "web") return "Web Debug";
  if (kind === "unreal") return "C++ Debug";
  return "Debug";
}

/** Contextual head on the Debug Console tab. */
export function debugConsoleContextTitle(
  kind: DebugRecipe | null | undefined,
): string {
  if (kind === "electron" || kind === "web") return "Inspector output";
  if (kind === "unreal") return "Debugger output";
  return "Debugger output";
}

/** Call-stack tooltip when a frame has no mapped source file. */
export function debugMissingSourceTitle(
  recipe: DebugRecipe | undefined,
  frameName: string,
  moduleLabel: string | null,
): string {
  if (isCdpRecipe(recipe)) {
    return `${frameName}\nno source mapped`;
  }
  return `${frameName}\n${
    moduleLabel ? `${moduleLabel} · ` : ""
  }no source yet — click to load this module's symbols`;
}

export function debugStatusDetail(input: {
  status: string;
  recipe?: DebugRecipe;
  progressText?: string;
  program?: string;
  error?: string;
  stoppedLabel?: string;
}): string {
  if (input.status === "stopped") return input.stoppedLabel ?? "";
  if (input.status === "error") return input.error ?? "";
  const progress = input.progressText?.trim();
  if (progress) return progress;
  if (input.status === "building") {
    if (input.recipe === "electron" || input.recipe === "web") {
      return "See the Build tab";
    }
    if (input.recipe === "unreal") return "DebugGame Editor · see the Build tab";
    return "Building";
  }
  if (input.status === "starting") {
    if (input.recipe === "electron") return "Launching Electron";
    if (input.recipe === "web") return "Launching web app";
    if (input.recipe === "unreal") return "Launching Unreal Editor";
    return "Starting";
  }
  if (input.status === "running") return input.program ?? "";
  return "";
}
