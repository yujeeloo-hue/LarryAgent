/**
 * present_demo web cards — Mac-parity port of DemoCardView +
 * DemoConfirmCardView with web-specific plumbing (plan §5):
 * - preview iframe renders inline `htmlBase64` via srcdoc (the web console
 *   has no jellybot-file protocol access); missing payload → degradation
 *   bar, the form still works
 * - deferred iframe mount (mountPreview/unmountPreview) wired to the
 *   details card toggle by toolCards.ts
 * - Confirm → onSubmitDemoParams; main.ts owns the D7 wire send
 *   (submitDemoConfirm: idle→startTurn, running→enqueuePrompt)
 * - buildDemoScan: settled scan over session messages ∪ prompt queue
 */
import { appendDemoParamsPopover, createDemoSelectControl } from "../../../src/shared/demoParamsPopover.js";
import { el } from "./render.js";
import { icon } from "./icons.js";
import {
  isSliderNumberSpec,
  parseDemoParams,
  sliderDecimals,
  type DemoParamSpec,
} from "../../../src/session/demoParams.js";
import {
  buildDemoConfirmMessage,
  parseDemoConfirmMessage,
  type DemoConfirmMessage,
} from "../../../src/session/demoConfirm.js";
import type { Message, ToolResultPart } from "./types.js";

import { restoreDemoDecision, submitDemoDecision, type DemoCardState, type DemoCardValues, type DemoSettled, type DemoSubmitHandler } from "../../../src/session/demoCardState.js";
export type { DemoCardValues } from "../../../src/session/demoCardState.js";

export const DEMO_PARAMS_MESSAGE_TYPE = "jellybot-demo-params";
const POST_MESSAGE_THROTTLE_MS = 60;

export type DemoArgsInfo = {
  path: string;
  title: string;
  prompt?: string;
  params: DemoParamSpec[];
};

/** present_demo args → card data (tolerant while arguments stream in). */
export function demoArgsInfo(args: unknown): DemoArgsInfo | null {
  const record = args as
    | { path?: unknown; title?: unknown; prompt?: unknown; params?: unknown }
    | null
    | undefined;
  if (!record || typeof record !== "object") return null;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const title =
    typeof record.title === "string" && record.title.trim()
      ? record.title.trim()
      : "";
  const prompt =
    typeof record.prompt === "string" && record.prompt.trim()
      ? record.prompt.trim()
      : undefined;
  const parsed = parseDemoParams(record.params);
  const base = path ? path.replace(/\\/g, "/").split("/").pop() ?? "" : "";
  return {
    path,
    title: title || base || "Demo",
    ...(prompt ? { prompt } : {}),
    params: parsed.ok ? parsed.params : [],
  };
}

/** Summary-row hint: `index.html · 2 params`. */
export function demoCardHint(info: DemoArgsInfo): string {
  const base = info.path
    ? info.path.replace(/\\/g, "/").split("/").pop() ?? ""
    : "demo";
  return info.params.length > 0
    ? `${base || "demo"} · ${info.params.length} params`
    : base || "demo";
}

/** Tool result content → inline html attachment payload, if any. */
export function demoHtmlFromResult(result: ToolResultPart): string | null {
  const content = result.content as unknown;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "attachment" && typeof record.htmlBase64 === "string" && record.htmlBase64) {
      return record.htmlBase64;
    }
  }
  return null;
}

/** base64 → UTF-8 text (atob is latin1; go through bytes + TextDecoder). */
export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function initialFormValue(spec: DemoParamSpec): string | number | boolean {
  if (spec.type === "boolean") return spec.default === true;
  if (spec.type === "number") {
    const n = Number(spec.default);
    return Number.isFinite(n) ? n : 0;
  }
  return String(spec.default);
}

/** Condensed "Submitted · a=1, b=x" line for the settled state. */
export function demoSettledSummaryText(paramsJson: string): string {
  const text = paramsJson.trim();
  if (!text) return "Submitted";
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length === 0) return "Submitted";
      return `Submitted · ${entries
        .map(
          ([key, value]) =>
            `${key}=${value === null || value === undefined ? "—" : String(value)}`,
        )
        .join(", ")}`;
    }
  } catch {
    // Unparseable payload — plain Submitted line.
  }
  return "Submitted";
}

