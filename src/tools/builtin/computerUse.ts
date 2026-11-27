import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { JevClientConfig } from "../../llm/jevClient.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { computerBatchDefinition, runComputerBatch } from "../computerUse/batch.js";
import { ensureComputerUseCacheDir } from "../computerUse/cache.js";
import { tipsOverlay } from "../computerUse/cursorOverlay.js";
import { runHandoff, type HandoffOutcome } from "../computerUse/handoff.js";
import {
  HANDOFF_KINDS,
  HANDOFF_MAX_OPTIONS,
  HANDOFF_MAX_TIMEOUT_S,
  HANDOFF_MIN_TIMEOUT_S,
  HANDOFF_WAIT_UNTIL,
  HandoffArgumentError,
  parseHandoffRequest,
  type ParsedHandoff,
} from "../computerUse/handoffRequest.js";
import { KeyResolutionError } from "../computerUse/keymap.js";
import { computerUseJevClient } from "../computerUse/jevAccess.js";
import { checkScreen, locateTarget, screenElements, screenTextPreview } from "../computerUse/jevScreen.js";
import { findTextInLines } from "../computerUse/ocrMatch.js";
import { PURSUE_DEFAULT_STEPS, PURSUE_MAX_STEPS, runPursue } from "../computerUse/pursue.js";
import { awaitPointerTakeover, type TakeoverDeps } from "../computerUse/takeover.js";
import { EASING_NAMES, round1, type Easing } from "../computerUse/motion.js";
import { ComputerUseService, OCR_RECOGNIZED_PREVIEW, type CallOptions, type Outcome } from "../computerUse/service.js";
import { screenShowsOnce, type ScreenShows } from "../computerUse/screenWatch.js";
import { PLATFORM_COORDINATES, type MouseButton, type OcrLine, type Point, type Rect, type ScreenLine } from "../computerUse/types.js";
import {
  ComputerUseError,
  computerUsePlatform,
  getComputerUseBackend,
} from "../computerUse/worker.js";
import { imageThumbnailFromFile } from "../imageThumbnail.js";
import {
  abortIfSignaled,
  displayPath,
  failureResult,
  isAbortError,
  resolveToolPath,
  textResult,
} from "../pathUtil.js";
import type {
  JsonObject,
  ToolDefinition,
  ToolExecuteContext,
  ToolExecuteResult,
  ToolHandler,
  ToolRiskAssessor,
} from "../types.js";

const MOUSE_ACTIONS = ["position", "move", "click", "drag", "scroll", "hold", "release"] as const;
const MOUSE_INPUT_ACTIONS = new Set<string>(["move", "click", "drag", "scroll", "hold"]);
const KEYBOARD_ACTIONS = ["press", "combo", "type"] as const;
const TYPE_SPEEDS = ["auto", "fast", "human"] as const;
const FAST_TYPE_MIN_CHARS = 24;
const FAST_TYPE_HOLD_MS = 4;
const UI_ACTIONS = ["windows", "find", "click", "dock", "menubar", "hit_test"] as const;
const SCREEN_ACTIONS = ["capture", "find_text", "read_text", "wait_for", "locate", "pursue"] as const;
const SYSTEM_ACTIONS = ["info", "request_permissions", "hide_jellybot", "show_jellybot"] as const;
const BUTTONS = ["left", "right", "middle"] as const;
const LOCATE_PREVIEW = 60;
const VERIFY_PREVIEW = 20;
const VERIFY_WAITS_MS = [450, 700] as const;
const VERIFY_AREA = { width: 1800, height: 1200 } as const;
const WAIT_DEFAULT_S = 10;
const WAIT_MAX_S = 30;
const WAIT_POLL_MS = 700;
const WAIT_SETTLED_READS = 2;
const WAIT_SETTLED_MIN_MS = 2000;

const COORDINATES =
  "Coordinates are global: macOS screen points, Windows physical pixels (secondary displays may be negative).";
const AVOID_PARAM = {
  type: "boolean",
  description:
    "Default true: if a JellyBot window covers the target (or holds keyboard focus), hide JellyBot first. Windows come back at turn end.",
};
const DRY_RUN_PARAM = { type: "boolean", description: "Only return the plan; do not act." };
const BORROW_PARAM = {
  type: "boolean",
  description:
    "click/drag/scroll/hold: deliver through the physical cursor (moved for the instant of the action, then put back) instead of straight to the window. Use only after a normal attempt had no effect.",
};

const readOnly = (isReadOnly: (args: JsonObject) => boolean): ToolRiskAssessor =>
  ({ arguments: args }) => (isReadOnly(args) ? { action: "allow" } : { action: "defer" });

// ------------------------------------------------------------------ definitions

export const computerSystemDefinition: ToolDefinition = {
  name: "computer_system",
  description:
    "Computer use diagnostics and JellyBot window control. info: helper version, displays (origin/size/scale), Accessibility + Screen Recording status with fix hints, frontmost pid — check this first when coordinates or permissions look wrong. request_permissions: trigger the macOS permission prompts. hide_jellybot: hide all JellyBot windows so they do not cover the desktop (focus returns to the previous app); show_jellybot: bring them back. Other computer_* tools hide JellyBot automatically when it is in the way, and windows return when the turn ends.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...SYSTEM_ACTIONS], description: "Default info." },
      focus: { type: "boolean", description: "show_jellybot: also focus JellyBot (default false)." },
    },
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

