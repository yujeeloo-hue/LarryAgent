import { askUserDefinition, askUserHandler } from "./builtin/askUser.js";
import {
  requestFullPermissionsDefinition,
  requestFullPermissionsHandler,
} from "./builtin/requestFullPermissions.js";
import {
  searchToolsDefinition,
  searchToolsHandler,
} from "./builtin/searchTools.js";
import {
  searchSkillsDefinition,
  searchSkillsHandler,
} from "./builtin/searchSkills.js";
import {
  toolDescribeDefinition,
  toolDescribeHandler,
} from "./builtin/toolDescribe.js";
import {
  toolCallDefinition,
  toolCallHandler,
} from "./builtin/toolCall.js";
import {
  batchSearchDefinition,
  batchSearchHandler,
} from "./builtin/batchSearch.js";
import {
  awaitSubagentDefinition,
  awaitSubagentHandler,
} from "./builtin/awaitSubagent.js";
import {
  completePlanDefinition,
  completePlanHandler,
} from "./builtin/completePlan.js";
import {
  createMcpServerDefinition,
  createMcpServerHandler,
} from "./builtin/createMcpServer.js";
import {
  dispatchSubagentDefinition,
  dispatchSubagentHandler,
} from "./builtin/dispatchSubagent.js";
import {
  getSubagentStatusDefinition,
  getSubagentStatusHandler,
} from "./builtin/getSubagentStatus.js";
import {
  listSubagentsDefinition,
  listSubagentsHandler,
} from "./builtin/listSubagents.js";
import {
  stopSubagentDefinition,
  stopSubagentHandler,
} from "./builtin/stopSubagent.js";
import {
  subagentBatchResultDefinition,
  subagentBatchResultHandler,
} from "./builtin/subagentBatchResult.js";
import {
  createSkillDefinition,
  createSkillHandler,
} from "./builtin/createSkill.js";
import {
  installSkillDefinition,
  installSkillHandler,
} from "./builtin/installSkill.js";
import {
  createPlanDefinition,
  createPlanHandler,
} from "./builtin/createPlan.js";
import {
  writePlanDocDefinition,
  writePlanDocHandler,
} from "./builtin/writePlanDoc.js";
import { adoptPlanDocDefinition, adoptPlanDocHandler } from "./builtin/adoptPlanDoc.js";
import {
  reportStepBlockedDefinition,
  reportStepBlockedHandler,
} from "./builtin/reportStepBlocked.js";
import {
  fsmRouteDefinition,
  fsmRouteHandler,
} from "./builtin/fsmRoute.js";
import {
  fsmGraphDefinition,
  fsmGraphHandler,
} from "./builtin/fsmGraph.js";
import {
  fsmGraphEditDefinition,
  fsmGraphEditHandler,
} from "./builtin/fsmGraphEdit.js";
import {
  turnHandoffDefinition,
  turnHandoffHandler,
} from "./builtin/turnHandoff.js";
import {
  deleteMcpServerDefinition,
  deleteMcpServerHandler,
} from "./builtin/deleteMcpServer.js";
import {
  deleteSkillDefinition,
  deleteSkillHandler,
} from "./builtin/deleteSkill.js";
import { displayImageDefinition, displayImageHandler } from "./builtin/displayImage.js";
import {
  generateImageDefinition,
  generateImageHandler,
} from "./builtin/generateImageTool.js";
import {
  captureAppWindowDefinition,
  captureAppWindowHandler,
} from "./builtin/captureAppWindow.js";
import { htmlToPdfEnabled, IS_HEADLESS, windowCaptureEnabled } from "../platformCaps.js";
import { displayPdfDefinition, displayPdfHandler } from "./builtin/displayPdf.js";
import {
  presentDemoDefinition,
  presentDemoHandler,
} from "./builtin/presentDemo.js";
import {
  convertToPdfDefinition,
  convertToPdfHandler,
} from "./builtin/convertToPdf.js";
import { patchDefinition, patchHandler } from "./builtin/patch.js";
import {
  configureClangdService,
  findCxxReferencesDefinition,
  findCxxReferencesHandler,
} from "./builtin/findCxxReferences.js";
import {
  getWorkspacePathDefinition,
  getWorkspacePathHandler,
} from "./builtin/getWorkspacePath.js";
import {
  getCurrentTimeDefinition,
  getCurrentTimeHandler,
} from "./builtin/getCurrentTime.js";
import { grepDefinition, grepHandler } from "./builtin/grep.js";
import { globDefinition, globHandler } from "./builtin/glob.js";
import { symbolsDefinition, symbolsHandler } from "./builtin/symbols.js";
import { listDirDefinition, listDirHandler } from "./builtin/listDir.js";
import { readFileDefinition, readFileHandler } from "./builtin/readFile.js";
import { devTasksDefinition, devTasksHandler } from "./builtin/devTasks.js";
import {
  runDevTaskDefinition,
  runDevTaskHandler,
} from "./builtin/runDevTask.js";
import { notifyDefinition, notifyHandler } from "./builtin/notify.js";
import { readImageDefinition, readImageHandler } from "./builtin/readImage.js";
import {
  readSkillDefinition,
  readSkillHandler,
} from "./builtin/readSkill.js";
import {
  readUserMemoryDefinition,
  readUserMemoryHandler,
} from "./builtin/readUserMemory.js";
import {
  searchSessionHistoryDefinition,
  searchSessionHistoryHandler,
} from "./builtin/searchSessionHistory.js";
import {
  readProjectMemoryDefinition,
  readProjectMemoryHandler,
} from "./builtin/readProjectMemory.js";
import { runShellDefinition, runShellHandler } from "./builtin/runShell.js";
import { uploadFilesDefinition, uploadFilesHandler } from "./builtin/uploadFiles.js";
import {
  updateUserMemoryDefinition,
  updateUserMemoryHandler,
} from "./builtin/updateUserMemory.js";
import {
  updateProjectMemoryDefinition,
  updateProjectMemoryHandler,
} from "./builtin/updateProjectMemory.js";
import {
  updateMcpServerDefinition,
  updateMcpServerHandler,
} from "./builtin/updateMcpServer.js";
import {
  updateSkillDefinition,
  updateSkillHandler,
} from "./builtin/updateSkill.js";
import {
  updatePlanDefinition,
  updatePlanHandler,
} from "./builtin/updatePlan.js";
import { writeFileDefinition, writeFileHandler } from "./builtin/writeFile.js";
import {
  writeSkillFileDefinition,
  writeSkillFileHandler,
} from "./builtin/writeSkillFile.js";
import { patchSkillDefinition, patchSkillHandler } from "./builtin/patchSkill.js";
import { mergeSkillsDefinition, mergeSkillsHandler } from "./builtin/mergeSkills.js";
import { deprecateSkillDefinition, deprecateSkillHandler } from "./builtin/deprecateSkill.js";
import { getBuiltinExecutionSummarizer } from "./executionSummaries.js";
import { registerTool } from "./registry.js";