function fileBasenameOf(path: string): string {
  return path ? path.replace(/\\/g, "/").split("/").pop() ?? "demo" : "demo";
}

export type DemoCardPanel = {
  root: HTMLElement;
  /** Mount the preview iframe (card opened) — no-op without a payload. */
  mountPreview(): void;
  /** Unmount the preview iframe (card closed) — form state survives. */
  unmountPreview(): void;
};

export type DemoCardPanelInput = {
  toolCallId: string;
  path: string;
  title: string;
  prompt?: string;
  params: DemoParamSpec[];
  hasResult: boolean;
  ok: boolean;
  /** Inline HTML payload (result attachment htmlBase64); null → degrade. */
  htmlBase64: string | null;
  settled: DemoSettled | null;
  state?: DemoCardState;
  /** Confirmed values (queue ∪ transcript scan) — settles the form. */
  onSubmitDemoParams?: DemoSubmitHandler;
  /** Card starts expanded → mount the iframe immediately. */
  initiallyOpen: boolean;
};

export function createDemoCardPanel(
  input: DemoCardPanelInput,
): DemoCardPanel {
  const root = el("div", {
    class: "content-card-demo",
    "data-demo-tool-call-id": input.toolCallId,
  });
  const state = input.state ?? { values: {}, note: "" };
  restoreDemoDecision(state, input.settled);
  const settled = state.status !== undefined;

  const preview = el("div", { class: "content-card-demo-preview" });
  let iframe: HTMLIFrameElement | null = null;
  let iframeLoaded = false;

  const staticNote = (text: string, extra = ""): HTMLElement =>
    el("div", { class: `content-card-demo-preview-note ${extra}`.trim() }, text);

  /** Values limited to the currently declared params (stream-safe). */
  const values = state.values;
  const currentValues = (): DemoCardValues => {
    const out: DemoCardValues = {};
    for (const spec of input.params) {
      out[spec.name] =
        spec.name in values ? values[spec.name]! : initialFormValue(spec);
    }
    return out;
  };

  // --- Live postMessage linkage (D6): throttled, silent while the iframe is
  // unmounted or not yet loaded; the load handler re-posts current values. ---
  let postTimer: ReturnType<typeof setTimeout> | null = null;
  const postValues = (immediate = false): void => {
    const send = (): void => {
      postTimer = null;
      const win = iframe?.contentWindow;
      if (!iframe || !iframeLoaded || !win) return;
      try {
        win.postMessage(
          { type: DEMO_PARAMS_MESSAGE_TYPE, values: currentValues() },
          "*",
        );
      } catch {
        // Cross-origin races are best-effort.
      }
    };
    if (immediate) {
      if (postTimer !== null) {
        clearTimeout(postTimer);
        postTimer = null;
      }
      send();
      return;
    }
    if (postTimer !== null) return;
    postTimer = setTimeout(send, POST_MESSAGE_THROTTLE_MS);
  };

  const canMountIframe =
    input.hasResult && input.ok && typeof input.htmlBase64 === "string" && input.htmlBase64.length > 0;

  const mountPreview = (): void => {
    if (iframe || !canMountIframe) return;
    iframeLoaded = false;
    const frame = document.createElement("iframe");
    frame.className = "content-card-demo-iframe";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", `${input.title} preview`);
    try {
      frame.setAttribute("srcdoc", decodeBase64Utf8(input.htmlBase64!));
    } catch {
      // Invalid payload — degrade to the unavailable bar.
      frame.remove();
      if (!preview.querySelector(".content-card-demo-preview-note")) {
        preview.append(
          staticNote(
            `Preview unavailable on web — ${fileBasenameOf(input.path)}`,
            "is-degraded",
          ),
        );
      }
      return;
    }
    frame.addEventListener("load", () => {
      iframeLoaded = true;
      postValues(true);
    });
    // Keep the floating params toggle (a preview child) — swap only the
    // note/iframe layer instead of clearing the whole container.
    preview.querySelector(".content-card-demo-preview-note")?.remove();
    preview.prepend(frame);
    iframe = frame;
  };

  const unmountPreview = (): void => {
    if (!iframe) return;
    iframe.remove();
    iframe = null;
    iframeLoaded = false;
    preview.prepend(staticNote("Preview paused — open to reload"));
  };

  // --- Preview zone state (static notes render regardless of mount). ---
  if (!input.hasResult) {
    preview.append(staticNote("Loading preview…"));
  } else if (!input.ok) {
    preview.append(
      staticNote("Demo failed to load — check the tool result.", "is-failed"),
    );
  } else if (!canMountIframe) {
    // htmlBase64 missing (size cap / legacy session) — degradation bar,
    // the parameter form still works (plan §5).
    preview.append(
      staticNote(
        `Preview unavailable on web — ${fileBasenameOf(input.path)}`,
        "is-degraded",
      ),
    );
  } else if (input.initiallyOpen) {
    mountPreview();
  } else {
    preview.append(staticNote("Preview paused — open to load"));
  }
  root.append(preview);

  // --- Form: one native control per declared param (five types, D5). ---
  const form = el("div", {
    class: `content-card-demo-form${input.params.length === 0 ? " is-empty" : ""}`,
  });
  const controls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [];
  for (const spec of input.params) {
    if (!(spec.name in values)) values[spec.name] = initialFormValue(spec);
    const slider = isSliderNumberSpec(spec)
      ? buildSliderLine(spec, values, postValues)
      : null;
    const control = slider
      ? slider.range
      : buildControl(spec, values, postValues);
    if (settled) control.disabled = true;
    controls.push(control);
    form.append(
      el("label", { class: "content-card-demo-row" },
        el("span", { class: "content-card-demo-label" }, spec.label || spec.name),
        slider ? slider.line : control,
      ),
    );
  }
  const paramsToggle = appendDemoParamsPopover(root, preview, form, input.params.length);

  // --- Optional note (included in the confirm message). ---
  let noteValue = state.note;
  const note = el("input", {
    type: "text",
    class: "content-card-demo-note",
    placeholder: "Add a note (optional)",
  }) as HTMLInputElement;
  note.value = state.note;
  note.addEventListener("input", () => {
    noteValue = note.value;
    state.note = note.value;
  });
  if (settled) note.disabled = true;
  root.append(note);

  if (input.prompt) {
    root.append(el("p", { class: "content-card-demo-prompt" }, input.prompt));
  }

  // --- Actions: Confirm while actionable; Submitted once settled. ---
  const actions = el("div", { class: "content-card-demo-actions" });
  const syncSubmission = (): void => {
    const locked = state.status !== undefined;
    for (const control of controls) control.disabled = locked;
    note.disabled = locked;
    if (paramsToggle) paramsToggle.disabled = locked;
    actions.replaceChildren();
    const status = state.status;
    if (status === "submitted" || status === "queued") {
      actions.append(el("span", { class: "content-card-demo-submitted" }, demoSettledSummaryText(state.submittedJson ?? "").replace(/^Submitted/, status === "queued" ? "Queued" : "Submitted")));
      return;
    }
    if (!input.hasResult || !input.ok) {
      actions.append(el("span", { class: "content-card-demo-submitted is-waiting" }, "Waiting for the demo…"));
      return;
    }
    const confirmBtn = el("button", {
      type: "button", class: "content-card-demo-confirm-btn action-primary",
    }, status === "submitting" ? "Submitting…" : state.error ? "Retry" : "Confirm") as HTMLButtonElement;
    confirmBtn.disabled = status === "submitting" || !input.onSubmitDemoParams;
    confirmBtn.addEventListener("click", () => {
      if (state.status || !input.onSubmitDemoParams) return;
      confirmBtn.disabled = true;
      const pending = submitDemoDecision(state, currentValues(), noteValue.trim() || undefined, input.onSubmitDemoParams);
      syncSubmission();
      if (pending) void pending.then(syncSubmission);
    });
    actions.append(confirmBtn);
    if (state.error) actions.append(el("span", { class: "content-card-demo-error", role: "alert" }, `Could not submit: ${state.error}`));
  };
  actions.setAttribute("aria-live", "polite");
  syncSubmission();
  if (state.pending) void state.pending.then(syncSubmission);
  root.append(actions);

  return { root, mountPreview, unmountPreview };
}

