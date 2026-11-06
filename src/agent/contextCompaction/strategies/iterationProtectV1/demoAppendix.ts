import { basename } from "node:path";
import type { Message, TextPart } from "../../../../session/types.js";
import { parseDemoConfirmToolCallId } from "../../../../session/demoConfirm.js";

export const DEMO_VERBATIM_APPENDIX_HEADER = "Demo decisions (verbatim):";
export const MAX_DEMO_VERBATIM_ENTRIES = 20;

type DemoRef = { title: string; path: string };

function userText(message: Message): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** present_demo tool calls → toolCallId → title (args title or basename). */
function collectPresentDemoRefs(messages: Message[]): Map<string, DemoRef> {
  const refs = new Map<string, DemoRef>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool_call" || part.name !== "present_demo") continue;
      const path =
        typeof part.arguments.path === "string"
          ? part.arguments.path.trim()
          : "";
      const title =
        typeof part.arguments.title === "string" && part.arguments.title.trim()
          ? part.arguments.title.trim()
          : basename(path) || part.id;
      refs.set(part.id, { title, path });
    }
  }
  return refs;
}

/**
 * Deterministically rebuild the verbatim demo-decisions appendix from the
 * full transcript (plan §7): one entry per present_demo confirmation —
 * latest confirmation per toolCallId, newest MAX_DEMO_VERBATIM_ENTRIES kept
 * (FIFO). Never relies on LLM summary fidelity. Returns null when the
 * transcript holds no confirmed demos.
 */
export function buildDemoVerbatimAppendix(messages: Message[]): string | null {
  const refs = collectPresentDemoRefs(messages);
  type Entry = { toolCallId: string; ref: DemoRef; text: string; order: number };
  const latest = new Map<string, Entry>();
  let order = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = userText(message);
    const toolCallId = parseDemoConfirmToolCallId(text);
    if (!toolCallId) continue;
    const ref = refs.get(toolCallId) ?? { title: toolCallId, path: "" };
    latest.set(toolCallId, { toolCallId, ref, text, order: order++ });
  }
  if (latest.size === 0) return null;

  const kept = [...latest.values()]
    .sort((a, b) => a.order - b.order)
    .slice(-MAX_DEMO_VERBATIM_ENTRIES);

  const sections = kept.map((entry) => {
    const head = entry.ref.path
      ? `## ${entry.ref.title} — ${entry.ref.path}`
      : `## ${entry.ref.title}`;
    return `${head}\n${entry.text}`;
  });
  return `${DEMO_VERBATIM_APPENDIX_HEADER}\n\n${sections.join("\n\n")}`;
}