export type {
  PermissionDecision,
  PermissionDenialDetail,
  PermissionDenialReason,
} from "./permissions.js";
export {
  clearToolPermissionOverridesWithPrefix,
  getAllToolPermissionOverrides,
  loadToolPermissionOverrides,
  
} from "./config.js";
export {
  clearToolOfferOverridesWithPrefix,
  getAllToolOfferOverrides,
  getToolOfferAutoBaseline,
  loadToolOfferAutoBaseline,
  loadToolOfferOverrides,
  
} from "./offerConfig.js";
export {
  ALWAYS_VISIBLE_TOOLS,
  clearToolDisplayOverride,
  getAllToolDisplayOverrides,
  isToolCardVisible,
  listHiddenToolCards,
  loadToolDisplayOverrides,
  setToolDisplayOverride,
} from "./displayConfig.js";
export type { ToolSearchHit } from "./offerSet.js";
export type { ToolBridgeScope } from "./toolBridge.js";
export type { ToolDisplayMeta, ToolIconId } from "./displayMeta.js";
export type {
  ParseToolArgumentsResult,
  ValidateToolArgumentsResult,
} from "./validateToolArguments.js";
export type {
  BuiltinToolName,
  PermissionGateState,
  PermissionLevel,
  RegisteredTool,
  ToolDefinition,
  ToolExecuteContext,
  ToolExecuteResult,
  ToolExecutionSummarizer,
  ToolExecutionSummaryInput,
  ToolHandler,
  ToolName,
  UserAskAnswer,
  VisionClientConfig,
} from "./types.js";
export type {
  ToolCatalogEntry,
  ToolCategory,
  ToolCategoryId,
} from "./catalog.js";
export {
  listToolCatalogGrouped,
  setToolCatalogPermission,
  setToolCatalogOffer,
  setToolCatalogDisplay,
  autoOrganizeToolOffers,
} from "./catalogService.js";
export type {
  ToolPermissionUpdate,
  ToolOfferUpdate,
} from "./catalogService.js";

let builtinsRegistered = false;

function registerBuiltin(
  definition: Parameters<typeof registerTool>[0],
  execute: Parameters<typeof registerTool>[1],
): void {
  const summarizeExecution = getBuiltinExecutionSummarizer(definition.name);
  registerTool(
    definition,
    execute,
    summarizeExecution ? { summarizeExecution } : undefined,
  );
}

