/**
 * Compact summary card for a present_demo confirm message (plan §4): the D7
 * marker text never renders as raw prose — check glyph + "Demo confirmed ·
 * N params" + one-line value summary, expandable to the full key/value list
 * (+ note). No JSON source text anywhere in the bubble.
 */
import { ChevronDown, CircleCheck } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import type { DemoConfirmMessage } from "../../../../../session/demoConfirm.js";

function parseEntries(paramsJson: string): Array<[string, string]> {
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

export function createDemoConfirmCard(input: DemoConfirmMessage): HTMLElement {
  const entries = parseEntries(input.paramsJson);
  const card = document.createElement("details");
  card.className = "content-card-demo-confirm";
  card.dataset.demoToolCallId = input.toolCallId;

  const head = document.createElement("summary");
  head.className = "content-card-demo-confirm-head";

  const icon = createLucideIcon(CircleCheck, { size: 14 });
  icon.classList.add("content-card-demo-confirm-icon");

  const title = document.createElement("span");
  title.className = "content-card-demo-confirm-title";
  title.textContent =
    entries.length > 0
      ? `Demo confirmed · ${entries.length} params`
      : "Demo confirmed";

  head.append(icon, title);

  if (entries.length > 0) {
    const brief = document.createElement("span");
    brief.className = "content-card-demo-confirm-brief";
    brief.textContent = entries.map(([k, v]) => `${k}=${v}`).join(", ");
    brief.title = brief.textContent;
    head.append(brief);

    const chevron = createLucideIcon(ChevronDown, { size: 13 });
    chevron.classList.add("content-card-demo-confirm-chevron");
    head.append(chevron);
  }

  card.append(head);

  if (entries.length > 0 || input.note) {
    card.classList.add("is-expandable");
    const body = document.createElement("div");
    body.className = "content-card-demo-confirm-body";
    for (const [key, value] of entries) {
      const row = document.createElement("div");
      row.className = "content-card-demo-confirm-row";
      const k = document.createElement("span");
      k.className = "content-card-demo-confirm-key";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "content-card-demo-confirm-value";
      v.textContent = value;
      row.append(k, v);
      body.append(row);
    }
    if (input.note) {
      const note = document.createElement("p");
      note.className = "content-card-demo-confirm-note";
      note.textContent = `Note: ${input.note}`;
      body.append(note);
    }
    card.append(body);
  }

  return card;
}
