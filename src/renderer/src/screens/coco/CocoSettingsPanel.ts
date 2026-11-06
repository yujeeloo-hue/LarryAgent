import type { CocoSettings, CocoSnapshot } from "../../../../coco/types.js";
import cocoShape from "../../assets/coco/running/band-32.txt?raw";
import { cocoState } from "../../state/cocoState.js";
import { showCocoActivationDialog } from "./CocoActivationDialog.js";
import { el, input, modelSelect } from "./dom.js";
import "../../ui/mono-icon.css";
import "./coco.css";

function settingsField(label: string, control: HTMLInputElement | HTMLSelectElement, help?: string): HTMLElement {
  const node = el("label", "setting-field");
  control.className = "setting-input";
  control.setAttribute("aria-label", label);
  node.append(el("span", "setting-field-label", label), control);
  if (help) node.append(el("span", "setting-field-hint", help));
  return node;
}

function settingsSection(title: string, ...children: HTMLElement[]): HTMLElement {
  const section = el("section", "coco-settings-section");
  section.setAttribute("aria-label", title);
  section.append(...children);
  return section;
}

function fieldPair(...fields: HTMLElement[]): HTMLElement {
  const row = el("div", "setting-field-row setting-field-row-2");
  row.append(...fields);
  return row;
}

/** Slider field for a bounded ratio knob with a live percentage readout. */
function ratioField(label: string, control: HTMLInputElement, help: string): HTMLElement {
  const node = el("label", "setting-field");
  control.className = "setting-input coco-compact-range";
  control.setAttribute("aria-label", label);
  const readout = el("span", "coco-compact-value"), head = el("div", "coco-compact-head");
  const update = (): void => {
    const min = Number(control.min), max = Number(control.max);
    control.style.setProperty("--fill", `${((control.valueAsNumber - min) / (max - min)) * 100}%`);
    readout.textContent = `${Math.round(control.valueAsNumber * 100)}%`;
  };
  control.addEventListener("input", update);
  update();
  head.append(el("span", "setting-field-label", label), readout);
  node.append(head, control, el("span", "setting-field-hint", help));
  return node;
}

