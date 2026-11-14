import { icon } from "./icons.js";
import { cardHeaderIcon } from "./cardHeaderIcons.js";
import { bindRowReorder, syncProviderRows } from "./tokenHubReorder.js";
import type {
  DeviceSyncSkill,
  SkillHubController,
  SkillHubDetail,
  SkillHubSnapshot,
  SkillHubSkill,
} from "./SkillHubController.js";
// token-hub.css is imported by main.ts so this module stays DOM-testable
// under node:test (no CSS pipeline there).

type AttrValue = string | boolean | undefined | ((event: Event) => void);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") node.addEventListener(key.replace(/^on/, ""), value as EventListener);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else if (value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === "string") {
      if (child.startsWith("<svg")) {
        const template = document.createElement("template");
        template.innerHTML = child;
        node.append(template.content);
      } else node.append(document.createTextNode(child));
    } else node.append(child);
  }
  return node;
}

function switchControl(checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox", "aria-label": label }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "th-switch" }, input, h("span", { class: "th-switch-track" }));
}

function statusChip(label: string, kind: "ok" | "warn" | "muted"): HTMLElement {
  return h("span", { class: `th-status is-${kind}` }, label);
}

function reportFailure(reason: unknown): void {
  window.alert(reason instanceof Error ? reason.message : String(reason));
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileCountLabel(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Manage view
// ---------------------------------------------------------------------------

export function renderSkillHubView(controller: SkillHubController): HTMLElement {
  const snapshot = controller.getSnapshot();
  if (snapshot.status !== "ready") {
    const text = snapshot.status === "loading"
      ? "Loading encrypted skills…"
      : (snapshot.statusDetail ?? "Encrypted storage is unavailable.");
    return h("div", { class: "token-hub-body is-status" }, h("div", { class: "th-empty-row" }, text));
  }
  if (!snapshot.skills.length) {
    return h("div", { class: "token-hub-body is-status" },
      h("div", { class: "th-empty-row" }, "No skills yet. Add one to manage SKILL.md packages and push them to devices."));
  }
  const selected = snapshot.skills.find((skill) => skill.id === snapshot.selectedSkillId)
    ?? snapshot.skills[0]
    ?? null;
  const orderStatus = h("div", { class: "th-order-status", role: "status", "aria-live": "polite" });
  return h("div", { class: "token-hub-body" },
    h("aside", { class: "th-rail" }, skillList(snapshot, controller, orderStatus), orderStatus),
    selected
      ? skillDetail(selected, controller)
      : h("div", { class: "th-detail th-empty-detail" },
          h("div", { class: "th-empty-row" }, "Select a skill.")));
}

export function captureSkillHubViewPosition(container: HTMLElement): () => void {
  // Three hubs share .th-provider-list on the Manage page — scope to this card.
  const list = container.querySelector<HTMLElement>(".skill-hub-card .th-provider-list");
  const detail = container.querySelector<HTMLElement>(".skill-hub-card .th-detail");
  const railScroll = list?.scrollTop ?? 0;
  const detailScroll = detail?.scrollTop ?? 0;
  const active = document.activeElement as HTMLElement | null;
  const restoreFocus = active && container.contains(active);
  return () => {
    if (list) list.scrollTop = railScroll;
    if (detail) detail.scrollTop = detailScroll;
    if (restoreFocus && active?.isConnected) active.focus({ preventScroll: true });
  };
}

export function syncSkillHubOrder(container: HTMLElement, controller: SkillHubController): void {
  const list = container.querySelector<HTMLElement>(".skill-hub-card .th-provider-list");
  if (!list) return;
  syncProviderRows(list, controller.getSnapshot().skills.map((skill) => skill.id));
}

/** Rebuild ONLY the Manage page's Skill Hub card in place (see repaintMcpHubCard). */
export function repaintSkillHubCard(
  container: HTMLElement,
  buildCard: () => HTMLElement,
): boolean {
  const card = container.querySelector<HTMLElement>(".skill-hub-card");
  if (!card) return false;
  const list = card.querySelector<HTMLElement>(".th-provider-list");
  const railScroll = list?.scrollTop ?? 0;
  const fresh = buildCard();
  card.replaceWith(fresh);
  const freshList = fresh.querySelector<HTMLElement>(".th-provider-list");
  if (freshList) freshList.scrollTop = railScroll;
  return true;
}

/** Rebuild ONLY the device detail's skill card in place (see repaintDeviceMcpCard). */
export function repaintDeviceSkillCard(
  container: HTMLElement,
  buildCard: () => HTMLElement,
): boolean {
  const card = container.querySelector<HTMLElement>(".th-device-card.skill-device-card");
  if (!card) return false;
  const focused = document.activeElement as HTMLElement | null;
  const row = focused?.closest<HTMLElement>(".th-device-profile-row");
  const skillId = row?.dataset.providerId ?? null;
  const action = focused?.dataset.providerAction ?? null;
  const fresh = buildCard();
  card.replaceWith(fresh);
  if (!skillId) return true;
  const next = fresh.querySelector<HTMLElement>(
    `.th-device-profile-row[data-provider-id="${skillId}"]`,
  );
  if (!next) return true; // skill gone (deleted / pulled away) — no stale focus
  const button = action
    ? next.querySelector<HTMLButtonElement>(`[data-provider-action="${action}"]:not(:disabled)`)
    : null;
  (button ?? next).focus({ preventScroll: true });
  return true;
}

function skillList(
  snapshot: SkillHubSnapshot,
  controller: SkillHubController,
  orderStatus: HTMLElement,
): HTMLElement {
  const list = h("ul", { class: "th-provider-list", role: "listbox", "aria-label": "Skills" });
  for (const skill of snapshot.skills) {
    const selected = skill.id === snapshot.selectedSkillId;
    const row = h("li", {
      class: "th-provider-row",
      role: "option",
      "aria-selected": String(selected),
      "data-provider-id": skill.id,
      tabindex: "0",
      title: "Drag the grip to reorder · Alt+↑ / Alt+↓",
    },
      h("span", { class: "th-provider-grip", "aria-hidden": "true" }, icon("gripVertical", 13)),
      h("span", { class: "th-provider-mark", "aria-hidden": "true" }, icon("bookOpen", 14)),
      h("span", { class: "th-provider-copy" },
        h("span", { class: `th-provider-name${skill.enabled ? "" : " mcp-off-row"}`, title: skill.name }, skill.name),
        h("span", { class: "th-provider-meta", title: skill.description }, skill.description)),
      skill.project
      ? h("span", { class: "sk-project-chip", title: "Project scope" }, skill.project)
      : null,
      skill.enabled ? statusChip("On", "ok") : statusChip("Off", "muted"));
    row.addEventListener("click", () => controller.selectSkill(skill.id));
    list.append(row);
  }
  bindRowReorder(list, orderStatus, {
    getIds: () => controller.getSnapshot().skills.map((skill) => skill.id),
    isSaving: () => controller.isSkillOrderSaving(),
    reorder: (ids) => controller.reorderSkills(ids),
  });
  return list;
}

function skillFiles(name: string, files: Array<{ path: string; size: number }> | null): HTMLElement {
  const section = h("section", { class: "th-detail-section", "aria-label": "Skill files" });
  if (!files) {
    section.append(
      h("h3", { class: "th-detail-section-title" }, "Supporting files"),
      h("div", { class: "th-empty-row" }, "Loading skill files…"),
    );
    return section;
  }
  const chips = files.length
    ? h("div", { class: "sk-file-chips" }, ...files.map((file) =>
        h("span", {
          class: "sk-file-chip",
          title: `${file.path} · ${formatBytes(file.size)}`,
        },
          icon("fileText", 13),
          h("span", { class: "sk-file-name" }, file.path),
          h("span", { class: "sk-file-size" }, formatBytes(file.size)))))
    : h("div", { class: "th-empty-row" },
        `${name} ships no supporting files — SKILL.md only.`);
  section.append(
    h("h3", { class: "th-detail-section-title" }, "Supporting files"),
    chips,
    h("span", { class: "th-field-hint" },
      "Read-only here: files live on the device and travel with Copy to Relay."),
  );
  return section;
}

function skillDetail(skill: SkillHubSkill, controller: SkillHubController): HTMLElement {
  const detail = h("div", { class: "th-detail" });
  let bodyDraft: string | null = null;
  let bodyTouched = false;
  let detailRequested = false;

  const paint = () => {
    const snapshot = controller.getSnapshot();
    const current = snapshot.skills.find((item) => item.id === skill.id) ?? skill;
    const loaded: SkillHubDetail | null = controller.getDetail(skill.id);
    if (!bodyTouched) bodyDraft = loaded?.body ?? null;
    if (!loaded && !detailRequested) {
      detailRequested = true;
      void controller.loadDetail(skill.id)
        .then(() => { detailRequested = false; paint(); })
        .catch((err: unknown) => {
          detailRequested = false;
          state.textContent = "Could not load SKILL.md";
          reportFailure(err);
        });
      return;
    }
    const state = h("span", { class: "th-detail-save-state", role: "status", "aria-live": "polite" }, "No changes");
    const nameInput = h("input", {
      class: "th-input th-name-input", type: "text", value: current.name, "aria-label": "Skill name",
      maxlength: "64", autocomplete: "off", spellcheck: "false",
    }) as HTMLInputElement;
    const descriptionInput = h("input", {
      class: "th-input", type: "text", value: current.description, "aria-label": "Skill description",
      maxlength: "1024", autocomplete: "off", spellcheck: "false",
    }) as HTMLInputElement;
    const projectInput = h("input", {
      class: "th-input", type: "text", value: current.project ?? "", "aria-label": "Skill project",
      maxlength: "64", autocomplete: "off", spellcheck: "false",
      placeholder: "universal",
    }) as HTMLInputElement;
    const bodyInput = h("textarea", {
      class: "th-input sk-body-input", rows: "14", "aria-label": "SKILL.md body",
      placeholder: "Instructions the agent reads from SKILL.md.",
      spellcheck: "false",
    }) as HTMLTextAreaElement;
    bodyInput.value = bodyDraft ?? "";
    bodyInput.disabled = bodyDraft === null;
    const enabledSwitch = switchControl(current.enabled, "Skill enabled", (checked) => {
      draft.enabled = checked;
      sync();
    });
    const draft = {
      name: current.name,
      description: current.description,
      enabled: current.enabled,
      project: current.project ?? "",
    };

    nameInput.addEventListener("input", () => { draft.name = nameInput.value; sync(); });
    descriptionInput.addEventListener("input", () => { draft.description = descriptionInput.value; sync(); });
    projectInput.addEventListener("input", () => { draft.project = projectInput.value; sync(); });
    bodyInput.addEventListener("input", () => {
      bodyDraft = bodyInput.value;
      bodyTouched = true;
      sync();
    });

    const save = h("button", { class: "ghost-btn th-detail-save action-primary", type: "button", disabled: true }, "Save changes");
    const cancel = h("button", { class: "ghost-btn th-detail-cancel", type: "button", hidden: true }, "Cancel");
    const removeBtn = h("button", { class: "ghost-btn th-detail-delete action-danger", type: "button" }, icon("trash2", 13), "Delete");

    const dirty = (): boolean =>
      draft.name.trim() !== current.name
      || draft.description.trim() !== current.description
      || draft.project.trim().toLowerCase() !== (current.project ?? "")
      || draft.enabled !== current.enabled
      || (bodyDraft !== null && bodyDraft !== (loaded?.body ?? ""));

    const sync = () => {
      const isDirty = dirty();
      save.disabled = !isDirty;
      cancel.hidden = !isDirty;
      (enabledSwitch.querySelector("input") as HTMLInputElement).disabled = isDirty;
      state.textContent = isDirty ? "Unsaved changes" : "No changes";
    };

    save.addEventListener("click", () => {
      const patch: {
        name?: string;
        description?: string;
        body?: string;
        enabled?: boolean;
        project?: string;
      } = {};
      if (draft.name.trim() !== current.name) patch.name = draft.name.trim();
      if (draft.description.trim() !== current.description) patch.description = draft.description.trim();
      if (draft.project.trim().toLowerCase() !== (current.project ?? "")) {
        patch.project = draft.project.trim();
      }
      if (draft.enabled !== current.enabled) patch.enabled = draft.enabled;
      if (bodyDraft !== null && bodyDraft !== (loaded?.body ?? "")) patch.body = bodyDraft;
      save.disabled = true;
      state.textContent = "Saving…";
      bodyTouched = false;
      bodyDraft = null;
      detailRequested = false;
      void controller.updateSkill(skill.id, patch)
        .then(() => paint())
        .catch((err: unknown) => {
          state.textContent = "Unsaved changes";
          reportFailure(err);
        });
    });
    cancel.addEventListener("click", () => {
      bodyTouched = false;
      bodyDraft = null;
      detailRequested = false;
      paint();
    });
    removeBtn.addEventListener("click", () => confirmDeleteSkill(current, controller));

    detail.replaceChildren(
      h("div", { class: "th-detail-main" },
        h("section", { class: "th-detail-section", "aria-label": "Skill" },
          h("h3", { class: "th-detail-section-title" }, "Skill"),
          h("div", { class: "th-detail-fields" },
            h("label", { class: "th-detail-field" },
              h("span", { class: "th-detail-label" }, "Name"), nameInput,
              h("span", { class: "th-field-hint" }, "Lowercase slug — devices match skills by name.")),
            h("label", { class: "th-detail-field" },
              h("span", { class: "th-detail-label" }, "Description"), descriptionInput,
              h("span", { class: "th-field-hint" }, "Written into SKILL.md frontmatter on save.")),
            h("label", { class: "th-detail-field" },
              h("span", { class: "th-detail-label" }, "Project"), projectInput,
              h("span", { class: "th-field-hint" }, "Blank = universal; otherwise the workspace folder slug.")),
            h("div", { class: "th-detail-capability-row" },
              h("div", {},
                h("div", { class: "th-field-label" }, "Enabled"),
                h("div", { class: "th-field-hint" }, "Pushing a skill carries this switch to the device.")),
              enabledSwitch))),
        h("section", { class: "th-detail-section", "aria-label": "SKILL.md body" },
          h("h3", { class: "th-detail-section-title" }, "SKILL.md body"),
          bodyInput,
          h("span", { class: "th-field-hint" },
            "Markdown instructions. Frontmatter is generated from the fields above.")),
        skillFiles(current.name, loaded?.files ?? null)),
      h("div", { class: "th-detail-actions" }, removeBtn, state, cancel, save),
    );
    sync();
  };

  const unsubscribe = controller.subscribe((change) => {
    if (change === "skill-order") return;
    if (!controller.getSnapshot().skills.some((item) => item.id === skill.id)) {
      unsubscribe();
      return;
    }
    if (bodyTouched) return; // keep an in-progress edit intact
    paint();
  });
  paint();
  return detail;
}

function confirmDeleteSkill(skill: SkillHubSkill, controller: SkillHubController): void {
  const overlay = h("div", { class: "th-overlay" });
  const dialog = h("div", { class: "th-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Delete skill" });
  const close = () => { overlay.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
  const cancel = h("button", { class: "ghost-btn", type: "button", onclick: close }, "Cancel");
  const submit = h("button", {
    class: "ghost-btn action-danger", type: "button",
    onclick: () => { close(); void controller.removeSkill(skill.id).catch(reportFailure); },
  }, "Delete");
  dialog.append(
    h("h2", { class: "th-dialog-title" }, "Delete skill?"),
    h("p", { class: "th-confirm-copy" },
      `Remove “${skill.name}” from the Relay? Devices that already received it keep their local copy and will not be updated.`),
    h("div", { class: "th-dialog-actions" }, cancel, submit));
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  submit.focus();
}

// ---------------------------------------------------------------------------
// Add skill dialog (single step)
// ---------------------------------------------------------------------------

export function openAddSkillDialog(controller: SkillHubController): void {
  const overlay = h("div", { class: "th-overlay" });
  const dialog = h("div", {
    class: "th-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Add skill",
  });
  const finish = () => { overlay.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") finish(); };
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) finish(); });
  window.addEventListener("keydown", onKey, true);

  const nameInput = h("input", {
    class: "th-input", type: "text", "aria-label": "Skill name", placeholder: "release-checklist",
    maxlength: "64", autocomplete: "off", spellcheck: "false",
  }) as HTMLInputElement;
  const descriptionInput = h("input", {
    class: "th-input", type: "text", "aria-label": "Skill description",
    placeholder: "Run the release checklist end to end.", maxlength: "1024",
    autocomplete: "off", spellcheck: "false",
  }) as HTMLInputElement;
  const bodyInput = h("textarea", {
    class: "th-input sk-body-input", rows: "10", "aria-label": "SKILL.md body",
    placeholder: "1. Read docs/DEPLOY.md\n2. Run npm run release\n3. Verify the download site",
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  const enabledSwitch = switchControl(true, "Skill enabled", (checked) => { draft.enabled = checked; });
  const errorRow = h("div", { class: "th-inline-error", role: "alert", hidden: true }, icon("warn", 13), h("span", {}));
  const draft: { name: string; description: string; enabled: boolean } = {
    name: "", description: "", enabled: true,
  };
  nameInput.addEventListener("input", () => { draft.name = nameInput.value; });
  descriptionInput.addEventListener("input", () => { draft.description = descriptionInput.value; });

  const submit = h("button", { class: "ghost-btn action-primary", type: "button" }, "Add skill");
  const cancel = h("button", { class: "ghost-btn", type: "button", onclick: finish }, "Cancel");
  const show = (message: string) => {
    errorRow.hidden = false;
    (errorRow.lastChild as HTMLElement).textContent = message;
  };
  submit.addEventListener("click", () => {
    const name = draft.name.trim().toLowerCase();
    if (!name) { show("Skill name is required."); nameInput.focus(); return; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      show("Use a lowercase slug (letters, numbers, hyphens).");
      nameInput.focus();
      return;
    }
    if (controller.getSnapshot().skills.some((skill) => skill.name.trim().toLowerCase() === name)) {
      show("A skill with this name already exists.");
      nameInput.focus();
      return;
    }
    const description = draft.description.trim();
    if (!description) { show("Skill description is required."); descriptionInput.focus(); return; }
    submit.disabled = true;
    void controller.addSkill({ name, description, body: bodyInput.value, enabled: draft.enabled })
      .then(finish)
      .catch((err: unknown) => {
        submit.disabled = false;
        show(err instanceof Error ? err.message : String(err));
      });
  });

  dialog.append(
    h("div", { class: "th-dialog-head" },
      h("h2", { class: "th-dialog-title" }, "Add Skill"),
      h("button", { class: "th-icon-btn", type: "button", "aria-label": "Close", onclick: finish }, icon("x", 14))),
    h("div", { class: "th-dialog-page" },
      h("div", { class: "th-field" },
        h("span", { class: "th-field-label" }, "Name"), nameInput,
        h("span", { class: "th-field-hint" }, "Lowercase slug — devices match skills by name.")),
      h("div", { class: "th-field" },
        h("span", { class: "th-field-label" }, "Description"), descriptionInput,
        h("span", { class: "th-field-hint" }, "Shown in the rail and written into SKILL.md.")),
      h("div", { class: "th-field" },
        h("span", { class: "th-field-label" }, "Enabled"), enabledSwitch,
        h("span", { class: "th-field-hint" }, "Pushing a skill carries this switch to the device.")),
      h("div", { class: "th-field" },
        h("span", { class: "th-field-label" }, "SKILL.md body"), bodyInput,
        h("span", { class: "th-field-hint" },
          "Supporting files can be added later by copying a skill from a device.")),
      errorRow),
    h("div", { class: "th-dialog-actions" }, cancel, submit));
  overlay.append(dialog);
  document.body.append(overlay);
  nameInput.focus();
}

// ---------------------------------------------------------------------------
// Devices view
// ---------------------------------------------------------------------------

function skillDeviceDialog(title: string, subtitle: string): {
  dialog: HTMLElement; body: HTMLElement; footer: HTMLElement; close: () => void; onClose: (fn: () => void) => void;
} {
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = h("div", { class: "th-overlay th-device-overlay" });
  const dialog = h("div", { class: "th-dialog th-device-dialog", role: "dialog", "aria-modal": "true", "aria-label": title });
  const body = h("div", { class: "th-device-dialog-body" });
  const footer = h("div", { class: "th-device-dialog-footer" });
  let cleanup = () => {};
  const close = () => {
    cleanup();
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    else document.querySelector<HTMLButtonElement>(".th-device-add")?.focus();
  };
  const closeButton = h("button", { class: "th-icon-btn", type: "button", "aria-label": "Close", onclick: close }, icon("x", 14));
  dialog.append(h("div", { class: "th-dialog-head" },
    h("div", {}, h("h2", { class: "th-dialog-title" }, title), h("div", { class: "th-dialog-sub" }, subtitle)),
    closeButton), body, footer);
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.body.append(overlay);
  closeButton.focus();
  return { dialog, body, footer, close, onClose: (fn) => { cleanup = fn; } };
}

function confirmDeviceSkill(opts: {
  title: string; skillName: string; message: string; action: string; danger?: boolean; onConfirm: () => Promise<unknown>;
}): void {
  const modal = skillDeviceDialog(opts.title, opts.skillName);
  modal.dialog.classList.add("th-device-confirm");
  modal.body.append(h("p", { class: "th-device-confirm-copy" }, opts.message));
  const cancel = h("button", { class: "ghost-btn", type: "button", onclick: modal.close }, "Cancel");
  const submit = h("button", {
    class: `ghost-btn th-device-confirm-submit ${opts.danger ? "is-danger action-danger" : "action-primary"}`,
    type: "button",
    onclick: () => { modal.close(); void opts.onConfirm().catch(() => {}); },
  }, opts.action);
  modal.footer.append(cancel, submit);
  cancel.focus();
}

function openSkillDeviceHubDialog(deviceId: string, deviceName: string, controller: SkillHubController): void {
  const modal = skillDeviceDialog("Add from Hub", `To ${deviceName}`);
  const done = h("button", { class: "ghost-btn", type: "button", onclick: modal.close }, "Done");
  modal.footer.append(done);
  const render = () => {
    const activeId = (document.activeElement as HTMLElement | null)?.dataset.hubProviderId;
    const preview = controller.getDeviceSyncPreview(deviceId);
    const pending = controller.getSyncPending(deviceId);
    const error = controller.getSyncError(deviceId);
    const busy = pending !== null;
    modal.body.replaceChildren();
    if (!preview || pending === "preview") {
      modal.body.append(h("div", { class: "th-empty-row", role: "status" },
        pending === "preview" ? "Loading Hub skills…" : error ?? "Loading skills…"));
      if (error && !busy) modal.body.append(h("button", {
        class: "th-link-btn th-device-retry", type: "button",
        onclick: () => { void controller.loadDeviceSyncPreview(deviceId).catch(() => {}); },
      }, "Retry"));
      return;
    }
    if (error) modal.body.append(h("div", { class: "th-inline-error", role: "alert" }, icon("warn", 13), h("span", {}, error)));
    if (!preview.deviceOnline || !preview.supportsSync) {
      modal.body.append(h("div", { class: "th-empty-row" }, preview.deviceOnline
        ? "Update this device to manage skills remotely."
        : "Device offline — adding skills is unavailable."));
      return;
    }
    const rows = h("ul", { class: "th-device-hub-list", "aria-label": "Hub skills" });
    for (const skill of preview.hubSkills) {
      const operation = controller.getDeviceOperation(deviceId, "push", skill.id);
      const replacing = skill.match === "overwrite";
      const label = operation?.status === "pending" ? (replacing ? "Replacing…" : "Adding…")
        : operation?.status === "done" ? (operation.action === "overwrite" ? "Replaced" : "Added")
        : operation?.status === "failed" ? "Failed · Retry" : replacing ? "Replace" : "Add";
      const action = h("button", {
        class: `th-device-hub-action action-primary${operation?.status === "done" ? " is-done" : operation?.status === "failed" ? " is-error" : ""}`,
        type: "button", "data-hub-provider-id": skill.id, "aria-label": `${label}: ${skill.name}`,
        disabled: busy || operation?.status === "done",
        "aria-busy": String(operation?.status === "pending"),
        onclick: () => {
          if (replacing) {
            confirmDeviceSkill({
              title: "Replace skill on device?", skillName: skill.name, action: "Replace",
              message: `This device already has “${skill.name}”. Replace it with the Hub copy? Extra files on the device are removed.`,
              onConfirm: () => controller.pushSkillToDevice(deviceId, skill.id),
            });
          } else void controller.pushSkillToDevice(deviceId, skill.id).catch(() => {});
        },
      }, operation?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
        : operation?.status === "done" ? icon("check", 13) : operation?.status === "failed" ? icon("refresh", 13) : null,
      label);
      rows.append(h("li", { class: "th-device-hub-row" },
        h("span", { class: "th-provider-mark", "aria-hidden": "true" }, icon("bookOpen", 14)),
        skillCopy(skill),
        action));
    }
    if (!preview.hubSkills.length) rows.append(h("li", { class: "th-empty-row" }, "No skills in the Hub yet."));
    modal.body.append(rows);
    if (activeId) {
      const button = [...rows.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.dataset.hubProviderId === activeId);
      if (button && !button.disabled) button.focus(); else done.focus();
    }
  };
  modal.onClose(controller.subscribe(render));
  render();
  void controller.loadDeviceSyncPreview(deviceId).catch(() => {});
}

function skillCopy(skill: { name: string; description?: string; fileCount?: number }): HTMLElement {
  const meta = [skill.description ?? "", typeof skill.fileCount === "number" ? fileCountLabel(skill.fileCount) : ""]
    .filter(Boolean)
    .join(" · ");
  return h("span", { class: "th-profile-copy" },
    h("span", { class: "th-profile-name", title: skill.name }, skill.name),
    h("span", { class: "th-profile-meta", title: meta }, meta));
}

export function buildDeviceSkillCard(
  deviceId: string,
  deviceName: string,
  online: boolean,
  controller: SkillHubController,
): HTMLElement {
  const snapshot = controller.getSnapshot();
  const preview = controller.getDeviceSyncPreview(deviceId);
  const pending = controller.getSyncPending(deviceId);
  const error = controller.getSyncError(deviceId);
  const skills: DeviceSyncSkill[] = preview?.deviceSkills ?? [];
  const busy = pending !== null;
  const available = online && preview?.deviceOnline && preview.supportsSync && snapshot.status === "ready";
  const status = !online ? (skills.length ? "Offline · showing last loaded skills" : "Device offline")
    : pending === "preview" ? "Loading device skills…"
    : !preview ? (error ? "Could not load device skills" : "Loading device skills…")
    : !preview.supportsSync ? "Update this device to manage skills remotely."
    : `${skills.length} skill${skills.length === 1 ? "" : "s"} on this device`;
  const rows = h("ul", { class: "th-device-profiles", "aria-label": `Skills on ${deviceName}` });
  for (const skill of skills) {
    const copying = controller.getDeviceOperation(deviceId, "pull", skill.id);
    const removing = controller.getDeviceOperation(deviceId, "remove", skill.id);
    const label = copying?.status === "pending" ? "Copying…" : copying?.status === "done" ? "Copied"
      : copying?.status === "failed" ? "Failed · Retry" : "Copy to Relay";
    const copyButton = h("button", {
      class: `ghost-btn th-device-copy${copying?.status === "done" ? " is-done" : copying?.status === "failed" ? " is-error" : ""}`,
      type: "button", "data-provider-action": "copy", "aria-label": `${label}: ${skill.name}`,
      disabled: !available || busy || copying?.status === "done",
      "aria-busy": String(copying?.status === "pending"),
      onclick: () => {
        if (skill.match === "overwrite") confirmDeviceSkill({
          title: "Replace skill in Relay?", skillName: skill.name, action: "Replace",
          message: `A skill with this name already exists in the Hub. Replace it with the copy from ${deviceName}?`,
          onConfirm: () => controller.pullSkillFromDevice(deviceId, skill.id),
        });
        else void controller.pullSkillFromDevice(deviceId, skill.id).catch(() => {});
      },
    }, copying?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
      : icon(copying?.status === "done" ? "check" : copying?.status === "failed" ? "refresh" : "copy", 13), label);
    const removeButton = h("button", {
      class: "th-icon-btn th-device-delete action-danger action-danger-list", type: "button", "data-provider-action": "delete",
      "aria-busy": String(removing?.status === "pending"),
      "aria-label": `Delete ${skill.name} from ${deviceName}`,
      title: removing?.error ?? "Delete from this device",
      disabled: !available || busy,
      onclick: () => confirmDeviceSkill({
        title: "Delete skill?", skillName: skill.name, action: "Delete", danger: true,
        message: `Remove this skill from ${deviceName}? The agent can no longer load it on this device.`,
        onConfirm: () => controller.removeSkillFromDevice(deviceId, skill.id),
      }),
    }, removing?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
      : icon(removing?.status === "failed" ? "refresh" : "trash2", 13));
    rows.append(h("li", { class: "th-device-profile-row", "data-provider-id": skill.id },
      h("span", { class: "th-provider-mark", "aria-hidden": "true" }, icon("bookOpen", 14)),
      h("span", { class: "th-profile-copy" },
        h("span", { class: "th-profile-name", title: skill.name }, skill.name),
        h("span", { class: "th-profile-meta", title: skill.description }, skill.description),
        h("span", { class: "sk-profile-size" }, fileCountLabel(skill.fileCount))),
      h("div", { class: "th-device-row-actions" }, copyButton, removeButton)));
  }
  if (!skills.length) {
    rows.append(h("li", { class: "th-empty-row" },
      !online ? "Connect this device to load its skills."
        : preview?.supportsSync ? "This device has no skills yet." : status));
  }
  const body = h("div", { class: "card-body flush" }, rows,
    h("span", { class: "th-device-live", role: "status", "aria-live": "polite", "aria-atomic": "true" }, controller.getSyncAnnouncement(deviceId)));
  if (error || snapshot.status === "unavailable") {
    body.append(h("div", { class: "th-inline-error th-device-sync-error", role: "alert" }, icon("warn", 13),
      h("span", {}, error ?? snapshot.statusDetail ?? "Encrypted storage is unavailable."),
      ...(online && !busy ? [h("button", { class: "th-link-btn", type: "button", onclick: () => {
        void controller.loadDeviceSyncPreview(deviceId).catch(() => {});
      } }, "Retry")] : [])));
  }
  return h("div", { class: "card th-device-card skill-device-card", "data-device-id": deviceId },
    h("div", { class: "card-head" },
      h("span", { class: "ic card-header-symbol" }, cardHeaderIcon("skills")),
      h("div", { class: "th-device-heading" }, h("div", { class: "t" }, "Skills"), h("div", { class: "d", role: "status" }, status)),
      h("div", { class: "card-actions" }, h("button", {
        class: "ghost-btn th-device-add action-primary", type: "button", disabled: !available || busy,
        onclick: () => openSkillDeviceHubDialog(deviceId, deviceName, controller),
      }, icon("plus", 13), "Add from Hub"))), body);
}
