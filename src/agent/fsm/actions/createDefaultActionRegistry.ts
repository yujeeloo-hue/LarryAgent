import { FSMRegistry } from "../FSMRegistry.js";
import { NodeActionSyncPlanStep, NodeActionSyncPlanStepSchema } from "./NodeActionSyncPlanStep.js";
import {
  NodeActionCommitStep,
  NodeActionCommitStepSchema,
} from "./NodeActionCommitStep.js";
import {
  NodeActionAwaitSubagents,
  NodeActionAwaitSubagentsSchema,
} from "./NodeActionAwaitSubagents.js";
import {
  NodeActionNotifyTaskDone,
  NodeActionNotifyTaskDoneSchema,
} from "./NodeActionNotifyTaskDone.js";
import {
  NodeActionWhenToolCall,
  NodeActionWhenToolCallSchema,
} from "./NodeActionWhenToolCall.js";
import {
  NodeActionSetComposerRunMode,
  NodeActionSetComposerRunModeSchema,
} from "./NodeActionSetComposerRunMode.js";
import {
  NodeActionDetectStepClaim,
  NodeActionDetectStepClaimSchema,
} from "./NodeActionDetectStepClaim.js";
import {
  NodeActionFillEmptyAssistant,
  NodeActionFillEmptyAssistantSchema,
} from "./NodeActionFillEmptyAssistant.js";
import {
  NodeActionFinishIdle,
  NodeActionFinishIdleSchema,
} from "./NodeActionFinishIdle.js";
import {
  NodeActionRoundGate,
  NodeActionRoundGateSchema,
} from "./NodeActionRoundGate.js";
import {
  NodeActionRouteTo,
  NodeActionRouteToSchema,
  validateNodeActionRouteToParams,
} from "./NodeActionRouteTo.js";
import {
  NodeActionBuildModelWindow,
  NodeActionBuildModelWindowSchema,
} from "./NodeActionBuildModelWindow.js";
import {
  NodeActionDisableTools,
  NodeActionDisableToolsSchema,
} from "./NodeActionDisableTools.js";
import {
  NodeActionPrepareTools,
  NodeActionPrepareToolsSchema,
} from "./NodeActionPrepareTools.js";
import {
  NodeActionPrepareRole,
  NodeActionPrepareRoleSchema,
} from "./NodeActionPrepareRole.js";
import {
  NodeActionPromptInject,
  NodeActionPromptInjectSchema,
} from "./NodeActionPromptInject.js";
import {
  NodeActionRunTools,
  NodeActionRunToolsSchema,
} from "./NodeActionRunTools.js";
import {
  NodeActionApplyToolEffects,
  NodeActionApplyToolEffectsSchema,
} from "./NodeActionApplyToolEffects.js";
import {
  NodeActionEmitRouteEvent,
  NodeActionEmitRouteEventSchema,
} from "./NodeActionEmitRouteEvent.js";
import {
  NodeActionCheckPlan,
  NodeActionCheckPlanSchema,
} from "./NodeActionCheckPlan.js";
import { NodeActionSyncPlanDoc, NodeActionSyncPlanDocSchema } from "./NodeActionSyncPlanDoc.js";
import {
  NodeActionSetPlanCard,
  NodeActionSetPlanCardSchema,
} from "./NodeActionSetPlanCard.js";
import {
  NodeActionCompleteActivePlan,
  NodeActionCompleteActivePlanSchema,
} from "./NodeActionCompleteActivePlan.js";
import {
  NodeActionClearPlanDraft,
  NodeActionClearPlanDraftSchema,
} from "./NodeActionClearPlanDraft.js";
import {
  NodeActionSetPlanApprovalPending,
  NodeActionSetPlanApprovalPendingSchema,
} from "./NodeActionSetPlanApprovalPending.js";
import {
  NodeActionApplyControlIntent,
  NodeActionApplyControlIntentSchema,
} from "./NodeActionApplyControlIntent.js";
import {
  NodeActionValidateCommitStep,
  NodeActionValidateCommitStepSchema,
  describeNodeActionValidateCommitStepChildren,
} from "./NodeActionValidateCommitStep.js";
import {
  NodeActionStartTurn,
  NodeActionStartTurnSchema,
} from "./NodeActionStartTurn.js";
import {
  NodeActionCallModel,
  NodeActionCallModelSchema,
} from "./NodeActionCallModel.js";
import {
  NodeActionVerifyStep,
  NodeActionVerifyStepSchema,
} from "./NodeActionVerifyStep.js";
import {
  NodeActionRunShell,
  NodeActionRunShellSchema,
  validateNodeActionRunShellParams,
} from "./NodeActionRunShell.js";
import {
  NodeActionWriteBlackboard,
  NodeActionWriteBlackboardSchema,
  validateNodeActionWriteBlackboardParams,
} from "./NodeActionWriteBlackboard.js";
import {
  NodeActionReadBlackboard,
  NodeActionReadBlackboardSchema,
  validateNodeActionReadBlackboardParams,
} from "./NodeActionReadBlackboard.js";
import {
  NodeActionCompare,
  NodeActionCompareSchema,
  validateNodeActionCompareParams,
} from "./NodeActionCompare.js";
import {
  NodeActionEmitRouteEventWhen,
  NodeActionEmitRouteEventWhenSchema,
  validateNodeActionEmitRouteEventWhenParams,
} from "./NodeActionEmitRouteEventWhen.js";
import {
  NodeActionRoleRoundBuilder,
  NodeActionRoleRoundBuilderSchema,
  describeNodeActionRoleRoundBuilderChildren,
} from "./NodeActionRoleRoundBuilder.js";
import {
  NodeActionEdgPlanSchema,
  NodeActionEdgPlanSchemaSchema,
} from "./NodeActionEdgPlanSchema.js";
import {
  NodeActionEdgAdmit,
  NodeActionEdgAdmitSchema,
} from "./NodeActionEdgAdmit.js";
import {
  NodeActionEdgDispatch,
  NodeActionEdgDispatchSchema,
} from "./NodeActionEdgDispatch.js";

