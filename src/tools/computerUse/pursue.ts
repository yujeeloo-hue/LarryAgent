import { setTimeout as delay } from "node:timers/promises";
import type { JevClientConfig } from "../../llm/jevClient.js";
import type { HandoffResult } from "./handoff.js";
import { decideStep, redactScreenText, screenElements, screenTextPreview, type StepDecision } from "./jevScreen.js";
import { round1 } from "./motion.js";
import type { CallOptions, ComputerUseService, Outcome } from "./service.js";
import type { Rect, ScreenLine } from "./types.js";

export const PURSUE_DEFAULT_STEPS = 6;
export const PURSUE_MAX_STEPS = 10;
const SETTLE_MS = 450;
const WAIT_MS = 800;
const VERIFY_PAD = 24;
const SCROLL_LINES = 5;
const SCREEN_PREVIEW = 40;

export type PursueInput = {
  goal: string;
  maxSteps: number;
  lang: "zh-Hans" | "en";
  resolveArea: () => Promise<Rect | undefined>;
};

export type PursueDeps = {
  svc: ComputerUseService;
  client: JevClientConfig;
  options: CallOptions;
  detectTakeover: () => Promise<HandoffResult | null>;
};

type StepRecord = {
  step: number;
  action: string;
  text?: string;
  center?: { x: number; y: number };
  probability?: number;
  decision_ms: number;
};

type PursueOutcome =
  | "done"
  | "max_steps"
  | "blocked"
  | "uncertain"
  | "needs_confirmation"
  | "needs_text_input"
  | "nothing_readable"
  | "user_took_over"
  | "user_stopped"
  | "cancelled";

function compact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

function padded(frame: Rect): Rect {
  return {
    x: round1(frame.x - VERIFY_PAD),
    y: round1(frame.y - VERIFY_PAD),
    width: round1(frame.width + VERIFY_PAD * 2),
    height: round1(frame.height + VERIFY_PAD * 2),
  };
}

async function stillThere(svc: ComputerUseService, line: ScreenLine, lang: "zh-Hans" | "en", options: CallOptions): Promise<boolean> {
  const wanted = compact(line.text);
  if (!wanted) return false;
  try {
    const { lines } = await svc.ocrScreen({ region: padded(line.frame), lang }, { ...options, avoidOcclusion: false });
    return lines.some((candidate) => {
      const seen = compact(candidate.text);
      return seen.includes(wanted) || (seen.length >= 2 && wanted.includes(seen));
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return false;
  }
}

function takeoverOutcome(result: HandoffResult): PursueOutcome {
  if (result.outcome === "stopped") return "user_stopped";
  if (result.outcome === "cancelled") return "cancelled";
  return "user_took_over";
}

export async function runPursue(input: PursueInput, deps: PursueDeps): Promise<Outcome> {
  const { svc, client, options, detectTakeover } = deps;
  const steps: StepRecord[] = [];
  const recent: string[] = [];
  let lastLines: ScreenLine[] = [];
  let outcome: PursueOutcome = "max_steps";
  let detail = "";
  let candidates: Extract<StepDecision, { kind: "stop" }>["candidates"] = [];
  const started = performance.now();

  for (let step = 1; step <= input.maxSteps; step += 1) {
    if (options.signal?.aborted) {
      outcome = "cancelled";
      break;
    }
    const takeover = await detectTakeover();
    if (takeover) {
      outcome = takeoverOutcome(takeover);
      break;
    }
    const area = await input.resolveArea();
    const snapshot = await svc.ocrScreen({ lang: input.lang, ...(area ? { region: area } : {}) }, options);
    lastLines = snapshot.lines;
    const table = screenElements(snapshot.lines, snapshot.area);
    if (table.elements.length === 0) {
      outcome = "nothing_readable";
      detail = "OCR found no text in the target area.";
      break;
    }
    const decision = await decideStep(client, { goal: input.goal, table, recentActions: recent.slice(-6) }, options.signal);

    if (decision.kind === "done") {
      steps.push({ step, action: "done", probability: decision.probability, decision_ms: decision.elapsedMs });
      outcome = "done";
      break;
    }
    if (decision.kind === "stop") {
      outcome = decision.reason;
      detail = decision.detail;
      candidates = decision.candidates;
      break;
    }
    if (decision.kind === "wait") {
      steps.push({ step, action: "wait", probability: decision.probability, decision_ms: decision.elapsedMs });
      recent.push("Waited for the screen to settle");
      await delay(WAIT_MS, undefined, options);
      continue;
    }
    if (decision.kind === "scroll") {
      const target = { x: round1(snapshot.area.x + snapshot.area.width / 2), y: round1(snapshot.area.y + snapshot.area.height / 2) };
      await svc.mouseMove({ x: target.x, y: target.y }, options);
      await svc.mouseScroll({ dx: 0, dy: decision.direction === "down" ? -SCROLL_LINES : SCROLL_LINES, unit: "line" }, options);
      steps.push({ step, action: `scroll_${decision.direction}`, center: target, probability: decision.probability, decision_ms: decision.elapsedMs });
      recent.push(`Scrolled ${decision.direction}`);
      await delay(SETTLE_MS, undefined, options);
      continue;
    }

    const text = redactScreenText(decision.line.text);
    if (!(await stillThere(svc, decision.line, input.lang, options))) {
      steps.push({ step, action: "skipped_moved_target", text, decision_ms: decision.elapsedMs });
      recent.push(`"${text}" moved before it could be clicked`);
      continue;
    }
    const recheck = await detectTakeover();
    if (recheck) {
      outcome = takeoverOutcome(recheck);
      break;
    }
    await svc.mouseClick({
      x: decision.line.center.x,
      y: decision.line.center.y,
      button: "left",
      clicks: 1,
      holdS: 0.05,
    }, options);
    steps.push({ step, action: "click", text, center: decision.line.center, probability: decision.probability, decision_ms: decision.elapsedMs });
    recent.push(`Clicked "${text}"`);
    await delay(SETTLE_MS, undefined, options);
  }

  const clicked = steps.some((s) => s.action === "click" || s.action.startsWith("scroll"));
  return {
    outcome,
    goal: input.goal,
    steps,
    elapsed_ms: Math.round(performance.now() - started),
    ...(detail ? { detail } : {}),
    ...(candidates.length > 0 ? { candidates } : {}),
    ...(outcome !== "done" && lastLines.length > 0 ? { screen_text: screenTextPreview(lastLines, SCREEN_PREVIEW) } : {}),
    hint: hintFor(outcome, clicked),
  };
}

function hintFor(outcome: PursueOutcome, acted: boolean): string {
  switch (outcome) {
    case "done":
      return "The screen shows the goal is complete. Verify anything important before relying on it.";
    case "needs_confirmation":
      return "Stopped before a step with a material effect. Confirm with computer_handoff kind=confirm, or click it yourself if the user already asked for it.";
    case "needs_text_input":
      return "Focus the field and type with computer_keyboard, then continue.";
    case "user_stopped":
      return "The user chose Stop task. Stop computer use and report progress.";
    case "user_took_over":
      return "The user took the mouse. Look at the screen again before continuing.";
    case "cancelled":
      return "Report what was completed.";
    default:
      return acted
        ? "Some steps were applied. Continue from screen_text with find_text / computer_mouse, or call pursue again with a narrower goal."
        : "Nothing was clicked. Continue from screen_text with find_text / computer_mouse, or narrow the goal or region.";
  }
}