/** Variant A (user-confirmed 2026-10-24): bounded number → slider + readout. */
function buildSliderLine(
  spec: DemoParamSpec,
  values: DemoCardValues,
  postValues: () => void,
): { line: HTMLElement; range: HTMLInputElement } {
  const min = spec.min as number;
  const max = spec.max as number;
  const line = el("div", { class: "content-card-demo-slider-line" });
  const range = el("input", {
    type: "range",
    class: "content-card-demo-control content-card-demo-range",
  }) as HTMLInputElement;
  range.min = String(min);
  range.max = String(max);
  if (spec.step !== undefined) range.step = String(spec.step);
  const decimals = sliderDecimals(spec.step);
  const readout = el("span", { class: "content-card-demo-readout" });
  const paint = (value: number) => {
    readout.textContent = value.toFixed(decimals);
    range.style.setProperty("--fill", `${((value - min) / (max - min)) * 100}%`);
  };
  const current = Number(values[spec.name]);
  const initial = Number.isFinite(current)
    ? Math.min(max, Math.max(min, current))
    : min;
  range.value = String(initial);
  values[spec.name] = initial;
  paint(initial);
  range.addEventListener("input", () => {
    const v = Number(range.value);
    values[spec.name] = Number.isFinite(v) ? v : null;
    if (Number.isFinite(v)) paint(v);
    postValues();
  });
  line.append(range, readout);
  return { line, range };
}

