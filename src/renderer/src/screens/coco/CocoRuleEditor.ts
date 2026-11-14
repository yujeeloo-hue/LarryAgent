import type { CocoRule, CocoSnapshot } from "../../../../coco/types.js";
import { button, el, field, input } from "./dom.js";
import { AppDropdown, type AppDropdownOption } from "../../ui/appDropdown.js";
import { describeCadence } from "../../../../loops/schedule.js";

const RULE_MODE_OPTIONS = [
  { value: "fixed", label: "Fixed execution" },
  { value: "inspection", label: "Proactive inspection" },
];

const CADENCE_KIND_OPTIONS = [
  { value: "minute", label: "Every N minutes" },
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "year", label: "Yearly" },
];

const RUN_MODE_OPTIONS = [
  { value: "agent", label: "Agent" },
  { value: "ask", label: "Read only" },
  { value: "plan", label: "Plan & execute" },
];

/**
 * Model picker — default row plus the configured providers, refreshed once the
 * settings load. Keeps `labels` in sync so summaries can name the current
 * choice (`<select>.selectedOptions` has no dropdown equivalent).
 */
function modelDropdown(
  selected: string,
  defaultLabel: string,
  labels: Map<string, string>,
  optionsUpdated: () => void,
): AppDropdown {
  labels.set("", defaultLabel);
  const entries: AppDropdownOption[] = [{ value: "", label: defaultLabel }];
  if (selected) {
    labels.set(selected, "Selected model");
    entries.push({ value: selected, label: "Selected model" });
  }
  const dropdown = new AppDropdown(entries, selected, { ariaLabel: "Model" });
  void window.jellybot?.getWorkspaceSettings().then(settings => {
    const current = dropdown.value;
    const options: AppDropdownOption[] = [{ value: "", label: defaultLabel }];
    for (const p of settings.providers) {
      const label = `${p.name} · ${p.modelId}`;
      labels.set(p.id, label);
      options.push({ value: p.id, label });
    }
    if (current && !settings.providers.some(p => p.id === current)) {
      labels.set(current, "Unavailable model — choose another");
      options.push({ value: current, label: "Unavailable model — choose another" });
    }
    dropdown.update(options, current);
    optionsUpdated();
  }).catch(() => { /* Preserve the current choice if model settings are unavailable. */ });
  return dropdown;
}