export function createCocoSettingsPanel(): HTMLElement {
  const root = el("form", "setting-card coco-settings");
  root.setAttribute("data-app-select", "");
  const header = el("div", "setting-card-header"), icon = el("div", "setting-card-icon");
  const logo = el("span", "app-mono-icon");
  logo.setAttribute("aria-hidden", "true");
  logo.style.width = logo.style.height = "20px";
  const silhouette = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path transform="translate(0 .74)" fill-rule="evenodd" d="${cocoShape.trim()}"/></svg>`;
  logo.style.setProperty("--app-mono-source", `url("data:image/svg+xml,${encodeURIComponent(silhouette)}")`);
  icon.append(logo);
  const titles = el("div", "setting-card-titles");
  titles.append(el("h3", "setting-card-title", "CoCo"));
  header.append(icon, titles);
  const body = el("div", "setting-card-body"), footer = el("div", "setting-card-footer");
  root.append(header, body, footer);
  const publish = (snapshot: CocoSnapshot): void => { cocoState.publish(snapshot); render(snapshot); };
  const render = (snapshot: CocoSnapshot): void => {
    const settings = snapshot.settings;
    const status = el("p", "setting-card-status"); status.hidden = true; status.setAttribute("role", "status");
    const showError = (reason: unknown): void => {
      status.className = "setting-card-status is-error"; status.setAttribute("role", "alert");
      status.textContent = String(reason); status.hidden = false;
    };
    const enabled = input("", "checkbox");
    enabled.className = "setting-toggle"; enabled.checked = settings.enabled;
    enabled.setAttribute("role", "switch"); enabled.setAttribute("aria-label", "Enable CoCo");
    enabled.onchange = () => {
      enabled.checked = settings.enabled;
      if (!settings.enabled) {
        showCocoActivationDialog({ owner: root,
          onEnable: async () => { publish(await window.jellybot!.cocoCommand({ type: "activation", action: "enable" })); },
          onClose: () => root.querySelector<HTMLInputElement>("[role=switch]")?.focus(),
        });
      } else {
        enabled.disabled = true;
        void window.jellybot!.cocoCommand({ type: "settings", settings: { ...settings, enabled: false } })
          .then(publish).catch(showError).finally(() => { enabled.disabled = false; });
      }
    };
    const toggle = el("label", "setting-toggle-row"), toggleCopy = el("span", "setting-toggle-copy");
    toggleCopy.append(el("span", "setting-field-label", "Enable CoCo"), el("span", "setting-field-hint", "Turning off stops chat and automatic work. Goals, rules, and history are kept."));
    toggle.append(toggleCopy, enabled);
    const permissions = el("p", "setting-field-hint coco-settings-note", "Uses Full permissions and your configured tools; existing approvals apply. Fully quitting Larry Agent stops CoCo.");
    const provider = modelSelect(settings.providerId, "Use active model");
    const fastProvider = modelSelect(settings.fastProviderId ?? "", "Same as default model");
    const hourly = input(String(settings.hourlyTokens), "number"), daily = input(String(settings.dailyTokens), "number");
    hourly.min = daily.min = "1"; hourly.required = daily.required = true;
    const report = input(settings.reportTime, "time"); report.required = true;
    const heartbeat = input(String(settings.heartbeatMinutes), "number");
    heartbeat.min = "1"; heartbeat.max = "240"; heartbeat.step = "1"; heartbeat.required = true;
    const resetInstructions = el("button", "setting-btn", "Reset autonomous instructions"); resetInstructions.type = "button";
    resetInstructions.onclick = () => {
      resetInstructions.disabled = true;
      void window.jellybot!.cocoCommand({ type: "autonomousPrompt", action: "reset" }).then(snapshot => {
        publish(snapshot);
        const saved = footer.querySelector<HTMLElement>(".setting-card-status")!;
        saved.classList.add("is-ok"); saved.textContent = "Autonomous instructions reset to default"; saved.hidden = false;
      }).catch(showError).finally(() => { resetInstructions.disabled = false; });
    };
    const instructionsField = el("div", "setting-field");
    instructionsField.append(el("span", "setting-field-label", "Autonomous instructions"), resetInstructions,
      el("span", "setting-field-hint", "CoCo follows COCO_AUTONOMOUS_EXEC_PROMPT.md in its home and may revise it. Reset restores the default."));
    const retention = el("select");
    for (const [days, label] of [[30, "30 days"], [90, "90 days"], [0, "Keep all details"]] as const) {
      const option = el("option", "", label); option.value = String(days); retention.append(option);
    }
    retention.value = String(settings.historyRetentionDays ?? 30);
    const compactToggle = input("", "checkbox");
    compactToggle.className = "setting-toggle";
    compactToggle.checked = settings.compactTriggerRatio !== undefined || settings.iterationProtectTokenRatio !== undefined;
    compactToggle.setAttribute("role", "switch");
    compactToggle.setAttribute("aria-label", "Use independent compaction settings for CoCo Chat");
    const compactTrigger = input("", "range");
    compactTrigger.min = "0.5"; compactTrigger.max = "0.95"; compactTrigger.step = "0.01";
    compactTrigger.value = String(settings.compactTriggerRatio ?? 0.55);
    const compactKeep = input("", "range");
    compactKeep.min = "0.02"; compactKeep.max = "0.9"; compactKeep.step = "0.01";
    compactKeep.value = String(settings.iterationProtectTokenRatio ?? 0.2);
    const syncCompaction = (): void => { compactTrigger.disabled = compactKeep.disabled = !compactToggle.checked; };
    compactToggle.onchange = syncCompaction;
    syncCompaction();
    const compactToggleRow = el("label", "setting-toggle-row"), compactToggleCopy = el("span", "setting-toggle-copy");
    compactToggleCopy.append(el("span", "setting-field-label", "Independent compaction settings"), el("span", "setting-field-hint", "Off: CoCo Chat compaction follows the Agent settings ratios. On: the values below apply to CoCo Chat only."));
    compactToggleRow.append(compactToggleCopy, compactToggle);
    const excludedIds = new Set(settings.excludedWorkspaceIds), projects = el("div", "coco-settings-projects");
    (snapshot.workspaceOptions ?? snapshot.workspaces).forEach(project => {
      const box = input("", "checkbox"); box.checked = excludedIds.has(project.id); box.className = "setting-check";
      box.onchange = () => { if (box.checked) excludedIds.add(project.id); else excludedIds.delete(project.id); };
      const label = el("label", "setting-check-row"); label.append(box, el("span", "", project.name)); projects.append(label);
    });
    if (!projects.childElementCount) projects.append(el("p", "setting-field-hint coco-settings-empty", "No projects available. Added projects will appear here."));
    body.replaceChildren(
      toggle, permissions,
      settingsSection("Models", fieldPair(
        settingsField("Default model", provider),
        settingsField("Decision & verification model", fastProvider, "Used for execution decisions and acceptance checks."),
      )),
      settingsSection("Automatic work", fieldPair(
        settingsField("Tokens per hour", hourly), settingsField("Tokens per day", daily),
      ), el("p", "setting-field-hint coco-settings-note", "Automatic work pauses after the current turn when a limit is reached. Manual chat uses normal limits."),
      settingsField("Daily report time", report),
      settingsField("Heartbeat interval (minutes)", heartbeat, "How often CoCo checks managed projects for new commits and recorded changes (1–240)."),
      instructionsField),
      settingsSection("Context compaction", compactToggleRow, fieldPair(
        ratioField("Compact trigger ratio", compactTrigger, "Compact when the conversation reaches this fraction of the context limit (0.5–0.95)."),
        ratioField("Compact keep ratio", compactKeep, "Newest turns stay verbatim while their protected tokens stay under this fraction of the context limit (2–90%)."),
      ), el("p", "setting-field-hint coco-settings-note", "Applies to CoCo Chat conversations only; execution and background lanes follow the Agent settings. Separate from the History retention setting below.")),
      settingsSection("Excluded projects", el("span", "setting-field-label", "Excluded projects"), el("p", "setting-field-hint coco-settings-note", "Checked projects are excluded from planning, inspection, and automatic work."), projects),
      settingsSection("History", settingsField("Conversation retention", retention, "Older details are summarized before removal. Task links, verification results, and active work are kept.")),
    );
    const save = el("button", "setting-btn setting-btn-primary", "Save changes"); save.type = "submit";
    const actions = el("div", "setting-card-actions"); actions.append(save);
    footer.replaceChildren(status, actions);
    root.onsubmit = event => {
      event.preventDefault(); status.hidden = true; save.disabled = true; save.textContent = "Saving…";
      const { compactTriggerRatio: _trigger, iterationProtectTokenRatio: _keep, ...settingsRest } = settings;
      const updated: CocoSettings = {
        ...settingsRest, providerId: provider.value, fastProviderId: fastProvider.value,
        hourlyTokens: Number(hourly.value), dailyTokens: Number(daily.value), reportTime: report.value, heartbeatMinutes: Number(heartbeat.value),
        excludedWorkspaceIds: [...excludedIds], fullPermissions: true, historyRetentionDays: Number(retention.value),
        ...(compactToggle.checked ? { compactTriggerRatio: compactTrigger.valueAsNumber, iterationProtectTokenRatio: compactKeep.valueAsNumber } : {}),
      };
      void window.jellybot!.cocoCommand({ type: "settings", settings: updated }).then(snapshot => {
        publish(snapshot);
        const saved = footer.querySelector<HTMLElement>(".setting-card-status")!;
        saved.classList.add("is-ok"); saved.textContent = "Settings saved"; saved.hidden = false;
      }).catch(showError).finally(() => { save.disabled = false; save.textContent = "Save changes"; });
    };
  };
  if (!window.jellybot?.cocoSnapshot) body.append(el("p", "coco-error", "CoCo settings require an updated Larry Agent connection"));
  else {
    body.append(el("p", "setting-field-hint", "Loading CoCo settings…"));
    void window.jellybot.cocoSnapshot().then(render).catch(e => body.replaceChildren(el("p", "coco-error", String(e))));
  }
  return root;
}
