/**
 * present_demo card body — embedded preview iframe + generated parameter
 * form (plan §3). Presentation only: Confirm delegates to
 * onSubmitDemoParams; the controller owns the D7 wire format.
 */
import { appendDemoParamsPopover, createDemoSelectControl } from "../../../../../shared/demoParamsPopover.js";
import { appendDemoMaximize } from "../../../../../shared/demoMaximize.js";
import {
  isSliderNumberSpec,
  parseDemoParams,
  sliderDecimals,
  type DemoParamSpec,
} from "../../../../../session/demoParams.js";
import { localFileMediaUrl } from "../../../ui/localFileUrl.js";
import { playDemoConfirmChime } from "../../../ui/attentionSounds.js";

import { restoreDemoDecision, submitDemoDecision, type DemoCardState, type DemoCardValues, type DemoSettled, type DemoSubmitHandler } from "../../../../../session/demoCardState.js";
export type { DemoCardState, DemoCardValues } from "../../../../../session/demoCardState.js";

export type DemoCardPanelInput = {
  toolCallId: string;
  path: string;
  title: string;
  /** One-line guidance shown above the Confirm button. */
  prompt?: string;
  params: DemoParamSpec[];
  /** Tool finished — mount the preview iframe (running shows a skeleton). */
  hasResult: boolean;
  ok: boolean;
  /** Confirmed (or queued) values JSON — settles the form when present. */
  settled: DemoSettled | null;
  state: DemoCardState;
  onSubmitDemoParams?: DemoSubmitHandler;
};

