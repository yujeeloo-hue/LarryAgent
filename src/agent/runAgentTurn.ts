/**
 * Agent turn entry — thin facade over TurnHost + TurnWorkflow.
 *
 * Control flow lives in `workflow/`; capabilities in `turnHost/`.
 * Session / Transcript are mutated only via Host.
 */

import { registerBuiltins } from "../tools/index.js";
import { createTurnHost } from "./turnHost/createTurnHost.js";
import { createWorkflow } from "./workflow/createWorkflow.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "./types.js";

/**
 * Run one agent turn: persist user → model ↔ tools until idle / cancel / error.
 * Mutates `session` in place. Does not write to disk.
 */
export async function runAgentTurn(
  input: RunAgentTurnInput,
): Promise<RunAgentTurnResult> {
  registerBuiltins();

  const host = createTurnHost({
    ...input,
    runChildTurn: (childInput) => runAgentTurn(childInput),
  });

  try {
    const workflow = createWorkflow(input);
    const result = await workflow.run(host, input);
    if (result.status === "error" && host.session.status !== "error") {
      return host.finish(
        "error",
        "FSM graph error",
        "error",
        result.modelIterations,
      );
    }
    return result;
  } finally {
    host.dispose();
  }
}
