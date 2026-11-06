/** Structured choice UI for work waiting on a user decision. */
export type CocoDecisionPrompt = {
  question: string;
  options: string[];
  allowCustom?: boolean;
  allowMultiple?: boolean;
};

const CUSTOM = true;

/** Prefer an explicit prompt; otherwise derive sensible choices from the waiting reason. */
export function decisionPromptFor(reason: string, existing?: CocoDecisionPrompt | null): CocoDecisionPrompt {
  const question = (existing?.question?.trim() || reason).trim() || "Your decision is needed.";
  const options = (existing?.options ?? []).map(option => option.trim()).filter(Boolean).slice(0, 8);
  if (existing) {
    return {
      question,
      options,
      allowCustom: existing?.allowCustom !== false,
      ...(existing?.allowMultiple ? { allowMultiple: true } : {}),
    };
  }
  const text = reason.trim();
  if (/repair limit|No new progress|uncertain outcome/i.test(text)) {
    return { question, options: ["Try a different approach", "Revise the goal or acceptance criteria", "Cancel this work"], allowCustom: CUSTOM };
  }
  if (/recovery limit|Automatic recovery/i.test(text)) {
    return { question, options: ["Resume from the saved session", "Start a fresh attempt", "Cancel this work"], allowCustom: CUSTOM };
  }
  if (/dependency was cancelled/i.test(text)) {
    return { question, options: ["Continue without that dependency", "Cancel this work"], allowCustom: CUSTOM };
  }
  if (/observed session was paused|removed from CoCo scope/i.test(text)) {
    return { question, options: ["Resume when the session is available", "Detach and continue independently", "Cancel this work"], allowCustom: CUSTOM };
  }
  if (/narrow the project scope|context is too large/i.test(text)) {
    return { question, options: ["Exclude unrelated projects and retry", "Cancel this work"], allowCustom: CUSTOM };
  }
  if (/Approval needed|tool invocation|Approve/i.test(text)) {
    return { question, options: ["Approve and continue", "Decline and stop"], allowCustom: CUSTOM };
  }
  return { question, options: ["Continue as planned", "Pause this work", "Cancel this work"], allowCustom: CUSTOM };
}