export const DEMO_PARAMS_MESSAGE_TYPE = "jellybot-demo-params";
const POST_MESSAGE_THROTTLE_MS = 60;

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
        .map(([key, value]) =>
          `${key}=${value === null || value === undefined ? "—" : String(value)}`,
        )
        .join(", ")}`;
    }
  } catch {
    // Unparseable payload — plain Submitted line.
  }
  return "Submitted";
}

export function createDemoCardPanel(input: DemoCardPanelInput): HTMLElement {
  const root = document.createElement("div");
  root.className = "content-card-demo";
  root.dataset.demoToolCallId = input.toolCallId;

  restoreDemoDecision(input.state, input.settled);
  const settled = input.state.status !== undefined;

  // --- Preview: iframe only once the tool finished (mount strategy §3). ---
  const preview = document.createElement("dialog");
  preview.className = "content-card-demo-preview";
  preview.setAttribute("role", "region");
  preview.setAttribute("aria-label", `${input.title} preview`);
  let iframe: HTMLIFrameElement | null = null;
  let iframeLoaded = false;
  if (input.hasResult && input.ok && input.path) {
    iframe = document.createElement("iframe");
    iframe.className = "content-card-demo-iframe";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("title", `${input.title} preview`);
    iframe.src = `${localFileMediaUrl(input.path)}&demo=1`;
    iframe.addEventListener("load", () => {
      iframeLoaded = true;
      postValues(true);
    });
    preview.append(iframe);
  } else if (input.hasResult && !input.ok) {
    const failed = document.createElement("div");
    failed.className = "content-card-demo-preview-note is-failed";
    failed.textContent = "Demo failed to load — check the tool result.";
    preview.append(failed);
  } else {
    const pending = document.createElement("div");
    pending.className = "content-card-demo-preview-note";
    pending.textContent = "Loading preview…";
    preview.append(pending);
  }
  root.append(preview);

  /** Values limited to the currently declared params (stream-safe). */
  const currentValues = (): DemoCardValues => {
    const out: DemoCardValues = {};
    for (const spec of input.params) {
      out[spec.name] =
        spec.name in input.state.values
          ? input.state.values[spec.name]!
          : initialFormValue(spec);
    }
    return out;
  };

  // --- Live postMessage linkage (D6): throttled, silent when the iframe is
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

  // --- Form: one native control per declared param (five types, D5). ---
  const form = document.createElement("div");
  form.className = "content-card-demo-form";
  if (input.params.length === 0) form.classList.add("is-empty");
  for (const spec of input.params) {
    if (!(spec.name in input.state.values)) {
      input.state.values[spec.name] = initialFormValue(spec);
    }
    const row = document.createElement("label");
    row.className = "content-card-demo-row";
    const label = document.createElement("span");
    label.className = "content-card-demo-label";
    label.textContent = spec.label || spec.name;
    row.append(label);

    let control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
    let controlLine: HTMLDivElement | null = null;
    if (spec.type === "select") {
      // App-drawn combobox: native <select> popups render below the
      // popover's top layer in Chromium and cannot be picked (fixed
      // 2026-10-27, user-confirmed demo).
      const options = spec.options ?? [];
      const initial = String(input.state.values[spec.name] ?? "");
      const value = options.includes(initial) ? initial : options[0] ?? "";
      if (options.length > 0) input.state.values[spec.name] = value;
      control = createDemoSelectControl({
        label: spec.label || spec.name,
        options,
        value,
        onChange: (next) => {
          input.state.values[spec.name] = next;
          postValues();
        },
      }).el;
    } else if (spec.type === "boolean") {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "content-card-demo-control is-checkbox";
      checkbox.checked = input.state.values[spec.name] === true;
      checkbox.addEventListener("change", () => {
        input.state.values[spec.name] = checkbox.checked;
        postValues();
      });
      control = checkbox;
    } else if (spec.type === "number" && isSliderNumberSpec(spec)) {
      // Variant A (user-confirmed 2026-10-24): bounded numbers render as a
      // range slider + monospace readout instead of a bare number input.
      const min = spec.min as number;
      const max = spec.max as number;
      const line = document.createElement("div");
      line.className = "content-card-demo-slider-line";
      const range = document.createElement("input");
      range.type = "range";
      range.className = "content-card-demo-control content-card-demo-range";
      range.min = String(min);
      range.max = String(max);
      if (spec.step !== undefined) range.step = String(spec.step);
      const decimals = sliderDecimals(spec.step);
      const readout = document.createElement("span");
      readout.className = "content-card-demo-readout";
      const paint = (value: number) => {
        readout.textContent = value.toFixed(decimals);
        range.style.setProperty(
          "--fill",
          `${((value - min) / (max - min)) * 100}%`,
        );
      };
      const current = Number(input.state.values[spec.name]);
      const initial = Number.isFinite(current)
        ? Math.min(max, Math.max(min, current))
        : min;
      range.value = String(initial);
      input.state.values[spec.name] = initial;
      paint(initial);
      range.addEventListener("input", () => {
        const v = Number(range.value);
        input.state.values[spec.name] = Number.isFinite(v) ? v : null;
        if (Number.isFinite(v)) paint(v);
        postValues();
      });
      line.append(range, readout);
      control = range;
      controlLine = line;
    } else {
      const field = document.createElement("input");
      field.type =
        spec.type === "number" ? "number" : spec.type === "color" ? "color" : "text";
      field.className = "content-card-demo-control";
      if (spec.type === "number") {
        if (spec.min !== undefined) field.min = String(spec.min);
        if (spec.max !== undefined) field.max = String(spec.max);
        if (spec.step !== undefined) field.step = String(spec.step);
        const raw = input.state.values[spec.name];
        const n = raw === null ? NaN : Number(raw);
        field.value = Number.isFinite(n) ? String(n) : "";
        field.addEventListener("input", () => {
          const parsed = Number(field.value);
          input.state.values[spec.name] =
            field.value === "" || !Number.isFinite(parsed) ? null : parsed;
          postValues();
        });
      } else if (spec.type === "color") {
        const c = String(input.state.values[spec.name] ?? "");
        field.value = /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#000000";
        field.addEventListener("input", () => {
          input.state.values[spec.name] = field.value;
          postValues();
        });
      } else {
        field.value = String(input.state.values[spec.name] ?? "");
        if (spec.placeholder) field.placeholder = spec.placeholder;
        field.addEventListener("input", () => {
          input.state.values[spec.name] = field.value;
          postValues();
        });
      }
      control = field;
    }
    if (settled) control.disabled = true;
    row.append(controlLine ?? control);
    form.append(row);
  }
  const paramsToggle = appendDemoParamsPopover(preview, preview, form, input.params.length);
  if (iframe) appendDemoMaximize(preview, input.title);

  // --- Optional note (included in the confirm message). ---
  const note = document.createElement("input");
  note.type = "text";
  note.className = "content-card-demo-note";
  note.placeholder = "Add a note (optional)";
  note.value = input.state.note;
  note.addEventListener("input", () => {
    input.state.note = note.value;
  });
  if (settled) note.disabled = true;
  root.append(note);

  if (input.prompt) {
    const prompt = document.createElement("p");
    prompt.className = "content-card-demo-prompt";
    prompt.textContent = input.prompt;
    root.append(prompt);
  }

  // --- Actions: Confirm while actionable; Submitted once settled. ---
  const actions = document.createElement("div");
  actions.className = "content-card-demo-actions";
  const syncSubmission = (): void => {
    const locked = input.state.status !== undefined;
    for (const field of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")) field.disabled = locked;
    note.disabled = locked;
    if (paramsToggle) paramsToggle.disabled = locked;
    actions.replaceChildren();
    const status = input.state.status;
    if (status === "submitted" || status === "queued") {
      const done = document.createElement("span");
      done.className = "content-card-demo-submitted";
      done.textContent = demoSettledSummaryText(input.state.submittedJson ?? "").replace(/^Submitted/, status === "queued" ? "Queued" : "Submitted");
      actions.append(done);
      return;
    }
    if (!input.hasResult || !input.ok) {
      const waiting = document.createElement("span");
      waiting.className = "content-card-demo-submitted is-waiting";
      waiting.textContent = "Waiting for the demo…";
      actions.append(waiting);
      return;
    }
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "content-card-demo-confirm-btn action-primary";
    confirmBtn.textContent = status === "submitting" ? "Submitting…" : input.state.error ? "Retry" : "Confirm";
    confirmBtn.disabled = status === "submitting" || !input.onSubmitDemoParams;
    confirmBtn.addEventListener("click", () => {
      if (input.state.status || !input.onSubmitDemoParams) return;
      confirmBtn.disabled = true;
      const pending = submitDemoDecision(input.state, currentValues(), input.state.note.trim() || undefined, input.onSubmitDemoParams);
      syncSubmission();
      if (pending) void pending.then(() => {
        if (input.state.status === "submitted" || input.state.status === "queued") playDemoConfirmChime();
        syncSubmission();
      });
      else if (input.state.status) playDemoConfirmChime();
    });
    actions.append(confirmBtn);
    if (input.state.error) {
      const error = document.createElement("span");
      error.className = "content-card-demo-error";
      error.setAttribute("role", "alert");
      error.textContent = `Could not submit: ${input.state.error}`;
      actions.append(error);
    }
  };
  actions.setAttribute("aria-live", "polite");
  syncSubmission();
  if (input.state.pending) void input.state.pending.then(syncSubmission);
  root.append(actions);

  return root;
}

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
