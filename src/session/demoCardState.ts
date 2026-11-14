/** Shared, conversation-owned form/submission state for both demo surfaces. */
import { parseDemoConfirmToolCallId } from "./demoConfirm.js";

export type DemoCardValues = Record<string, string | number | boolean | null>;
export type DemoSubmitReceipt = { enqueued: boolean };
export type DemoSubmitHandler = (
  values: DemoCardValues,
  note?: string,
) => void | Promise<void | DemoSubmitReceipt>;
export type DemoSettled = { paramsJson: string; note?: string; enqueued?: boolean };
export type DemoCardState = {
  values: DemoCardValues;
  note: string;
  status?: "submitting" | "submitted" | "queued";
  error?: string;
  submittedJson?: string;
  pending?: Promise<void>;
  /** A transcript/queue snapshot has caught up with the local receipt. */
  settledSeen?: boolean;
};

/** Ordinary queue edits must not rebuild the conversation's demo cards. */
export function demoQueueFingerprint(texts: readonly string[]): string {
  return JSON.stringify(texts.filter((text) => typeof text === "string" && parseDemoConfirmToolCallId(text)));
}

/** Persist drafts across whole-card rebuilds, while queue removal unlocks them. */
export function demoCardStateFor(
  states: Map<string, DemoCardState> | undefined,
  toolCallId: string,
  settled: DemoSettled | null,
): DemoCardState {
  let state = states?.get(toolCallId);
  if (!state) {
    state = { values: {}, note: "" };
    states?.set(toolCallId, state);
  }
  // A stale render immediately after acknowledgement may still lack the
  // marker. Keep its lock until a snapshot first observes the decision.
  if (!settled && state.settledSeen && !state.pending && state.status !== "submitting") {
    delete state.status;
    delete state.submittedJson;
    delete state.settledSeen;
  }
  restoreDemoDecision(state, settled);
  return state;
}

/** Reopened previews and disabled controls must show the accepted decision. */
export function restoreDemoDecision(state: DemoCardState, settled: DemoSettled | null): void {
  if (!settled) return;
  try {
    const values: unknown = JSON.parse(settled.paramsJson);
    if (values && typeof values === "object" && !Array.isArray(values)) {
      const restored: DemoCardValues = {};
      for (const [name, value] of Object.entries(values)) {
        if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
          Object.defineProperty(restored, name, { value, enumerable: true, writable: true, configurable: true });
        }
      }
      state.values = restored;
    }
  } catch { /* Legacy malformed payload: retain the usable draft. */ }
  state.note = settled.note ?? "";
  state.status = settled.enqueued ? "queued" : "submitted";
  state.submittedJson = settled.paramsJson;
  state.settledSeen = true;
  delete state.error;
}

/** Lock before invoking transport, and settle only after its acknowledgement. */
export function submitDemoDecision(
  state: DemoCardState,
  values: DemoCardValues,
  note: string | undefined,
  submit: DemoSubmitHandler,
): Promise<void> | undefined {
  if (state.status) return state.pending;
  state.status = "submitting";
  delete state.error;
  const accepted = (receipt: void | DemoSubmitReceipt): void => {
    state.status = receipt?.enqueued ? "queued" : "submitted";
    state.submittedJson = JSON.stringify(values);
    delete state.pending;
  };
  const rejected = (error: unknown): void => {
    delete state.status;
    delete state.pending;
    state.error = error instanceof Error ? error.message : String(error);
  };
  try {
    const result = submit(values, note);
    if (result && typeof result.then === "function") {
      state.pending = result.then(accepted, rejected);
      return state.pending;
    }
    accepted(undefined);
  } catch (error) {
    rejected(error);
  }
  return undefined;
}