export const computerMouseDefinition: ToolDefinition = {
  name: "computer_mouse",
  description:
    `Real OS mouse input. ${COORDINATES} The pointer you drive is your own and the user's cursor never moves: move glides it (~60fps), and click/drag/scroll/hold are delivered straight to the app window under the point (clicking activates that app, like a real click); sliders and window title-bar moves or edge resizes go through accessibility, as do macOS menu bar / Dock / Control Center clicks and Windows taskbar / Start / tray / UWP-WinUI clicks; position reports your pointer. Only targets that cannot take that (the bare desktop, cross-app drag and drop, some web drag handlers that read held buttons, Windows clicks with modifiers) briefly borrow the physical cursor and restore it — result.delivery.mode says background / accessibility / borrowed. If a delivered action had no visible effect, retry it once with borrow_pointer: true. click: optionally move, then click (button, clicks 1-3, modifiers, hold); omit x/y to click in place. drag: press at from, glide to to, release. scroll: at the pointer; delta_y >0 up / <0 down, delta_x >0 right; unit line (default) or pixel. hold/release: press and keep a button for custom gestures. Locate targets first with computer_ui or computer_screen find_text.`,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...MOUSE_ACTIONS] },
      x: { type: "number", description: "Target X (move/click/hold)." },
      y: { type: "number", description: "Target Y (move/click/hold)." },
      from_x: { type: "number", description: "drag start X." },
      from_y: { type: "number", description: "drag start Y." },
      to_x: { type: "number", description: "drag end X." },
      to_y: { type: "number", description: "drag end Y." },
      button: { type: "string", enum: [...BUTTONS], description: "Default left." },
      clicks: { type: "integer", enum: [1, 2, 3], description: "click count (default 1)." },
      modifiers: { type: "array", items: { type: "string" }, description: 'Held during click, e.g. ["cmd","shift"]; on Windows cmd means Ctrl.' },
      hold: { type: "number", description: "Seconds each press is held (click, default 0.05)." },
      duration: { type: "number", description: "Glide seconds (move/click/drag); default auto, faster for long distances." },
      easing: { type: "string", enum: [...EASING_NAMES], description: "move curve, default easeInOutCubic." },
      steps: { type: "integer", description: "Frame count override (move/drag)." },
      delta_x: { type: "number", description: "scroll horizontal amount." },
      delta_y: { type: "number", description: "scroll vertical amount." },
      unit: { type: "string", enum: ["line", "pixel"], description: "scroll unit, default line." },
      expect: {
        type: "string",
        description: "click: the visible text you expect after the click, e.g. 'the Settings page title is shown' or 'a Save button appears'. With a Jev model configured, the screen around the click is read and result.verification says yes / no / unclear plus dialog and error flags, so you can skip a screenshot. Do not use it for keyboard focus or which window is in front: text cannot show those (verification returns not_checkable). Without Jev, verification is skipped.",
      },
      borrow_pointer: BORROW_PARAM,
      avoid_occlusion: AVOID_PARAM,
      dry_run: DRY_RUN_PARAM,
    },
    required: ["action"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
  assessRisk: readOnly((args) => args.action === "position" || args.dry_run === true),
};

export const computerKeyboardDefinition: ToolDefinition = {
  name: "computer_keyboard",
  description:
    "Real OS keyboard input into the focused app (make sure the right window is frontmost first). For a predictable sequence in one window (shortcut, type, wait, click), use computer_batch so it runs in one call. press: one key — special names (return, tab, esc, space, backspace, delete, up/down/left/right, home, end, pageup, pagedown, f1-f12) or one character of any script — with optional modifiers. combo: modifiers then a main key, e.g. [\"cmd\",\"c\"] (cmd = Ctrl on Windows). type: enter text char by char; newlines press Return. speed auto (default) types URLs and text of 24+ characters fast (about 3x quicker) and short text human-paced; set speed human (or interval_ms / jitter_ms) when a site watches typing rhythm.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...KEYBOARD_ACTIONS] },
      key: { type: "string", description: "press: key name or single character." },
      modifiers: { type: "array", items: { type: "string" }, description: 'press: cmd/ctrl/shift/alt(option)/win/fn.' },
      keys: { type: "array", items: { type: "string" }, description: "combo: modifiers followed by the main key." },
      text: { type: "string", description: "type: text to enter (any language)." },
      hold: { type: "number", description: "press: seconds held (default 0.03)." },
      speed: { type: "string", enum: [...TYPE_SPEEDS], description: "type: auto (default), fast, or human." },
      interval_ms: { type: "number", description: "type: mean delay between characters for human pacing (default 80)." },
      jitter_ms: { type: "number", description: "type: random +/- jitter for human pacing (default 50)." },
      avoid_occlusion: AVOID_PARAM,
      dry_run: DRY_RUN_PARAM,
    },
    required: ["action"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
  assessRisk: readOnly((args) => args.dry_run === true),
};

export const computerUiDefinition: ToolDefinition = {
  name: "computer_ui",
  description:
    `Locate UI targets through the accessibility tree (macOS AX / Windows UI Automation). For several predictable steps in one active window, prefer computer_batch. ${COORDINATES} windows: an app's on-screen windows and whether it is frontmost (a window = running; click it to activate). find: search an app for elements by role and/or name (exact > prefix > substring, case-insensitive); returns frames and centers. click: find, then click match[index]. dock: app icons in the macOS Dock / Windows taskbar (click to launch or activate). menubar: menu bar items of the frontmost app. hit_test: which element is at (x, y). Roles accept either vocabulary: AXButton / ButtonControl / Button. On a browser sign-in form, password_present=true or visible masked characters mean the password is already there: click the enabled Sign in button once and check the outcome before asking for a password. Missing password_present is inconclusive. Never reveal the password.`,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...UI_ACTIONS] },
      app: {
        anyOf: [{ type: "string" }, { type: "integer" }],
        description: "windows/find/click: pid, macOS bundle id or app name, Windows process name or window title.",
      },
      role: { type: "string", description: "Element role, e.g. AXButton, AXTextField, ButtonControl, EditControl." },
      name: { type: "string", description: "find/click/dock: element name filter." },
      window_title: { type: "string", description: "find/click: limit to windows whose title contains this." },
      index: { type: "integer", description: "click: which match (default 0)." },
      menu: { type: "string", description: "menubar: filter by menu title, e.g. File / 文件." },
      x: { type: "number", description: "hit_test X." },
      y: { type: "number", description: "hit_test Y." },
      button: { type: "string", enum: [...BUTTONS], description: "click: default left." },
      clicks: { type: "integer", enum: [1, 2, 3], description: "click: default 1." },
      timeout: { type: "number", description: "find/click: tree walk budget in seconds (default 5)." },
      borrow_pointer: BORROW_PARAM,
      avoid_occlusion: AVOID_PARAM,
      dry_run: { type: "boolean", description: "click: return the located target without clicking." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
  assessRisk: readOnly((args) => args.action !== "click" || args.dry_run === true),
};