/**
 * Default action catalog for builtin graphs and the graph editor.
 * Fine-grained role-round Actions remain first-class; RoleRoundBuilder is
 * an optional composite for custom graphs.
 */
export function createDefaultActionRegistry(): FSMRegistry {
  return FSMRegistry.createDefault()
    .registerAction({
      type: "NodeActionSyncPlanStep",
      paramsSchema: NodeActionSyncPlanStepSchema,
      create: (p) => new NodeActionSyncPlanStep(p),
    })
    .registerAction({
      type: "NodeActionStartTurn",
      paramsSchema: NodeActionStartTurnSchema,
      create: (p) => new NodeActionStartTurn(p),
    })
    .registerAction({
      type: "NodeActionRoundGate",
      paramsSchema: NodeActionRoundGateSchema,
      create: (p) => new NodeActionRoundGate(p),
    })
    .registerAction({
      type: "NodeActionRouteTo",
      paramsSchema: NodeActionRouteToSchema,
      validate: validateNodeActionRouteToParams,
      create: (p) => new NodeActionRouteTo(p),
    })
    .registerAction({
      type: "NodeActionFillEmptyAssistant",
      paramsSchema: NodeActionFillEmptyAssistantSchema,
      create: (p) => new NodeActionFillEmptyAssistant(p),
    })
    .registerAction({
      type: "NodeActionFinishIdle",
      paramsSchema: NodeActionFinishIdleSchema,
      create: (p) => new NodeActionFinishIdle(p),
    })
    .registerAction({
      type: "NodeActionPrepareRole",
      paramsSchema: NodeActionPrepareRoleSchema,
      create: (p) => new NodeActionPrepareRole(p),
    })
    .registerAction({
      type: "NodeActionPromptInject",
      paramsSchema: NodeActionPromptInjectSchema,
      create: (p) => new NodeActionPromptInject(p),
    })
    .registerAction({
      type: "NodeActionBuildModelWindow",
      paramsSchema: NodeActionBuildModelWindowSchema,
      create: (p) => new NodeActionBuildModelWindow(p),
    })
    .registerAction({
      type: "NodeActionPrepareTools",
      paramsSchema: NodeActionPrepareToolsSchema,
      create: (p) => new NodeActionPrepareTools(p),
    })
    .registerAction({
      type: "NodeActionDisableTools",
      paramsSchema: NodeActionDisableToolsSchema,
      create: (p) => new NodeActionDisableTools(p),
    })
    .registerAction({
      type: "NodeActionCallModel",
      paramsSchema: NodeActionCallModelSchema,
      create: (p) => new NodeActionCallModel(p),
    })
    .registerAction({
      type: "NodeActionRunTools",
      paramsSchema: NodeActionRunToolsSchema,
      create: (p) => new NodeActionRunTools(p),
    })
    .registerAction({
      type: "NodeActionApplyToolEffects",
      paramsSchema: NodeActionApplyToolEffectsSchema,
      create: (p) => new NodeActionApplyToolEffects(p),
    })
    .registerAction({
      type: "NodeActionEmitRouteEvent",
      paramsSchema: NodeActionEmitRouteEventSchema,
      create: (p) => new NodeActionEmitRouteEvent(p),
    })
    .registerAction({
      type: "NodeActionCheckPlan",
      paramsSchema: NodeActionCheckPlanSchema,
      create: (p) => new NodeActionCheckPlan(p),
    })
    .registerAction({
      type: "NodeActionSyncPlanDoc",
      paramsSchema: NodeActionSyncPlanDocSchema,
      create: (p) => new NodeActionSyncPlanDoc(p),
    })
    .registerAction({
      type: "NodeActionSetPlanCard",
      paramsSchema: NodeActionSetPlanCardSchema,
      create: (p) => new NodeActionSetPlanCard(p),
    })
    .registerAction({
      type: "NodeActionCompleteActivePlan",
      paramsSchema: NodeActionCompleteActivePlanSchema,
      create: (p) => new NodeActionCompleteActivePlan(p),
    })
    .registerAction({
      type: "NodeActionClearPlanDraft",
      paramsSchema: NodeActionClearPlanDraftSchema,
      create: (p) => new NodeActionClearPlanDraft(p),
    })
    .registerAction({
      type: "NodeActionSetPlanApprovalPending",
      paramsSchema: NodeActionSetPlanApprovalPendingSchema,
      create: (p) => new NodeActionSetPlanApprovalPending(p),
    })
    .registerAction({
      type: "NodeActionApplyControlIntent",
      paramsSchema: NodeActionApplyControlIntentSchema,
      create: (p) => new NodeActionApplyControlIntent(p),
    })
    .registerAction({
      type: "NodeActionAwaitSubagents",
      paramsSchema: NodeActionAwaitSubagentsSchema,
      create: (p) => new NodeActionAwaitSubagents(p),
    })
    .registerAction({
      type: "NodeActionDetectStepClaim",
      paramsSchema: NodeActionDetectStepClaimSchema,
      create: (p) => new NodeActionDetectStepClaim(p),
    })
    .registerAction({
      type: "NodeActionVerifyStep",
      paramsSchema: NodeActionVerifyStepSchema,
      create: (p) => new NodeActionVerifyStep(p),
    })
    .registerAction({
      type: "NodeActionCommitStep",
      paramsSchema: NodeActionCommitStepSchema,
      create: (p) => new NodeActionCommitStep(p),
    })
    .registerAction({
      type: "NodeActionValidateCommitStep",
      paramsSchema: NodeActionValidateCommitStepSchema,
      describeChildren: describeNodeActionValidateCommitStepChildren,
      create: (p, { children }) => new NodeActionValidateCommitStep(p, children),
    })
    .registerAction({
      type: "NodeActionNotifyTaskDone",
      paramsSchema: NodeActionNotifyTaskDoneSchema,
      create: (p) => new NodeActionNotifyTaskDone(p),
    })
    .registerAction({
      type: "NodeActionWhenToolCall",
      paramsSchema: NodeActionWhenToolCallSchema,
      create: (p) => new NodeActionWhenToolCall(p),
    })
    .registerAction({
      type: "NodeActionSetComposerRunMode",
      paramsSchema: NodeActionSetComposerRunModeSchema,
      create: (p) => new NodeActionSetComposerRunMode(p),
    })
    .registerAction({
      type: "NodeActionRunShell",
      paramsSchema: NodeActionRunShellSchema,
      validate: validateNodeActionRunShellParams,
      create: (p) => new NodeActionRunShell(p),
    })
    .registerAction({
      type: "NodeActionWriteBlackboard",
      paramsSchema: NodeActionWriteBlackboardSchema,
      validate: validateNodeActionWriteBlackboardParams,
      create: (p) => new NodeActionWriteBlackboard(p),
    })
    .registerAction({
      type: "NodeActionReadBlackboard",
      paramsSchema: NodeActionReadBlackboardSchema,
      validate: validateNodeActionReadBlackboardParams,
      create: (p) => new NodeActionReadBlackboard(p),
    })
    .registerAction({
      type: "NodeActionCompare",
      paramsSchema: NodeActionCompareSchema,
      validate: validateNodeActionCompareParams,
      create: (p) => new NodeActionCompare(p),
    })
    .registerAction({
      type: "NodeActionRoleRoundBuilder",
      paramsSchema: NodeActionRoleRoundBuilderSchema,
      describeChildren: describeNodeActionRoleRoundBuilderChildren,
      create: (p, { children }) => new NodeActionRoleRoundBuilder(p, children),
    })
    .registerAction({
      type: "NodeActionEmitRouteEventWhen",
      paramsSchema: NodeActionEmitRouteEventWhenSchema,
      validate: validateNodeActionEmitRouteEventWhenParams,
      create: (p) => new NodeActionEmitRouteEventWhen(p),
    })
    .registerAction({
      type: "NodeActionEdgPlanSchema",
      paramsSchema: NodeActionEdgPlanSchemaSchema,
      create: (p) => new NodeActionEdgPlanSchema(p),
    })
    .registerAction({
      type: "NodeActionEdgAdmit",
      paramsSchema: NodeActionEdgAdmitSchema,
      create: (p) => new NodeActionEdgAdmit(p),
    })
    .registerAction({
      type: "NodeActionEdgDispatch",
      paramsSchema: NodeActionEdgDispatchSchema,
      create: (p) => new NodeActionEdgDispatch(p),
    });
}