function buildControl(
  spec: DemoParamSpec,
  values: DemoCardValues,
  postValues: () => void,
): HTMLInputElement | HTMLSelectElement | HTMLButtonElement {
  if (spec.type === "select") {
    // App-drawn combobox: native <select> popups render below the popover's
    // top layer in Chromium and cannot be picked (fixed 2026-10-27).
    const initial = String(values[spec.name] ?? "");
    const options = spec.options ?? [];
    const value = options.includes(initial) ? initial : options[0] ?? "";
    if (options.length > 0) values[spec.name] = value;
    return createDemoSelectControl({
      label: spec.label || spec.name,
      options,
      value,
      onChange: (next) => {
        values[spec.name] = next;
        postValues();
      },
    }).el;
  }
  const field = document.createElement("input");
  if (spec.type === "boolean") {
    field.type = "checkbox";
    field.className = "content-card-demo-control is-checkbox";
    field.checked = values[spec.name] === true;
    field.addEventListener("change", () => {
      values[spec.name] = field.checked;
      postValues();
    });
    return field;
  }
  field.className = "content-card-demo-control";
  if (spec.type === "number") {
    field.type = "number";
    if (spec.min !== undefined) field.min = String(spec.min);
    if (spec.max !== undefined) field.max = String(spec.max);
    if (spec.step !== undefined) field.step = String(spec.step);
    const raw = values[spec.name];
    const n = raw === null ? NaN : Number(raw);
    field.value = Number.isFinite(n) ? String(n) : "";
    field.addEventListener("input", () => {
      const parsed = Number(field.value);
      values[spec.name] =
        field.value === "" || !Number.isFinite(parsed) ? null : parsed;
      postValues();
    });
    return field;
  }
  if (spec.type === "color") {
    field.type = "color";
    const c = String(values[spec.name] ?? "");
    field.value = /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#000000";
    field.addEventListener("input", () => {
      values[spec.name] = field.value;
      postValues();
    });
    return field;
  }
  field.type = "text";
  field.value = String(values[spec.name] ?? "");
  if (spec.placeholder) field.placeholder = spec.placeholder;
  field.addEventListener("input", () => {
    values[spec.name] = field.value;
    postValues();
  });
  return field;
}

// ── compact confirm summary card (DemoConfirmCardView port) ──────────

function confirmEntries(paramsJson: string): Array<[string, string]> {
  const text = paramsJson.trim();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    return Object.entries(parsed as Record<string, unknown>).map(
      ([key, value]) => [
        key,
        value === null || value === undefined ? "—" : String(value),
      ],
    );
  } catch {
    return [];
  }
}