export const computerScreenDefinition: ToolDefinition = {
  name: "computer_screen",
  description:
    `Screenshots and OCR — the fallback for custom-drawn UI and games that the accessibility tree cannot see. ${COORDINATES} capture: save the screen (or region) as PNG and show it; inspect it with read_image. find_text: OCR the screen (or region) for text and return its center, ready for computer_mouse click; with a Jev model configured, OCR misspellings are matched too. read_text: OCR and list every recognized line with centers. wait_for: after an action that loads a page or opens a dialog, wait until the screen shows text (literal text, or with Jev a description such as "search results are listed"), polling every 0.7 s up to timeout_s; use it instead of a shell sleep or repeated read_text, which each cost a model round. locate: find the element that fits a description (target, e.g. "the New Chat button in the sidebar") among OCR text — with Jev it returns one center, without Jev it returns the OCR lines for you to choose. pursue (needs Jev): give a short goal (e.g. "open Settings, then Account"); OCR text and Jev drive up to max_steps clicks and scrolls locally, without a model round per step. It stops before typing, before a step with a material effect the goal does not clearly authorize, and whenever it is unsure, returning the steps done and the current screen text. Prefer locate over capture + read_image or read_text when you only need where to click, and pursue when the next clicks follow from visible labels. wait_for, locate and pursue default to the front window (or app's window), else the whole screen. macOS needs Screen Recording; Windows needs an OCR language installed.`,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...SCREEN_ACTIONS] },
      target: { type: "string", description: "locate: what to find, described the way a person would." },
      goal: { type: "string", description: "pursue: the outcome to reach with clicks and scrolls only." },
      app: {
        anyOf: [{ type: "string" }, { type: "integer" }],
        description: "wait_for/locate/pursue: read this app's front window instead of the frontmost one.",
      },
      max_steps: { type: "integer", minimum: 1, maximum: PURSUE_MAX_STEPS, description: `pursue: step cap (default ${PURSUE_DEFAULT_STEPS}).` },
      region: {
        type: "array",
        items: { type: "number" },
        minItems: 4,
        description: "[x, y, width, height] in global coordinates; omit for the full screen (macOS: main display; Windows: all displays).",
      },
      path: { type: "string", description: "capture: absolute .png output path (default: JellyBot's computer-use cache)." },
      text: { type: "string", description: "find_text: text to find (substring, case-insensitive). wait_for: text or description to wait for." },
      timeout_s: { type: "number", minimum: 1, maximum: WAIT_MAX_S, description: `wait_for: give up after this many seconds (default ${WAIT_DEFAULT_S}).` },
      index: { type: "integer", description: "find_text: which match (default 0)." },
      lang: { type: "string", enum: ["zh-Hans", "en"], description: "OCR language, default zh-Hans (also reads English)." },
      avoid_occlusion: AVOID_PARAM,
    },
    required: ["action"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

const ELEMENT_QUERY_PROPERTIES = {
  app: { anyOf: [{ type: "string" }, { type: "integer" }], description: "pid, macOS bundle id or app name." },
  role: { type: "string", description: "Element role, e.g. AXTextField." },
  name: { type: "string", description: "Element name filter." },
  window_title: { type: "string", description: "Limit to windows whose title contains this." },
};

export const computerHandoffDefinition: ToolDefinition = {
  name: "computer_handoff",
  description:
    `Hand one step of a computer-use task to the user. Shows a tip beside the target on macOS and a matching conversation card; whichever side answers first wins. Before requesting a browser password, check for existing autofill. If the password is already present (including visible masked characters), click the enabled Sign in button once and check the outcome. While sign-in is pending, wait for its result. If it fails and the form needs a new password, use kind=password and sign_in_failed=true. If the field is genuinely empty and browser autofill cannot supply it, use kind=password without sign_in_failed. For a password handoff, set target.app and focus the actual password field, or set target.region tightly around it. The desktop card fills a verified field directly. Never reveal or request the password in chat, options, or tool arguments. Use kind=qr_code for scanning a login QR code, with target.region tightly around the whole code and its blank border. The conversation card includes that crop. kind action (default): another step only the user can do, then Done. Add wait_for to finish automatically after the screen changes. kind choice: pick an option. kind confirm: ask before a destructive or irreversible step, with a default 5-minute timeout. Keep the title under ~60 characters in the user's language. ${COORDINATES} Returns outcome, optional choice, password_present or password_filled, answer channel and wait time. After skipped / declined / timeout, do not perform that step.`,
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...HANDOFF_KINDS], description: "Use password or qr_code for sign-in handoffs. Default action." },
      title: { type: "string", description: "Short imperative or question, e.g. Enter the verification code." },
      message: { type: "string", description: "Optional one-sentence detail." },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "≤ 40 characters." },
            detail: { type: "string", description: "Optional dim hint, ≤ 60 characters." },
          },
          required: ["label"],
          additionalProperties: false,
        },
        description: `choice: 2–${HANDOFF_MAX_OPTIONS} options.`,
      },
      allow_custom: { type: "boolean", description: "choice: also accept a typed answer in the conversation card." },
      password: { type: "boolean", description: "Legacy alias for kind=password." },
      sign_in_failed: { type: "boolean", description: "Password only. Set true after a submitted sign-in is visibly rejected and a new password is required." },
      qr_code: { type: "boolean", description: "Legacy alias for kind=qr_code." },
      confirm_label: { type: "string", description: "Primary button label (defaults: Done / Choose / Confirm)." },
      cancel_label: { type: "string", description: "Secondary button label (defaults: Skip / Skip / Cancel)." },
      target: {
        type: "object",
        properties: {
          region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x, y, width, height] to point at." },
          ...ELEMENT_QUERY_PROPERTIES,
          index: { type: "integer", description: "Which match (default 0)." },
        },
        additionalProperties: false,
        description: "Where the user should act: a region, or an element found like computer_ui find. Omit to show the tip in the corner.",
      },
      wait_for: {
        type: "object",
        properties: {
          until: { type: "string", enum: [...HANDOFF_WAIT_UNTIL], description: "appears / disappears: an element (role and/or name); title_contains: a window title of app contains text; screen_shows: OCR of the screen (or region) shows text — with a Jev model it may be a description such as 'the sign-in finished', without Jev it must be literal text. app is required except for screen_shows." },
          ...ELEMENT_QUERY_PROPERTIES,
          text: { type: "string", description: "title_contains: text to look for; screen_shows: text or description to wait for." },
          region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "screen_shows: [x, y, width, height] to read; omit for the whole screen." },
        },
        required: ["until"],
        additionalProperties: false,
        description: "Finish automatically (outcome auto) once this is true; checked every 1.5 s.",
      },
      timeout_s: { type: "number", description: `Give up after this many seconds (${HANDOFF_MIN_TIMEOUT_S}–${HANDOFF_MAX_TIMEOUT_S}). Default: none, confirm 300.` },
    },
    required: ["title"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

// ------------------------------------------------------------------ argument helpers

class ArgumentError extends Error {}

function num(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ArgumentError(`"${key}" must be a finite number.`);
  return value;
}

function requireNum(args: JsonObject, key: string, action: string): number {
  const value = num(args, key);
  if (value === undefined) throw new ArgumentError(`action=${action} requires "${key}".`);
  return value;
}

function str(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function strList(args: JsonObject, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ArgumentError(`"${key}" must be an array of strings.`);
  }
  return value as string[];
}

function borrow(args: JsonObject): boolean {
  return args.borrow_pointer === true;
}

function button(args: JsonObject): MouseButton {
  const value = str(args, "button") ?? "left";
  if (!(BUTTONS as readonly string[]).includes(value)) throw new ArgumentError(`"button" must be left, right or middle.`);
  return value as MouseButton;
}

function clicks(args: JsonObject): number {
  const value = num(args, "clicks") ?? 1;
  if (![1, 2, 3].includes(value)) throw new ArgumentError(`"clicks" must be 1, 2 or 3.`);
  return value;
}

function region(args: JsonObject): Rect | undefined {
  const value = args.region;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 4 || value.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new ArgumentError(`"region" must be [x, y, width, height].`);
  }
  const [x, y, width, height] = value as number[];
  if (width! <= 0 || height! <= 0) throw new ArgumentError(`"region" width and height must be positive.`);
  return { x: x!, y: y!, width: width!, height: height! };
}

