/**
 * `fsm_graph_edit` — one structural mutation per call.
 * Delegates to FsmGraphLibraryPort.applyGraphEdit (fsm-side validate).
 */

import type {
  FsmGraphEditInputLike,
  FsmGraphEditResultLike,
  FsmGraphLibraryPort,
} from "./fsmGraphTool.js";

export type FsmGraphEditToolInput = FsmGraphEditInputLike;

export type FsmGraphEditToolResult = FsmGraphEditResultLike & {
  note?: string;
};

export async function runFsmGraphEditTool(
  input: FsmGraphEditToolInput,
  deps: Pick<FsmGraphLibraryPort, "applyGraphEdit">,
): Promise<FsmGraphEditToolResult> {
  const result = await deps.applyGraphEdit(input);
  if (!result.ok) return result;
  return {
    ...result,
    note: "graph updated (still disabled if origin llm until the user enables it)",
  };
}