/** Idempotent registration of first-version built-in tools. */
export function registerBuiltins(): void {
  if (builtinsRegistered) return;

  registerBuiltin(readFileDefinition, readFileHandler);
  registerBuiltin(devTasksDefinition, devTasksHandler);
  // run_dev_task rides the main-process Dev Mode runner; agentd has no such
  // port, so keep it out of the headless catalog (same rule as notify).
  if (!IS_HEADLESS) {
    registerBuiltin(runDevTaskDefinition, runDevTaskHandler);
  }
  // notify needs a desktop-only service port (notification hub). Never
  // registered on headless (agentd) — keep in sync with the port wiring in
  // src/main/index.ts when adding new UI-coupled tools. (loops was retired in
  // favor of CoCo; its builtin stays unregistered.)
  if (!IS_HEADLESS) {
    registerBuiltin(notifyDefinition, notifyHandler);
  }
  registerBuiltin(writeFileDefinition, writeFileHandler);
  registerBuiltin(patchDefinition, patchHandler);
  registerBuiltin(runShellDefinition, runShellHandler);
  registerBuiltin(uploadFilesDefinition, uploadFilesHandler);
  registerBuiltin(listDirDefinition, listDirHandler);
  registerBuiltin(getWorkspacePathDefinition, getWorkspacePathHandler);
  registerBuiltin(getCurrentTimeDefinition, getCurrentTimeHandler);
  registerBuiltin(grepDefinition, grepHandler);
  registerBuiltin(globDefinition, globHandler);
  registerBuiltin(symbolsDefinition, symbolsHandler);
  registerBuiltin(batchSearchDefinition, batchSearchHandler);
  registerBuiltin(findCxxReferencesDefinition, findCxxReferencesHandler);
  registerBuiltin(askUserDefinition, askUserHandler);
  registerBuiltin(requestFullPermissionsDefinition, requestFullPermissionsHandler);
  registerBuiltin(searchToolsDefinition, searchToolsHandler);
  registerBuiltin(searchSkillsDefinition, searchSkillsHandler);
  registerBuiltin(toolDescribeDefinition, toolDescribeHandler);
  registerBuiltin(toolCallDefinition, toolCallHandler);
  registerBuiltin(createPlanDefinition, createPlanHandler);
  registerBuiltin(writePlanDocDefinition, writePlanDocHandler);
  registerBuiltin(adoptPlanDocDefinition, adoptPlanDocHandler);
  registerBuiltin(updatePlanDefinition, updatePlanHandler);
  registerBuiltin(completePlanDefinition, completePlanHandler);
  registerBuiltin(fsmRouteDefinition, fsmRouteHandler);
  registerBuiltin(fsmGraphDefinition, fsmGraphHandler);
  registerBuiltin(fsmGraphEditDefinition, fsmGraphEditHandler);
  registerBuiltin(turnHandoffDefinition, turnHandoffHandler);
  registerBuiltin(reportStepBlockedDefinition, reportStepBlockedHandler);
  registerBuiltin(readImageDefinition, readImageHandler);
  registerBuiltin(displayImageDefinition, displayImageHandler);
  registerBuiltin(generateImageDefinition, generateImageHandler);
  if (windowCaptureEnabled) {
    registerBuiltin(captureAppWindowDefinition, captureAppWindowHandler);
  }
  if (htmlToPdfEnabled) {
    registerBuiltin(convertToPdfDefinition, convertToPdfHandler);
  }
  registerBuiltin(displayPdfDefinition, displayPdfHandler);
  registerBuiltin(presentDemoDefinition, presentDemoHandler);
  registerBuiltin(createMcpServerDefinition, createMcpServerHandler);
  registerBuiltin(updateMcpServerDefinition, updateMcpServerHandler);
  registerBuiltin(deleteMcpServerDefinition, deleteMcpServerHandler);
  registerBuiltin(createSkillDefinition, createSkillHandler);
  registerBuiltin(updateSkillDefinition, updateSkillHandler);
  registerBuiltin(deleteSkillDefinition, deleteSkillHandler);
  registerBuiltin(readSkillDefinition, readSkillHandler);
  registerBuiltin(writeSkillFileDefinition, writeSkillFileHandler);
  registerBuiltin(patchSkillDefinition, patchSkillHandler);
  registerBuiltin(mergeSkillsDefinition, mergeSkillsHandler);
  registerBuiltin(deprecateSkillDefinition, deprecateSkillHandler);
  registerBuiltin(installSkillDefinition, installSkillHandler);
  registerBuiltin(readUserMemoryDefinition, readUserMemoryHandler);
  registerBuiltin(updateUserMemoryDefinition, updateUserMemoryHandler);
  registerBuiltin(readProjectMemoryDefinition, readProjectMemoryHandler);
  registerBuiltin(updateProjectMemoryDefinition, updateProjectMemoryHandler);
  registerBuiltin(searchSessionHistoryDefinition, searchSessionHistoryHandler);
  registerBuiltin(dispatchSubagentDefinition, dispatchSubagentHandler);
  registerBuiltin(awaitSubagentDefinition, awaitSubagentHandler);
  registerBuiltin(subagentBatchResultDefinition, subagentBatchResultHandler);
  registerBuiltin(getSubagentStatusDefinition, getSubagentStatusHandler);
  registerBuiltin(listSubagentsDefinition, listSubagentsHandler);
  registerBuiltin(stopSubagentDefinition, stopSubagentHandler);

  builtinsRegistered = true;
}