function lang(args: JsonObject): "zh-Hans" | "en" {
  return str(args, "lang") === "en" ? "en" : "zh-Hans";
}

function callOptions(args: JsonObject, context: ToolExecuteContext): CallOptions {
  return {
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    avoidOcclusion: args.avoid_occlusion !== false,
  };
}

// ------------------------------------------------------------------ handler plumbing

function returnCodeFor(code: string): number {
  switch (code) {
    case "invalid_arguments":
      return ToolReturnCode.InvalidArguments;
    case "permission_required":
    case "input_blocked":
      return ToolReturnCode.PermissionDenied;
    case "not_found":
    case "helper_missing":
      return ToolReturnCode.NotFound;
    case "timeout":
      return ToolReturnCode.Timeout;
    default:
      return ToolReturnCode.GenericFailure;
  }
}

function outcomeResult(outcome: Outcome): ToolExecuteResult {
  return textResult(JSON.stringify(outcome, null, 2), ToolReturnCode.Success);
}

let serviceOverride: ComputerUseService | null = null;

export function setComputerUseServiceForTests(service: ComputerUseService | null): void {
  serviceOverride = service;
}

function service(): ComputerUseService {
  return serviceOverride ?? new ComputerUseService(getComputerUseBackend());
}

let activeDesktopOperations = 0;
let desktopBatchActive = false;

async function coordinateDesktopOperation(batch: boolean, run: () => Promise<ToolExecuteResult>): Promise<ToolExecuteResult> {
  if (desktopBatchActive || (batch && activeDesktopOperations > 0)) {
    return failureResult("The desktop is in use by another Computer Use operation. Wait for its checkpoint.", ToolReturnCode.GenericFailure);
  }
  activeDesktopOperations += 1;
  if (batch) desktopBatchActive = true;
  try {
    return await run();
  } finally {
    activeDesktopOperations -= 1;
    if (batch) desktopBatchActive = false;
  }
}

function guarded(
  run: (args: JsonObject, context: ToolExecuteContext, svc: ComputerUseService) => Promise<ToolExecuteResult>,
  batch = false,
): ToolHandler {
  return async (args, context) => {
    const aborted = abortIfSignaled(context.signal);
    if (aborted) return aborted;
    if (!serviceOverride && !computerUsePlatform()) {
      return failureResult("Computer use is available only on macOS and Windows.", ToolReturnCode.InvalidArguments);
    }
    try {
      return await coordinateDesktopOperation(batch, () => run(args, context, service()));
    } catch (error) {
      if (isAbortError(error) || context.signal?.aborted) return failureResult("Cancelled", ToolReturnCode.Cancelled);
      if (error instanceof ArgumentError || error instanceof KeyResolutionError) {
        return failureResult(`Invalid arguments: ${error.message}`, ToolReturnCode.InvalidArguments);
      }
      if (error instanceof ComputerUseError) return failureResult(error.message, returnCodeFor(error.code));
      return failureResult(error instanceof Error ? error.message : String(error), ToolReturnCode.GenericFailure);
    }
  };
}

function unknownAction(tool: string, action: unknown, allowed: readonly string[]): never {
  throw new ArgumentError(`${tool} action must be one of ${allowed.join(", ")} (got ${JSON.stringify(action)}).`);
}

let takeoverDeps: TakeoverDeps | null = null;

export function setTakeoverDepsForTests(deps: TakeoverDeps | null): void {
  takeoverDeps = deps;
}

async function takeoverGate(context: ToolExecuteContext, svc: ComputerUseService): Promise<ToolExecuteResult | null> {
  const paused = await awaitPointerTakeover(svc, context, takeoverDeps ?? {});
  if (!paused) return null;
  switch (paused.outcome) {
    case "cancelled":
      return failureResult("Cancelled", ToolReturnCode.Cancelled);
    case "stopped":
      return failureResult(
        "The user took over the mouse and chose Stop task. Stop using the computer now; do not retry. Summarize what was done and what is left.",
        ToolReturnCode.Cancelled,
      );
    case "unanswered":
      return null;
    default:
      return failureResult(
        `Not performed: the user was using the mouse, so computer use paused for ${Math.round(paused.waitedMs / 1000)} s until they chose Resume. The screen may have changed — look again (computer_ui / computer_screen) before repeating this action, then continue the task.`,
        ToolReturnCode.Cancelled,
      );
  }
}

// ------------------------------------------------------------------ handlers

