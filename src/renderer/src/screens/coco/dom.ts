export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(text: string, action: () => void, primary = false): HTMLButtonElement {
  const node = el("button", `coco-button${primary ? " primary" : ""}`, text); node.type = "button"; node.onclick = action; return node;
}
export function field(label: string, input: HTMLElement, help?: string): HTMLElement {
  const control = ["INPUT", "TEXTAREA", "SELECT"].includes(input.tagName);
  const node = el(control ? "label" : "div", "coco-field");
  if (!control) { node.setAttribute("role", "group"); node.setAttribute("aria-label", label); }
  node.append(el("span", "", label), input); if (help) node.append(el("small", "", help)); return node;
}
export function input(value: string, type = "text"): HTMLInputElement { const node = el("input"); node.type = type; node.value = value; return node; }
export function section(title: string): HTMLElement { const node = el("section", "coco-section"); node.append(el("h3", "", title)); return node; }
export function modelSelect(selected: string, defaultLabel: string, optionsUpdated?: () => void): HTMLSelectElement {
  const select = el("select"), defaultOption = el("option", "", defaultLabel); defaultOption.value = ""; select.append(defaultOption);
  if (selected) { const current = el("option", "", "Selected model"); current.value = selected; select.append(current); select.value = selected; }
  void window.jellybot?.getWorkspaceSettings().then(settings => {
    const current = select.value;
    select.replaceChildren(defaultOption);
    for (const p of settings.providers) { const option = el("option", "", `${p.name} · ${p.modelId}`); option.value = p.id; select.append(option); }
    if (current && !settings.providers.some(p => p.id === current)) { const missing = el("option", "", "Unavailable model — choose another"); missing.value = current; select.append(missing); }
    select.value = current;
    optionsUpdated?.();
  }).catch(() => { /* Preserve the current choice if model settings are unavailable. */ });
  return select;
}
