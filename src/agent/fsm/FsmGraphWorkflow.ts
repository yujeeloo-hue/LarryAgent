import type { TurnHost } from "../turnHost/types.js";
import type { OrchestratorMode } from "../roles/types.js";
import type { RunAgentTurnInput } from "../types.js";
import type { TurnWorkflow, WorkflowRunResult } from "../workflow/types.js";
import { createTurnScope } from "../workflow/turnScope.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import {
  createAskGraphConfig,
  createPlanExecuteV3GraphConfig,
  createReactGraphConfig,
  createReactV2GraphConfig,
  createSubagentGraphConfig,
} from "./configs/sampleGraphs.js";
import { FSMGraph } from "./FSMGraph.js";
import { loadGraphConfig } from "./compatibility/loadGraphConfig.js";
import type { LegacyFSMGraphConfig } from "./compatibility/types.js";
import type { FSMGraphConfig } from "./types.js";

export type FsmGraphWorkflowOptions = {
  mode: OrchestratorMode;
  graphConfig?: FSMGraphConfig | LegacyFSMGraphConfig;
};

export function graphConfigForMode(
  mode: OrchestratorMode | "react_v2",
): FSMGraphConfig {
  if (mode === "react_v2") return createReactV2GraphConfig();
  if (mode === "ask") return createAskGraphConfig();
  if (mode === "plan_execute") return createPlanExecuteV3GraphConfig();
  if (mode === "subagent") return createSubagentGraphConfig();
  return createReactGraphConfig();
}

function iterationsFromContext(turnContext: Record<string, unknown>): number {
  return typeof turnContext.modelIterations === "number"
    ? turnContext.modelIterations
    : 0;
}

function statusFromContext(
  turnContext: Record<string, unknown>,
  fallback: WorkflowRunResult["status"],
): WorkflowRunResult["status"] {
  const status = turnContext.finishedStatus;
  if (
    status === "idle" ||
    status === "error" ||
    status === "cancelled" ||
    status === "completed"
  ) {
    return status;
  }
  return fallback;
}

async function finishUnendedTurn(
  host: TurnHost,
  status: WorkflowRunResult["status"],
  errorMessage: string | undefined,
  modelIterations: number,
): Promise<WorkflowRunResult> {
  if (host.session.status !== "running") {
    return { status, modelIterations };
  }
  const message =
    errorMessage?.trim() ||
    (status === "cancelled" ? "Cancelled" : "FSM graph halted");
  if (status === "error") {
    host.emitError(message);
  }
  return host.finish(
    status,
    message,
    status === "cancelled" ? "cancelled" : status === "error" ? "error" : "completed",
    modelIterations,
  );
}

export class FsmGraphWorkflow implements TurnWorkflow {
  readonly mode: OrchestratorMode;
  private readonly graphConfig: FSMGraphConfig | LegacyFSMGraphConfig | undefined;

  constructor(options: FsmGraphWorkflowOptions) {
    this.mode = options.mode;
    this.graphConfig = options.graphConfig;
  }

  async run(
    host: TurnHost,
    input: RunAgentTurnInput,
  ): Promise<WorkflowRunResult> {
    const rawConfig =
      this.graphConfig ??
      input.fsmGraphConfig ??
      graphConfigForMode(this.mode);
    const { config } = loadGraphConfig(rawConfig);
    const result = await FSMGraph.run(
      config,
      { turnScope: createTurnScope(input) },
      {
        registries: createDefaultActionRegistry(),
        host,
        turnInput: input,
      },
    );

    const halt = result.turnContext.haltResult as WorkflowRunResult | undefined;
    if (halt && typeof halt === "object" && "status" in halt) {
      return halt;
    }

    const modelIterations = iterationsFromContext(result.turnContext);

    if (result.reason === "halt") {
      const aborted = host.signal?.aborted === true;
      return finishUnendedTurn(
        host,
        statusFromContext(result.turnContext, aborted ? "cancelled" : "error"),
        result.errorMessage,
        modelIterations,
      );
    }

    if (result.reason === "error") {
      return finishUnendedTurn(
        host,
        "error",
        result.errorMessage,
        modelIterations,
      );
    }

    return {
      status: statusFromContext(result.turnContext, "idle"),
      modelIterations,
    };
  }
}