export const computerSystemHandler = guarded(async (args, context, svc) => {
  const action = str(args, "action") ?? "info";
  switch (action) {
    case "info":
      return outcomeResult({ ...(await svc.systemInfo()), coordinates: PLATFORM_COORDINATES[svc.platform] });
    case "request_permissions":
      return outcomeResult(await svc.requestPermissions());
    case "hide_jellybot":
      return outcomeResult(await svc.hideJellyBot(context.sessionId));
    case "show_jellybot":
      return outcomeResult(svc.showJellyBot(args.focus === true));
    default:
      return unknownAction("computer_system", action, SYSTEM_ACTIONS);
  }
});

export const computerMouseHandler = guarded(async (args, context, svc) => {
  const action = str(args, "action");
  const options = callOptions(args, context);
  const dryRun = args.dry_run === true;
  const easing = str(args, "easing") as Easing | undefined;
  if (!dryRun && action && MOUSE_INPUT_ACTIONS.has(action)) {
    const paused = await takeoverGate(context, svc);
    if (paused) return paused;
  }
  switch (action) {
    case "position":
      return outcomeResult(await svc.position());
    case "move":
      return outcomeResult(await svc.mouseMove({
        x: requireNum(args, "x", action), y: requireNum(args, "y", action),
        durationS: num(args, "duration"), easing, steps: num(args, "steps"), dryRun,
      }, options));
    case "click": {
      const x = num(args, "x");
      const y = num(args, "y");
      if ((x === undefined) !== (y === undefined)) throw new ArgumentError("click needs both x and y, or neither to click in place.");
      const expectation = dryRun ? undefined : str(args, "expect")?.trim();
      const clicked = await svc.mouseClick({
        x, y, button: button(args), clicks: clicks(args), modifiers: strList(args, "modifiers"),
        holdS: num(args, "hold") ?? 0.05, durationS: num(args, "duration"), borrowPointer: borrow(args), dryRun,
      }, options);
      if (!expectation) return outcomeResult(clicked);
      return outcomeResult({ ...clicked, verification: await verifyClick(svc, expectation, clicked, options) });
    }
    case "drag":
      return outcomeResult(await svc.mouseDrag({
        from: { x: requireNum(args, "from_x", action), y: requireNum(args, "from_y", action) },
        to: { x: requireNum(args, "to_x", action), y: requireNum(args, "to_y", action) },
        button: button(args), durationS: num(args, "duration"), steps: num(args, "steps"), borrowPointer: borrow(args), dryRun,
      }, options));
    case "scroll":
      return outcomeResult(await svc.mouseScroll({
        dx: num(args, "delta_x") ?? 0, dy: num(args, "delta_y") ?? 0,
        unit: str(args, "unit") === "pixel" ? "pixel" : "line", borrowPointer: borrow(args), dryRun,
      }, options));
    case "hold":
      return outcomeResult(await svc.mouseHold({ x: num(args, "x"), y: num(args, "y"), button: button(args), borrowPointer: borrow(args), dryRun }, options));
    case "release":
      return outcomeResult(await svc.mouseRelease({ button: button(args), dryRun }, options));
    default:
      return unknownAction("computer_mouse", action, MOUSE_ACTIONS);
  }
});

function typesFast(args: JsonObject, text: string): boolean {
  const speed = str(args, "speed") ?? "auto";
  if (speed === "fast") return true;
  if (speed === "human" || args.interval_ms !== undefined || args.jitter_ms !== undefined) return false;
  return Array.from(text).length >= FAST_TYPE_MIN_CHARS || /^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim());
}

export const computerKeyboardHandler = guarded(async (args, context, svc) => {
  const action = str(args, "action");
  const options = callOptions(args, context);
  const dryRun = args.dry_run === true;
  if (!dryRun && action && (KEYBOARD_ACTIONS as readonly string[]).includes(action)) {
    const paused = await takeoverGate(context, svc);
    if (paused) return paused;
  }
  switch (action) {
    case "press": {
      const key = typeof args.key === "string" && args.key.length > 0 ? args.key : undefined;
      if (!key) throw new ArgumentError('action=press requires "key".');
      return outcomeResult(await svc.keyPress({ key, modifiers: strList(args, "modifiers"), holdS: num(args, "hold") ?? 0.03, dryRun }, options));
    }
    case "combo": {
      const keys = strList(args, "keys");
      if (!keys || keys.length === 0) throw new ArgumentError('action=combo requires "keys" (the last one is the main key).');
      return outcomeResult(await svc.keyCombo({ keys, dryRun }, options));
    }
    case "type": {
      if (typeof args.text !== "string") throw new ArgumentError('action=type requires "text".');
      const fast = typesFast(args, args.text);
      return outcomeResult(await svc.typeText({
        text: args.text,
        intervalMs: fast ? 0 : Math.max(0, num(args, "interval_ms") ?? 80),
        jitterMs: fast ? 0 : Math.max(0, num(args, "jitter_ms") ?? 50),
        ...(fast ? { holdMs: FAST_TYPE_HOLD_MS } : {}),
        dryRun,
      }, options));
    }
    default:
      return unknownAction("computer_keyboard", action, KEYBOARD_ACTIONS);
  }
});

function appArg(args: JsonObject, action: string): string | number {
  const value = args.app;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ArgumentError(`action=${action} requires "app".`);
}

export const computerUiHandler = guarded(async (args, context, svc) => {
  const action = str(args, "action");
  const options = callOptions(args, context);
  const timeoutS = Math.min(60, Math.max(0.5, num(args, "timeout") ?? 5));
  if (action === "click" && args.dry_run !== true) {
    const paused = await takeoverGate(context, svc);
    if (paused) return paused;
  }
  switch (action) {
    case "windows":
      return outcomeResult(await svc.uiWindows(appArg(args, action)));
    case "find":
      return outcomeResult(await svc.uiFind({
        app: appArg(args, action), role: str(args, "role"), name: str(args, "name"),
        windowTitle: str(args, "window_title"), timeoutS,
      }));
    case "click":
      return outcomeResult(await svc.uiClick({
        app: appArg(args, action), role: str(args, "role"), name: str(args, "name"),
        windowTitle: str(args, "window_title"), index: Math.max(0, num(args, "index") ?? 0),
        button: button(args), clicks: clicks(args), timeoutS, borrowPointer: borrow(args), dryRun: args.dry_run === true,
      }, options));
    case "dock":
      return outcomeResult(await svc.uiDock(str(args, "name")));
    case "menubar":
      return outcomeResult(await svc.uiMenubar(str(args, "menu"), options));
    case "hit_test":
      return outcomeResult(await svc.uiHitTest({ x: requireNum(args, "x", action), y: requireNum(args, "y", action) }, options));
    default:
      return unknownAction("computer_ui", action, UI_ACTIONS);
  }
});