export function ruleEditor(snapshot: CocoSnapshot, existing: CocoRule | undefined, saved: (rule: CocoRule) => Promise<void>, cancel: () => void): HTMLElement {
  const form = el("form", "coco-rule-editor");
  const heading = el("header", "coco-rule-editor-head"), headingCopy = el("div");
  headingCopy.append(el("div", "coco-rule-breadcrumb", "Automation / Rules"), el("h1", "", existing ? "Edit rule" : "Create rule"));
  heading.append(headingCopy);
  form.append(heading);
  const name = input(existing?.name ?? ""), objective = el("textarea"); objective.value = existing?.objective ?? ""; objective.rows = 3;
  name.placeholder = "e.g. Daily project review";
  objective.placeholder = "What should CoCo accomplish or look out for?";
  const mode = new AppDropdown(RULE_MODE_OPTIONS, existing?.mode ?? "fixed", { ariaLabel: "Rule type" });
  const all = input("", "checkbox"); all.checked = existing?.scope.all ?? false;
  const projects = el("div", "coco-project-options");
  const selected = new Map<string, HTMLInputElement>();
  snapshot.workspaces.forEach(w => { const checkbox = input("", "checkbox"); checkbox.checked = existing?.scope.workspaceIds.includes(w.id) ?? false; selected.set(w.id, checkbox); projects.append(field(w.name, checkbox)); });
  const excludedIds = new Set(existing?.scope.excludedWorkspaceIds ?? []);
  const exclude = el("div", "coco-project-options");
  (snapshot.workspaceOptions ?? snapshot.workspaces).forEach(w => { const box = input("", "checkbox"); box.checked = excludedIds.has(w.id); box.onchange = () => { if (box.checked) excludedIds.add(w.id); else excludedIds.delete(w.id); }; exclude.append(field(w.name, box)); });
  const cadenceKind = new AppDropdown(CADENCE_KIND_OPTIONS, existing?.cadence.kind ?? "day", { ariaLabel: "Schedule" });
  const minute = input(String(existing?.cadence.kind === "minute" ? existing.cadence.n : existing?.cadence.kind === "hour" ? existing.cadence.minute : 15), "number");
  const time = input(existing && "time" in existing.cadence ? existing.cadence.time : "09:00", "time");
  const weekdays = el("div", "coco-project-options"), days = new Map<number, HTMLInputElement>();
  ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach((label,index) => { const box = input("", "checkbox"); box.checked = existing?.cadence.kind === "week" ? existing.cadence.weekdays.includes(index) : index > 0 && index < 6; days.set(index,box); weekdays.append(field(label,box)); });
  const day = input(String(existing && "day" in existing.cadence ? existing.cadence.day : 1), "number");
  const month = input(String(existing?.cadence.kind === "year" ? existing.cadence.month : 1), "number");
  const enabled = input("", "checkbox"); enabled.checked = existing?.enabled ?? true;
  const enabledField = field("Enabled", enabled); enabledField.classList.add("coco-rule-enabled"); heading.append(enabledField);
  const modelLabels = new Map<string, string>();
  const provider = modelDropdown(existing?.providerId ?? "", "Use CoCo default model", modelLabels, () => syncSummaries());
  const runMode = new AppDropdown(RUN_MODE_OPTIONS, existing?.runMode ?? "agent", { ariaLabel: "Task execution" });
  const acceptance = el("textarea"); acceptance.rows = 3; acceptance.value = existing?.acceptance.map(c => c.description).join("\n") ?? "";
  const error = el("p", "coco-error"); error.setAttribute("role", "alert");
  const projectsField = field("Selected projects",projects), minuteField = field("Every (minutes)",minute), timeField = field("Time (system timezone)",time), weekdaysField = field("Days of the week",weekdays), dayField = field("Day of month",day), monthField = field("Month (1–12)",month);
  weekdays.classList.add("coco-rule-weekdays"); weekdaysField.classList.add("coco-rule-span");
  timeField.querySelector("span")!.textContent = "Time";
  day.min = "1"; day.max = "31"; month.min = "1"; month.max = "12";
  const syncFields = (): void => {
    const kind = cadenceKind.value;
    projectsField.hidden = all.checked;
    minuteField.hidden = !["minute","hour"].includes(kind); timeField.hidden = ["minute","hour"].includes(kind); weekdaysField.hidden = kind !== "week"; dayField.hidden = !["month","year"].includes(kind); monthField.hidden = kind !== "year";
    minute.disabled = Boolean(minuteField.hidden); time.disabled = Boolean(timeField.hidden); day.disabled = Boolean(dayField.hidden); month.disabled = Boolean(monthField.hidden); days.forEach(box => { box.disabled = Boolean(weekdaysField.hidden); });
    minuteField.querySelector("span")!.textContent = kind === "hour" ? "Minute of the hour (0–59)" : "Every (minutes)";
    minute.min = kind === "hour" ? "0" : "1"; if (kind === "hour") minute.max = "59"; else minute.removeAttribute("max");
  };
  all.onchange = syncFields; cadenceKind.addEventListener("change", syncFields);
  mode.addEventListener("change", () => { if (!existing && mode.value === "inspection") { cadenceKind.value = "minute"; minute.value = String(snapshot.settings.heartbeatMinutes); } syncFields(); });
  const group = (title: string, description?: string): { root: HTMLElement; body: HTMLElement } => {
    const root = el("section", "coco-rule-section"), head = el("div", "coco-rule-section-head"), body = el("div", "coco-rule-fields");
    const titleNode = el("h2", "", title); titleNode.id = `rule-${crypto.randomUUID()}`; root.setAttribute("aria-labelledby", titleNode.id); head.append(titleNode);
    if (description) head.append(el("p", "", description)); root.append(head, body); return { root, body };
  };
  const disclosure = (title: string, nested = false): { root: HTMLDetailsElement; body: HTMLElement; meta: HTMLElement } => {
    const root = el("details", nested ? "coco-rule-disclosure is-nested" : "coco-rule-disclosure"), summary = el("summary"), copy = el("span", "coco-rule-disclosure-copy"), meta = el("span", "coco-rule-disclosure-meta"), body = el("div", "coco-rule-disclosure-body");
    copy.append(el("span", "coco-rule-disclosure-title", title), meta);
    const chevron = el("span", "coco-rule-chevron", "›"); chevron.setAttribute("aria-hidden", "true"); summary.append(copy, chevron); root.append(summary, body); return { root, body, meta };
  };
  const basics = group("Rule details"), basicsGrid = el("div", "coco-rule-grid"), typeField = field("Rule type", mode.el);
  const modeHint = el("small", "coco-rule-hint"); typeField.append(modeHint);
  basicsGrid.append(field("Name", name), typeField); basics.body.append(basicsGrid, field("Goal", objective));
  const scope = group("Projects"), allField = field("All current and future projects", all);
  allField.classList.add("coco-rule-all-projects");
  const exclusions = disclosure("Excluded projects", true); exclusions.body.append(exclude);
  if (!projects.childElementCount) projects.append(el("p", "coco-muted", "No projects available yet."));
  if (!exclude.childElementCount) exclude.append(el("p", "coco-muted", "No projects available to exclude."));
  scope.body.append(allField, projectsField, exclusions.root);
  const timing = group("When it runs", "Times use your system timezone."), timingGrid = el("div", "coco-rule-grid");
  timingGrid.append(field("Schedule", cadenceKind.el), minuteField, timeField, weekdaysField, dayField, monthField);
  timing.body.append(timingGrid);
  const execution = disclosure("Execution"), executionGrid = el("div", "coco-rule-grid");
  executionGrid.append(field("Model", provider.el), field("Task execution", runMode.el)); execution.body.append(executionGrid);
  const checks = disclosure("Acceptance");
  checks.body.append(field("Review criteria", acceptance, "One per line. Leave empty for CoCo to define criteria before execution."));
  form.append(basics.root, scope.root, timing.root, execution.root, checks.root);
  const nonemptyLines = (value: string): number => value.split("\n").filter(line => line.trim()).length;
  const syncSummaries = (): void => {
    modeHint.textContent = mode.value === "inspection" ? "Find useful follow-ups and create work when needed." : "Carry out this task whenever the rule is triggered.";
    exclusions.meta.textContent = excludedIds.size ? `${excludedIds.size} excluded` : "None";
    const runModeLabel = RUN_MODE_OPTIONS.find(option => option.value === runMode.value)?.label ?? "Agent";
    const modelLabel = provider.value ? (modelLabels.get(provider.value) ?? "Selected model") : "Default model";
    execution.meta.textContent = `${modelLabel} · ${runModeLabel}`;
    const criteria = nonemptyLines(acceptance.value);
    checks.meta.textContent = criteria ? `${criteria} review ${criteria === 1 ? "criterion" : "criteria"}` : "CoCo defines criteria before execution";
  };
  // AppDropdown's `change` does not bubble, so each control also refreshes the
  // summaries directly (native selects reached the form listener instead).
  for (const dropdown of [mode, cadenceKind, provider, runMode]) dropdown.addEventListener("change", syncSummaries);
  form.addEventListener("change", syncSummaries); form.addEventListener("input", syncSummaries);
  syncSummaries();
  syncFields();
  const submit = button("Save rule", () => { form.requestSubmit(); }, true);
  const footer = el("footer", "coco-rule-footer"), actions = el("div", "coco-rule-footer-actions"), status = el("span", "coco-rule-save-status");
  status.setAttribute("role", "status"); status.textContent = "Changes apply when you save.";
  actions.append(button("Cancel", cancel), submit); footer.append(error, status, actions); form.append(footer);
  form.onsubmit = event => {
    event.preventDefault(); error.textContent = ""; status.textContent = "Saving rule…"; submit.disabled = true;
    const kind = cadenceKind.value;
    const cadence = kind === "minute" ? { kind, n: Number(minute.value) } : kind === "hour" ? { kind, minute: Number(minute.value) } : kind === "week" ? { kind, time: time.value, weekdays: [...days].filter(([,box]) => box.checked).map(([index]) => index) } : kind === "month" ? { kind, time: time.value, day: Number(day.value) } : kind === "year" ? { kind, time: time.value, day: Number(day.value), month: Number(month.value) } : { kind: "day", time: time.value };
    const rule: CocoRule = { id: existing?.id ?? crypto.randomUUID(), createdAt: existing?.createdAt ?? Date.now(), nextRunAt: 0, confirmed: true, name: name.value, objective: objective.value, mode: mode.value as CocoRule["mode"], scope: { all: all.checked, workspaceIds: [...selected].filter(([,box]) => box.checked).map(([id]) => id), excludedWorkspaceIds: [...excludedIds] }, enabled: enabled.checked, runMode: runMode.value as CocoRule["runMode"], ...(existing?.reasoningEffort ? { reasoningEffort: existing.reasoningEffort } : {}), fullPermissions: true, providerId: provider.value, cadence: cadence as CocoRule["cadence"], acceptance: acceptance.value.split("\n").map(s => s.trim()).filter(Boolean).map(description => { const prior = existing?.acceptance.find(c => c.description === description); return { id: prior?.id ?? crypto.randomUUID(), kind: "review" as const, description }; }) };
    void saved(rule).catch(e => { error.textContent = String(e); status.textContent = "Changes were not saved."; }).finally(() => { submit.disabled = false; });
  };
  return form;
}
export { describeCadence };
