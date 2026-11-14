export type VerifyDecision = {
  action: "complete" | "continue" | "needs_user";
  prompt?: string;
  question?: string;
  reason: string;
};

/** Accept a verifier judgment. An uncertain external effect cannot be advanced automatically. */
export function verifyDecision(result: unknown, uncertainEffects = false): VerifyDecision {
  const value = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
  const action = value.action;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (action !== "complete" && action !== "continue" && action !== "needs_user") throw new Error("Verifier did not return a completion decision");
  if (!reason) throw new Error("Verifier did not explain its decision");
  const prompt = typeof value.prompt === "string" ? value.prompt.trim().slice(0, 2000) : "";
  const question = (typeof value.question === "string" ? value.question.trim() : "") || reason;
  if (action === "continue" && !prompt) throw new Error("Verifier did not provide the next instruction");
  if (uncertainEffects && action === "continue") {
    return { action: "needs_user", question: "An external operation may already have taken effect. Decide whether to continue.", reason: reason.slice(0, 4000) };
  }
  return {
    action,
    reason: reason.slice(0, 4000),
    ...(action === "continue" ? { prompt } : {}),
    ...(action === "needs_user" ? { question: question.slice(0, 4000) } : {}),
  };
}
