
import { registerBuiltins } from "../tools/index.js";
import { createTurnHost } from "./turnHost/createTurnHost.js";
import { createWorkflow } from "./workflow/createWorkflow.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "./types.js";

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
