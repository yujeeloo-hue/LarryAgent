export type UserAskOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

export type UserAskAnswer = {
  selected: string;
  selections?: string[];
  custom: boolean;
  comment?: string;
};

export type UserAskResult = {
  selected_options: string[];
  custom_answer: string | null;
  comment: string | null;
};

export function normalizeAskOptions(raw: unknown): UserAskOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const options: UserAskOption[] = [];
  for (const item of raw) {
    const source = typeof item === "string" ? { label: item } : item;
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const label = typeof source.label === "string" ? source.label.trim() : "";
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const description = typeof source.description === "string" ? source.description.trim() : "";
    options.push({ label, ...(description ? { description } : {}), ...(source.recommended === true ? { recommended: true } : {}) });
  }
  return options;
}

export function askAnswerResult(answer: UserAskAnswer, openEnded = false): UserAskResult {
  const free = openEnded || answer.custom;
  const selected = answer.selections?.map(s => s.trim()).filter(Boolean);
  return {
    selected_options: free ? [] : selected?.length ? selected : [answer.selected.trim()],
    custom_answer: free ? answer.selected.trim() : null,
    comment: free ? null : answer.comment?.trim() || null,
  };
}

export function formatAskAnswerText(answer: UserAskAnswer, openEnded = false): string {
  return JSON.stringify(askAnswerResult(answer, openEnded));
}

export function parseAskAnswerResult(text: string): UserAskResult | null {
  try {
    const value = JSON.parse(text) as UserAskResult;
    if (!value || !Array.isArray(value.selected_options) ||
      !value.selected_options.every(s => typeof s === "string") ||
      !(value.custom_answer === null || typeof value.custom_answer === "string") ||
      !(value.comment === null || typeof value.comment === "string")) return null;
    return value;
  } catch { return null; }
}
export type HandoffPasswordDestination = {
  app: string;
  origin?: string;
  login?: { accounts: string[]; account?: string };
};

export type HandoffPasswordSubmission =
  | { kind: "manual"; password: string; rememberAccount?: string }
  | { kind: "saved"; account: string };

export type HandoffPasswordStatus = "filled" | "filled_not_saved" | "unavailable" | "expired" | "busy";

export function isComputerHandoffCard(name: string, waiting: boolean, result: string): boolean {
  if (name === "computer_handoff") return true;
  if (name !== "computer_mouse" && name !== "computer_keyboard" && name !== "computer_ui") return false;
  return waiting ||
    result.startsWith("Not performed: the user was using the mouse, so computer use paused") ||
    result.startsWith("The user took over the mouse and chose Stop task.");
}