async function captureOutputPath(args: JsonObject, context: ToolExecuteContext): Promise<string | ToolExecuteResult> {
  const requested = str(args, "path");
  if (!requested) {
    const dir = await ensureComputerUseCacheDir();
    return join(dir, `capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  }
  const resolved = resolveToolPath(requested, {
    workspacePath: context.workspacePath,
    allowOutsideWorkspace: context.fullPermissionsEnabled,
  });
  if (!resolved.ok) return failureResult(resolved.reason, resolved.returnCode);
  const path = resolved.path.absolute;
  if (extname(path).toLowerCase() !== ".png") {
    return failureResult(`Output must be a .png path: ${displayPath(path)}`, ToolReturnCode.InvalidArguments);
  }
  await mkdir(dirname(path), { recursive: true });
  return path;
}

function appRef(args: JsonObject): string | number | undefined {
  const value = args.app;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lineBox(line: ScreenLine): OcrLine {
  return { text: line.text, ...line.frame };
}

async function findTextWithJev(
  client: JevClientConfig,
  text: string,
  lines: ScreenLine[],
  area: Rect,
  signal: AbortSignal | undefined,
): Promise<Outcome | null> {
  const table = screenElements(lines, area);
  if (table.elements.length === 0) return null;
  try {
    const found = await locateTarget(client, { target: `the text "${text}"`, table }, signal);
    if (found.status !== "matched") return null;
    return {
      text: found.line.text,
      center: found.line.center,
      frame: found.line.frame,
      match_index: 0,
      total_matches: 1,
      all_matches: [found.line.text],
      matched_by: "jev",
      probability: found.probability,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function locate(
  svc: ComputerUseService,
  target: string,
  args: JsonObject,
  context: ToolExecuteContext,
  options: CallOptions,
): Promise<ToolExecuteResult> {
  const area = region(args) ?? (await svc.frontWindow(appRef(args), context.signal))?.frame;
  const snapshot = await svc.ocrScreen({ lang: lang(args), ...(area ? { region: area } : {}) }, options);
  const base = { target, area: snapshot.area, ...snapshot.hidden };
  const exact = findTextInLines(snapshot.lines.map(lineBox), target);
  if (exact.length === 1) {
    const frame = exact[0]!.box;
    return outcomeResult({
      ...base,
      text: exact[0]!.text,
      center: { x: round1(frame.x + frame.width / 2), y: round1(frame.y + frame.height / 2) },
      frame,
      matched_by: "ocr",
    });
  }
  const client = await computerUseJevClient();
  if (!client) {
    return outcomeResult({
      ...base,
      status: "no_jev",
      lines: screenTextPreview(snapshot.lines, LOCATE_PREVIEW),
      hint: "No Jev model is configured. Pick the line that fits the target and click its center.",
    });
  }
  const table = screenElements(snapshot.lines, snapshot.area);
  if (table.elements.length === 0) {
    return failureResult(`No text was recognized in the area, so "${target}" cannot be located. Try capture instead.`, ToolReturnCode.NotFound);
  }
  const found = await locateTarget(client, { target, table }, context.signal);
  if (found.status === "matched") {
    return outcomeResult({
      ...base,
      text: found.line.text,
      center: found.line.center,
      frame: found.line.frame,
      matched_by: "jev",
      probability: found.probability,
      confidence: found.confidence,
      decision_ms: found.elapsedMs,
    });
  }
  if (found.status === "none") {
    return failureResult(
      `No recognized text fits "${target}". Recognized: ${JSON.stringify(screenTextPreview(snapshot.lines, OCR_RECOGNIZED_PREVIEW).map((l) => l.text))}. Try a smaller region, another app window, or capture.`,
      ToolReturnCode.NotFound,
    );
  }
  return outcomeResult({
    ...base,
    status: "uncertain",
    candidates: found.candidates,
    lines: screenTextPreview(snapshot.lines, LOCATE_PREVIEW),
    hint: "Jev was not sure. Pick a candidate (or a line) yourself, or narrow the target or region.",
  });
}

function clickNeighborhood(point: Point, frame: Rect | undefined): Rect | undefined {
  if (!frame) return undefined;
  const width = Math.min(frame.width, VERIFY_AREA.width);
  const height = Math.min(frame.height, VERIFY_AREA.height);
  const x = Math.min(Math.max(point.x - width / 2, frame.x), frame.x + frame.width - width);
  const y = Math.min(Math.max(point.y - height / 2, frame.y), frame.y + frame.height - height);
  return { x: round1(x), y: round1(y), width: round1(width), height: round1(height) };
}

type ClickDelivery = { pid?: number };

async function verifyClick(
  svc: ComputerUseService,
  expectation: string,
  clicked: Outcome,
  options: CallOptions,
): Promise<Outcome> {
  const client = await computerUseJevClient();
  if (!client) return { status: "skipped", reason: "No Jev model is configured. Check the result with computer_screen." };
  const delivery = clicked.delivery as ClickDelivery | undefined;
  const point = clicked.clicked as Point | undefined;
  const target = typeof delivery?.pid === "number" ? delivery.pid : undefined;
  const quiet: CallOptions = { ...options, avoidOcclusion: false };
  let result: Outcome = { status: "unclear" };
  try {
    for (const wait of VERIFY_WAITS_MS) {
      await delay(wait, undefined, options);
      const frame = (await svc.frontWindow(target, options.signal) ?? await svc.frontWindow(undefined, options.signal))?.frame;
      const area = point ? clickNeighborhood(point, frame) : frame;
      const snapshot = await svc.ocrScreen({ lang: "zh-Hans", ...(area ? { region: area } : {}) }, quiet);
      const table = screenElements(snapshot.lines, snapshot.area);
      if (table.elements.length === 0) {
        result = { status: "unclear", reason: "No text was recognized near the click." };
        continue;
      }
      const check = await checkScreen(client, { expectation, table }, options.signal);
      if (check.checkable === false) {
        return {
          expected: "not_checkable",
          reason: "Screen text cannot show this (focus, front window and similar states). Check it another way, e.g. computer_ui or the typed text.",
          decision_ms: check.elapsedMs,
        };
      }
      result = {
        expected: check.expected,
        probability: check.expectedProbability,
        dialog: check.dialog,
        error: check.error,
        decision_ms: check.elapsedMs,
        ...(check.expected === "yes" ? {} : { screen_text: screenTextPreview(snapshot.lines, VERIFY_PREVIEW) }),
      };
      if (check.expected !== "unclear") break;
    }
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForScreen(
  svc: ComputerUseService,
  wanted: string,
  args: JsonObject,
  context: ToolExecuteContext,
  options: CallOptions,
): Promise<ToolExecuteResult> {
  const timeoutMs = Math.round(Math.min(WAIT_MAX_S, Math.max(1, num(args, "timeout_s") ?? WAIT_DEFAULT_S)) * 1000);
  const fixed = region(args);
  const app = appRef(args);
  const started = performance.now();
  let checks = 0;
  let unchanged = 0;
  let last: ScreenShows | null = null;
  while (true) {
    checks += 1;
    const area = fixed ?? (await svc.frontWindow(app, context.signal))?.frame;
    const previous: ScreenShows | null = last;
    last = await screenShowsOnce(svc.ocrScreen.bind(svc), wanted, area, options, previous);
    unchanged = previous && previous.fingerprint === last.fingerprint ? unchanged + 1 : 0;
    const waited = Math.round(performance.now() - started);
    if (last.status === "yes") return outcomeResult({ satisfied: true, waited_ms: waited, checks, matched_by: last.matchedBy });
    if (unchanged >= WAIT_SETTLED_READS && waited >= WAIT_SETTLED_MIN_MS) {
      return outcomeResult({
        satisfied: false,
        status: "settled",
        waited_ms: waited,
        checks,
        screen_text: screenTextPreview(last.lines, VERIFY_PREVIEW),
        hint: "The screen stopped changing without showing it. It may be off-screen (scroll), on another page, or worded differently — act on screen_text instead of waiting again.",
      });
    }
    if (last.status === "not_checkable") {
      return outcomeResult({
        satisfied: false,
        status: "not_checkable",
        waited_ms: waited,
        hint: "Screen text cannot show this. Wait for visible text instead, or check with computer_ui.",
      });
    }
    if (waited + WAIT_POLL_MS >= timeoutMs) break;
    await delay(WAIT_POLL_MS, undefined, options);
  }
  return outcomeResult({
    satisfied: false,
    status: "timeout",
    waited_ms: Math.round(performance.now() - started),
    checks,
    screen_text: screenTextPreview(last?.lines ?? [], VERIFY_PREVIEW),
    hint: "Not visible yet. Look at screen_text before deciding whether to wait again or act.",
  });
}

export const computerScreenHandler = guarded(async (args, context, svc) => {
  const action = str(args, "action");
  const options = callOptions(args, context);
  switch (action) {
    case "capture": {
      const path = await captureOutputPath(args, context);
      if (typeof path !== "string") return path;
      const area = region(args);
      const captured = await svc.capture({ path, ...(area ? { region: area } : {}) }, options);
      const info = await stat(path);
      const thumbnail = await imageThumbnailFromFile(path, "image/png", info.size);
      const { path: _written, ...rest } = captured;
      return {
        returnCode: ToolReturnCode.Success,
        content: [
          {
            type: "text",
            text: JSON.stringify({ path: displayPath(path), ...rest, hint: "Inspect with read_image; pixel coordinates map to the screen via rect." }, null, 2),
          },
          {
            type: "attachment",
            kind: "image",
            uri: pathToFileURL(path).href,
            name: basename(path),
            mimeType: "image/png",
            sizeBytes: info.size,
            ...(thumbnail ? { thumbnailBase64: thumbnail.base64, thumbnailMimeType: thumbnail.mimeType } : {}),
          },
        ],
      };
    }
    case "find_text": {
      const text = str(args, "text");
      if (!text) throw new ArgumentError('action=find_text requires "text".');
      const area = region(args);
      const index = Math.max(0, num(args, "index") ?? 0);
      const client = index === 0 ? await computerUseJevClient() : null;
      return outcomeResult(await svc.findText({
        text, index, lang: lang(args), ...(area ? { region: area } : {}),
        ...(client ? { onMiss: (lines: ScreenLine[], read: Rect) => findTextWithJev(client, text, lines, read, context.signal) } : {}),
      }, options));
    }
    case "read_text": {
      const area = region(args);
      return outcomeResult(await svc.readText({ lang: lang(args), ...(area ? { region: area } : {}) }, options));
    }
    case "wait_for": {
      const wanted = str(args, "text")?.trim();
      if (!wanted) throw new ArgumentError('action=wait_for requires "text".');
      return waitForScreen(svc, wanted, args, context, options);
    }
    case "locate": {
      const target = str(args, "target")?.trim();
      if (!target) throw new ArgumentError('action=locate requires "target".');
      return locate(svc, target, args, context, options);
    }
    case "pursue": {
      const goal = str(args, "goal")?.trim();
      if (!goal) throw new ArgumentError('action=pursue requires "goal".');
      const client = await computerUseJevClient();
      if (!client) {
        return failureResult(
          "pursue needs a decision model (Setting → Models → Decision model). Work step by step instead: locate / find_text, then computer_mouse.",
          ToolReturnCode.NotFound,
        );
      }
      const paused = await takeoverGate(context, svc);
      if (paused) return paused;
      const fixed = region(args);
      const app = appRef(args);
      const steps = num(args, "max_steps") ?? PURSUE_DEFAULT_STEPS;
      return outcomeResult(await runPursue({
        goal,
        maxSteps: Math.min(PURSUE_MAX_STEPS, Math.max(1, Math.floor(steps))),
        lang: lang(args),
        resolveArea: async () => fixed ?? (await svc.frontWindow(app, context.signal))?.frame,
      }, {
        svc,
        client,
        options,
        detectTakeover: () => awaitPointerTakeover(svc, context, takeoverDeps ?? {}),
      }));
    }
    default:
      return unknownAction("computer_screen", action, SCREEN_ACTIONS);
  }
});

function handoffHint(outcome: HandoffOutcome, kind: string): string | undefined {
  switch (outcome) {
    case "done":
      return "The user says it is done. Check the screen before relying on it.";
    case "skipped":
      return "The user skipped this step. Carry on without it, or explain what is blocked.";
    case "declined":
      return "The user declined. Do not perform this step.";
    case "timeout":
      return kind === "confirm"
        ? "No answer in time; treat it as declined and do not perform this step."
        : "No answer in time. Do not assume the step was done.";
    case "unanswered":
      return "Nobody answered. Do not assume the step was done.";
    default:
      return undefined;
  }
}

function existingPasswordResult(): ToolExecuteResult {
  return textResult(JSON.stringify({
    outcome: "auto",
    password_present: true,
    shown_on_screen: false,
    hint: "The browser password field already contains a password. If sign-in is pending, wait. Otherwise click the enabled Sign in button once and verify the outcome. Use a password handoff with sign_in_failed=true only if the submitted sign-in is rejected and needs a new password.",
  }), ToolReturnCode.Success);
}

const runComputerHandoff: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;
  if (context.subagentTurn) {
    return failureResult("computer_handoff is only available to the main agent.", ToolReturnCode.PermissionDenied);
  }
  const lookup = serviceOverride || computerUsePlatform() ? service() : null;
  let parsed: ParsedHandoff;
  try {
    parsed = await parseHandoffRequest(args, lookup);
  } catch (error) {
    if (error instanceof HandoffArgumentError) return failureResult(`Invalid arguments: ${error.message}`, ToolReturnCode.InvalidArguments);
    return failureResult(error instanceof Error ? error.message : String(error), ToolReturnCode.GenericFailure);
  }
  if (parsed.passwordApp !== undefined && context.headlessMode) {
    return failureResult("Ask the user to enter the password in the target app directly.", ToolReturnCode.GenericFailure);
  }
  const tips = tipsOverlay();
  if (!tips.available && !context.requestUserAsk) {
    return failureResult(
      "There is no way to reach the user here (no on-screen tips and no conversation card). Describe the step in your reply instead.",
      ToolReturnCode.GenericFailure,
    );
  }
  const targetState = parsed.passwordApp !== undefined
    ? await lookup?.preparePasswordFill(parsed.passwordApp, context.signal, parsed.request.anchor, parsed.signInFailed)
    : null;
  if (targetState?.status === "already_filled") return existingPasswordResult();
  let prepared = context.requestUserAsk ? targetState : null;
  if (!prepared) targetState?.discard();
  let passwordFilled = false;
  if (!parsed.signInFailed && prepared?.login && context.trySavedHandoffPassword) {
    const restored = await context.trySavedHandoffPassword(prepared, context.signal);
    if (restored === "filled") {
      prepared.discard();
      return textResult(JSON.stringify({
        outcome: "done", via: "watch", waited_s: 0, password_filled: true, shown_on_screen: false,
        hint: "The password was filled in the verified field. Check the app before continuing, without reading the password.",
      }), ToolReturnCode.Success);
    }
    if (restored === "failed" && parsed.passwordApp !== undefined) {
      prepared.discard();
      const refreshed = await lookup?.preparePasswordFill(parsed.passwordApp, context.signal, parsed.request.anchor);
      if (refreshed?.status === "already_filled") return existingPasswordResult();
      prepared = refreshed;
    }
  }
  if (parsed.passwordApp !== undefined) {
    parsed.request.message ||= prepared
      ? "You can also enter the password in the target app, then choose Done."
      : "Enter the password in the target app, then choose Done.";
  }
  if (prepared) {
    const target = prepared;
    if (prepared.frame) parsed.request.anchor = prepared.frame;
    parsed.request.timeoutMs = Math.min(parsed.request.timeoutMs ?? 300_000, 300_000);
    parsed.request.desktopPassword = {
      destination: prepared.destination,
      ...(prepared.login ? { login: prepared.login } : {}),
      fill: async (password, signal, login) => {
        passwordFilled = await target.fill(password, signal, login);
        return passwordFilled;
      },
    };
  }
  if (parsed.qrCode) {
    const qr = parsed.request.anchor && context.requestUserAsk
      ? await lookup?.captureHandoffQr(parsed.request.anchor, callOptions(args, context)).catch(() => undefined)
      : undefined;
    if (qr) parsed.request.handoffQrPng = qr;
    parsed.request.message ||= qr
      ? "Scan the code with your phone, then choose Done."
      : "Scan the code in the target app, then choose Done.";
    parsed.request.timeoutMs ??= 300_000;
  }
  const result = await runHandoff(parsed.request, {
    tips,
    ...(context.requestUserAsk ? { ask: context.requestUserAsk } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  }).finally(() => prepared?.discard());
  if (result.outcome === "cancelled") return failureResult("Cancelled", ToolReturnCode.Cancelled);
  if (result.via === "screen" || result.via === "conversation") context.resetModelIterations?.();
  const filled = passwordFilled && result.outcome === "done";
  const hint = filled
    ? "The password was filled in the verified field. Check the app before continuing, without reading the password."
    : handoffHint(result.outcome, parsed.request.kind);
  return textResult(
    JSON.stringify(
      {
        outcome: result.outcome,
        ...(result.choice !== undefined ? { choice: result.choice } : {}),
        ...(result.custom ? { custom: true } : {}),
        via: result.via,
        waited_s: Math.round(result.waitedMs / 1000),
        ...(filled ? { password_filled: true } : {}),
        shown_on_screen: result.shownOnScreen,
        ...(parsed.targetMissed ? { target_found: false } : {}),
        ...(hint ? { hint } : {}),
      },
      null,
      2,
    ),
    ToolReturnCode.Success,
  );
};

export const computerHandoffHandler: ToolHandler = (args, context) =>
  coordinateDesktopOperation(false, () => runComputerHandoff(args, context));

export const computerBatchHandler = guarded((args, context, svc) =>
  runComputerBatch(args, context, svc, () => awaitPointerTakeover(svc, context, takeoverDeps ?? {})), true);

export const computerUseTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  { definition: computerSystemDefinition, handler: computerSystemHandler },
  { definition: computerMouseDefinition, handler: computerMouseHandler },
  { definition: computerKeyboardDefinition, handler: computerKeyboardHandler },
  { definition: computerUiDefinition, handler: computerUiHandler },
  { definition: computerScreenDefinition, handler: computerScreenHandler },
  { definition: computerHandoffDefinition, handler: computerHandoffHandler },
  { definition: computerBatchDefinition, handler: computerBatchHandler },
];