/** D7 confirm message → compact card (check + N params + expandable rows). */
export function createDemoConfirmCard(input: DemoConfirmMessage): HTMLElement {
  const entries = confirmEntries(input.paramsJson);
  const card = el("details", {
    class: `content-card-demo-confirm${entries.length > 0 || input.note ? " is-expandable" : ""}`,
    "data-demo-tool-call-id": input.toolCallId,
  });
  const head = el("summary", { class: "content-card-demo-confirm-head" },
    el("span", { class: "content-card-demo-confirm-icon" }, icon("circleCheck", 14)),
    el("span", { class: "content-card-demo-confirm-title" },
      entries.length > 0 ? `Demo confirmed · ${entries.length} params` : "Demo confirmed"),
  );
  if (entries.length > 0) {
    const brief = el("span", { class: "content-card-demo-confirm-brief" },
      entries.map(([k, v]) => `${k}=${v}`).join(", "));
    brief.setAttribute("title", brief.textContent ?? "");
    head.append(
      brief,
      el("span", { class: "content-card-demo-confirm-chevron" }, icon("chevronDown", 13)),
    );
  }
  card.append(head);
  if (entries.length > 0 || input.note) {
    const body = el("div", { class: "content-card-demo-confirm-body" });
    for (const [key, value] of entries) {
      body.append(
        el("div", { class: "content-card-demo-confirm-row" },
          el("span", { class: "content-card-demo-confirm-key" }, key),
          el("span", { class: "content-card-demo-confirm-value" }, value),
        ),
      );
    }
    if (input.note) {
      body.append(
        el("p", { class: "content-card-demo-confirm-note" }, `Note: ${input.note}`),
      );
    }
    card.append(body);
  }
  return card;
}

// ── settled scan (transcript ∪ prompt queue) + confirm orchestration ──

export type DemoScan = {
  settledByCallId: Map<string, DemoSettled>;
  /** Newest unsettled present_demo call — the one demo card that opens. */
  openCallId: string | null;
};

/** present_demo call ids + confirm markers across messages and the queue. */
export function buildDemoScan(
  messages: Message[],
  queuedTexts: string[],
): DemoScan {
  const demoCallIds: string[] = [];
  const settledByCallId = new Map<string, DemoSettled>();
  const scan = (text: string, enqueued = false): void => {
    const parsed = parseDemoConfirmMessage(text);
    if (parsed) {
      settledByCallId.set(parsed.toolCallId, { paramsJson: parsed.paramsJson, ...(parsed.note ? { note: parsed.note } : {}), ...(enqueued ? { enqueued: true } : {}) });
    }
  };
  for (const msg of messages) {
    for (const part of msg.parts) {
      const record = part as Record<string, unknown>;
      if (
        record.type === "tool_call" &&
        typeof record.id === "string" &&
        record.name === "present_demo"
      ) {
        demoCallIds.push(record.id);
      }
    }
    if (msg.role === "user") {
      for (const part of msg.parts) {
        const record = part as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          scan(record.text);
        }
      }
    }
  }
  for (const text of queuedTexts) scan(text, true);
  let openCallId: string | null = null;
  for (const id of demoCallIds) {
    if (!settledByCallId.has(id)) openCallId = id;
  }
  return { settledByCallId, openCallId };
}

export type DemoConfirmClient = {
  request<T>(deviceId: string, action: string, payload: Record<string, unknown>): Promise<T>;
};

/**
 * Confirm → next turn (plan D1, non-blocking): idle starts a turn with the
 * D7 marker text; running enqueues deferred. Mirrors the composer submit
 * gesture semantics (startTurn while running errors on the device).
 */
export async function submitDemoConfirm(input: {
  client: DemoConfirmClient;
  deviceId: string;
  sessionId: string;
  running: boolean;
  toolCallId: string;
  values: DemoCardValues;
  note?: string;
}): Promise<{ enqueued: boolean; items?: unknown[] }> {
  const userText = buildDemoConfirmMessage({
    toolCallId: input.toolCallId,
    paramsJson: JSON.stringify(input.values),
    ...(input.note ? { note: input.note } : {}),
  });
  if (input.running) {
    const res = await input.client.request<{ items: unknown[] }>(
      input.deviceId,
      "enqueuePrompt",
      { sessionId: input.sessionId, userText, mode: "deferred" },
    );
    return { enqueued: true, items: res.items };
  }
  await input.client.request(input.deviceId, "startTurn", {
    sessionId: input.sessionId,
    userText,
  });
  return { enqueued: false };
}
