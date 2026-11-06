import { parseAskAnswerResult } from "../shared/askUser.js";
import {
  TOOL_RESULT_BODY_PART_ID,
  TOOL_RESULT_DIFF_PART_ID,
} from "./displayMeta.js";
import { SHELL_TOOL_NAME } from "./shellToolName.js";
import {
  argNumber,
  argString,
  clipOneLine,
  firstResultLine,
  outcomeWord,
  shortPath,
  textBody,
  utf8Bytes,
} from "./executionSummary.js";
import type { BuiltinToolName, ToolExecutionSummarizer } from "./types.js";
import type { JsonObject, ToolResultContentPart } from "../session/types.js";

const UI_ONLY_PART_IDS = new Set([
  TOOL_RESULT_BODY_PART_ID,
  TOOL_RESULT_DIFF_PART_ID,
]);

function modelText(content: ToolResultContentPart[]): string {
  return textBody(content, { skipIds: UI_ONLY_PART_IDS });
}

function pathArg(args: JsonObject): string {
  return shortPath(argString(args, "path"));
}

function contentBytes(args: JsonObject): number {
  const content = args.content;
  return typeof content === "string" ? utf8Bytes(content) : 0;
}

function skillRef(args: JsonObject): string {
  return (
    argString(args, "name") ??
    argString(args, "id") ??
    argString(args, "new_name") ??
    "(unknown)"
  );
}

function mcpRef(args: JsonObject): string {
  return argString(args, "name") ?? argString(args, "id") ?? "(unknown)";
}

function parseListDirCount(text: string): number | undefined {
  const m = text.match(/^list_dir\s+.+\s+\((\d+)\)/m);
  return m ? Number(m[1]) : undefined;
}

function parseGrepMatchCount(text: string): number | undefined {
  const m = text.match(/—\s+(\d+)\s+match/);
  return m ? Number(m[1]) : undefined;
}

function parseShellExit(text: string): number | undefined {
  const m = text.match(/^exit\s+(-?\d+)/m);
  return m ? Number(m[1]) : undefined;
}

function parseReadFileRange(
  text: string,
): { start: number; end: number } | undefined {
  const m = text.match(/^Lines\s+(\d+)-(\d+)\s+of\s+/m);
  if (!m) return undefined;
  return { start: Number(m[1]), end: Number(m[2]) };
}

function idList(args: JsonObject, key = "ids"): string[] {
  const raw = args[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

const summarizeReadFile: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const path = pathArg(args);
  const outcome = outcomeWord(returnCode);
  const body = modelText(content);
  const chars = body.length;
  const bytes = utf8Bytes(body);
  const offset = argNumber(args, "offset");
  const limit = argNumber(args, "limit");
  const ranged = offset !== undefined || limit !== undefined;

  if (!ranged) {
    return `read_file read ${path}: whole file, ${chars} chars / ${bytes} bytes, ${outcome}.`;
  }

  const range = parseReadFileRange(body);
  const start = range?.start ?? offset ?? 1;
  const lineCount = range
    ? Math.max(0, range.end - range.start + 1)
    : (limit ?? 0);
  return `read_file read ${path}: from line ${start}, ${lineCount} lines, ${chars} chars / ${bytes} bytes, ${outcome}.`;
};

const summarizeWriteFile: ToolExecutionSummarizer = ({ args, returnCode }) => {
  const path = pathArg(args);
  const bytes = contentBytes(args);
  return `write_file wrote ${path}: ${bytes} bytes, ${outcomeWord(returnCode)}.`;
};

const summarizePatch: ToolExecutionSummarizer = ({ args, returnCode }) => {
  const path = pathArg(args);
  const mode = argString(args, "mode");
  const v4a = argString(args, "patch") ?? argString(args, "patch_text");
  if (v4a || mode === "patch") {
    return `patch applied a V4A patch: ${outcomeWord(returnCode)}.`;
  }
  if (path) {
    return `patch edited ${path}: ${outcomeWord(returnCode)}.`;
  }
  return `patch edited a file: ${outcomeWord(returnCode)}.`;
};

const summarizeRunShell: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const command = clipOneLine(argString(args, "command") ?? "(empty)", 48);
  const exit = parseShellExit(modelText(content));
  const outcome = outcomeWord(returnCode);
  if (exit !== undefined) {
    return `${SHELL_TOOL_NAME} ran "${command}": exit ${exit}, ${outcome}.`;
  }
  return `${SHELL_TOOL_NAME} ran "${command}": ${outcome}.`;
};

const summarizeListDir: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const path = pathArg(args);
  const count = parseListDirCount(modelText(content));
  const outcome = outcomeWord(returnCode);
  if (count !== undefined) {
    return `list_dir listed ${path}: ${count} entries, ${outcome}.`;
  }
  return `list_dir listed ${path}: ${outcome}.`;
};

const summarizeGrep: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const pattern = clipOneLine(argString(args, "pattern") ?? "", 32);
  const scope = argString(args, "path")
    ? shortPath(argString(args, "path"))
    : "workspace";
  const matches = parseGrepMatchCount(modelText(content));
  const outcome = outcomeWord(returnCode);
  if (matches !== undefined) {
    return `grep searched "${pattern}" in ${scope}: ${matches} matches, ${outcome}.`;
  }
  return `grep searched "${pattern}" in ${scope}: ${outcome}.`;
};

const summarizeBatchSearch: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const queries = Array.isArray(args.queries) ? args.queries.length : 0;
  return `batch_search ran ${queries} ${queries === 1 ? "query" : "queries"}: ${outcomeWord(returnCode)}.`;
};

const summarizeSymbols: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const query = clipOneLine(argString(args, "query") ?? "", 32);
  const scope = argString(args, "path")
    ? shortPath(argString(args, "path"))
    : "workspace";
  const outcome = outcomeWord(returnCode);
  const hitCount = /— (\d+) hit/.exec(modelText(content));
  if (hitCount) {
    return `symbols searched "${query}" in ${scope}: ${hitCount[1]} hits, ${outcome}.`;
  }
  return `symbols searched "${query}" in ${scope}: ${outcome}.`;
};

const summarizeAskUser: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  if (returnCode !== 0) {
    return `ask_user asked user: ${outcome}.`;
  }
  const body = modelText(content).trim();
  const structured = parseAskAnswerResult(body);
  const answer = structured
    ? [...structured.selected_options, structured.custom_answer, structured.comment].filter(Boolean).join("; ")
    : body
      .replace(/^(Selected(?:\s*\(\d+\))?|Custom answer|Answer):\s*/i, "")
      .trim() || body;
  const multi = typeof args.multiple === "boolean" ? args.multiple : args.allow_multiple === true;
  return `ask_user asked user: ${multi ? "answers" : "answer"} "${clipOneLine(answer, 40)}", ${outcome}.`;
};

const summarizeRequestFullPermissions: ToolExecutionSummarizer = ({
  returnCode,
}) => {
  const outcome = outcomeWord(returnCode);
  if (returnCode === 0) {
    return `request_full_permissions enabled Bypass permissions: ${outcome}.`;
  }
  return `request_full_permissions asked user: ${outcome}.`;
};

const summarizeSearchTools: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  const query = argString(args, "query") ?? "";
  if (returnCode !== 0) {
    return `search_tools searched tools: ${outcome}.`;
  }
  const body = modelText(content);
  const m =
    body.match(/Found (\d+) deferred tool/) ??
    body.match(/Activated (\d+) tool/);
  const n = m ? m[1] : "?";
  return `search_tools queried "${clipOneLine(query, 32)}" → found ${n}: ${outcome}.`;
};

const summarizeSearchSkills: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  const query = argString(args, "query") ?? "";
  if (returnCode !== 0) {
    return `search_skills searched skills: ${outcome}.`;
  }
  const body = modelText(content);
  const m =
    body.match(/Found (\d+) skill/) ??
    body.match(/Enabled skill\(s\) \((\d+)\)/);
  const n = m ? m[1] : "?";
  if (!query) {
    return `search_skills listed ${n} skill(s): ${outcome}.`;
  }
  return `search_skills queried "${clipOneLine(query, 32)}" → found ${n}: ${outcome}.`;
};

const summarizeToolDescribe: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const name = argString(args, "name") ?? "?";
  return `tool_describe loaded schema for ${name}: ${outcomeWord(returnCode)}.`;
};

const summarizeToolCall: ToolExecutionSummarizer = ({ args, returnCode }) => {
  const name = argString(args, "name") ?? "?";
  return `tool_call invoked ${name}: ${outcomeWord(returnCode)}.`;
};

const summarizeReadImage: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const path = pathArg(args);
  const outcome = outcomeWord(returnCode);
  if (returnCode === 0) {
    const chars = modelText(content).length;
    return `read_image described ${path}: ${chars} chars, ${outcome}.`;
  }
  return `read_image described ${path}: ${outcome}.`;
};

const summarizeDisplayImage: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  return `display_image showed ${pathArg(args)}: ${outcomeWord(returnCode)}.`;
};

const summarizeGenerateImage: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const prompt = clipOneLine(argString(args, "prompt") ?? "(empty)", 32);
  const imageCount = Array.isArray(args.images) ? args.images.length : 0;
  return `generate_image "${prompt}"${imageCount > 0 ? ` (+${imageCount} ref image${imageCount > 1 ? "s" : ""})` : ""}: ${outcomeWord(returnCode)}.`;
};

const summarizeCaptureAppWindow: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const app = argString(args, "app_name") ?? "(unknown)";
  const output = shortPath(argString(args, "output"));
  return `capture_app_window captured ${app} → ${output}: ${outcomeWord(returnCode)}.`;
};

const summarizeDisplayPdf: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  return `display_pdf showed ${pathArg(args)}: ${outcomeWord(returnCode)}.`;
};

const summarizePresentDemo: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const params = Array.isArray(args.params) ? args.params.length : 0;
  return `present_demo showed ${pathArg(args)}${params > 0 ? ` (${params} params)` : ""}: ${outcomeWord(returnCode)}.`;
};

const summarizeConvertToPdf: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const input = shortPath(argString(args, "path"));
  const output = shortPath(argString(args, "output"));
  return `convert_to_pdf converted ${input} → ${output}: ${outcomeWord(returnCode)}.`;
};

const summarizeGetWorkspacePath: ToolExecutionSummarizer = ({
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  if (returnCode === 0) {
    return `get_workspace_path returned ${shortPath(modelText(content).trim())}: ${outcome}.`;
  }
  return `get_workspace_path returned path: ${outcome}.`;
};

const summarizeGetCurrentTime: ToolExecutionSummarizer = ({
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  if (returnCode === 0) {
    const line = firstResultLine(content);
    const iso =
      line.match(/Local time:\s*(\S+)/)?.[1] ?? clipOneLine(line, 32);
    return `get_current_time returned ${iso}: ${outcome}.`;
  }
  return `get_current_time returned time: ${outcome}.`;
};

const summarizeCreateMcpServer: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  return `create_mcp_server created server ${mcpRef(args)}: ${outcomeWord(returnCode)}.`;
};

const summarizeUpdateMcpServer: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  return `update_mcp_server updated server ${mcpRef(args)}: ${outcomeWord(returnCode)}.`;
};

const summarizeDeleteMcpServer: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  return `delete_mcp_server deleted server ${mcpRef(args)}: ${outcomeWord(returnCode)}.`;
};

const summarizeCreateSkill: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  return `create_skill created skill ${skillRef(args)}: ${outcomeWord(returnCode)}.`;
};

const summarizeUpdateSkill: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  return `update_skill updated skill ${skillRef(args)}: ${outcomeWord(returnCode)}.`;
};

const summarizeDeleteSkill: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  return `delete_skill deleted skill ${skillRef(args)}: ${outcomeWord(returnCode)}.`;
};

const summarizeReadSkill: ToolExecutionSummarizer = ({ args, returnCode }) => {
  const name = skillRef(args);
  const filePath = argString(args, "path");
  const outcome = outcomeWord(returnCode);
  if (returnCode !== 0) {
    return `read_skill failed to load skill ${name}: ${outcome}.`;
  }
  if (filePath) {
    return `read_skill used skill: ${name} (file ${clipOneLine(filePath, 32)}).`;
  }
  return `read_skill used skill: ${name}.`;
};

const summarizeWriteSkillFile: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const name = skillRef(args);
  const filePath = argString(args, "path") ?? "(unknown)";
  return `write_skill_file wrote ${clipOneLine(filePath, 32)} in skill ${name}: ${outcomeWord(returnCode)}.`;
};

const summarizeInstallSkill: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const zip = shortPath(argString(args, "path"));
  const name = argString(args, "name");
  const outcome = outcomeWord(returnCode);
  if (name) {
    return `install_skill installed ${name} from ${zip}: ${outcome}.`;
  }
  return `install_skill installed from ${zip}: ${outcome}.`;
};

const summarizeCreatePlan: ToolExecutionSummarizer = ({ args, returnCode }) => {
  const title = clipOneLine(argString(args, "title") ?? "Plan", 40);
  const steps = Array.isArray(args.steps) ? args.steps.length : 0;
  return `create_plan created "${title}" with ${steps} steps: ${outcomeWord(returnCode)}.`;
};

const summarizeWritePlanDoc: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const title = clipOneLine(argString(args, "title") ?? "plan", 40);
  return `write_plan_doc wrote docs/plans for "${title}": ${outcomeWord(returnCode)}.`;
};

const summarizeUpdatePlan: ToolExecutionSummarizer = ({ args, returnCode }) => {
  const title = argString(args, "title");
  const stepCount = Array.isArray(args.steps) ? args.steps.length : 0;
  const outcome = outcomeWord(returnCode);
  if (title) {
    return `update_plan updated "${clipOneLine(title, 40)}" (${stepCount} step changes): ${outcome}.`;
  }
  return `update_plan updated plan (${stepCount} step changes): ${outcome}.`;
};

const summarizeCompletePlan: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const status = argString(args, "status") ?? "completed";
  return `complete_plan marked plan ${status}: ${outcomeWord(returnCode)}.`;
};

const summarizeReadUserMemory: ToolExecutionSummarizer = ({
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  if (returnCode !== 0) {
    return `read_user_memory read profile: ${outcome}.`;
  }
  const body = modelText(content);
  if (/User memory is empty/i.test(body)) {
    return `read_user_memory read profile: empty, ${outcome}.`;
  }
  return `read_user_memory read profile: ${body.length} chars, ${outcome}.`;
};

const summarizeUpdateUserMemory: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const mode = argString(args, "mode") === "replace" ? "replace" : "merge";
  const chars =
    typeof args.content === "string" ? args.content.length : 0;
  return `update_user_memory updated profile (${mode}, ${chars} chars input): ${outcomeWord(returnCode)}.`;
};

const summarizeReadProjectMemory: ToolExecutionSummarizer = ({
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  if (returnCode !== 0) {
    return `read_project_memory read PROJECT.md: ${outcome}.`;
  }
  const body = modelText(content);
  if (/Project memory is empty/i.test(body)) {
    return `read_project_memory read PROJECT.md: empty, ${outcome}.`;
  }
  return `read_project_memory read PROJECT.md: ${body.length} chars, ${outcome}.`;
};

const summarizeUpdateProjectMemory: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const mode = argString(args, "mode") === "replace" ? "replace" : "merge";
  const section = argString(args, "section");
  const chars =
    typeof args.content === "string" ? args.content.length : 0;
  const sectionPart = section ? `, section ${section}` : "";
  return `update_project_memory updated PROJECT.md (${mode}${sectionPart}, ${chars} chars input): ${outcomeWord(returnCode)}.`;
};

const summarizeSearchSessionHistory: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  const mode = argString(args, "mode") === "read" ? "read" : "search";
  if (returnCode !== 0) {
    return `search_session_history ${mode}: ${outcome}.`;
  }
  const body = modelText(content);
  if (mode === "read") {
    if (/archived session/i.test(body)) {
      return `search_session_history read archive summary: ${outcome}.`;
    }
    const m = /(\d+) message\(s\)/i.exec(body);
    const n = m ? m[1] : "?";
    return `search_session_history read ${n} messages: ${outcome}.`;
  }
  const m = /Found (\d+) hit/i.exec(body);
  if (m) return `search_session_history found ${m[1]} hits: ${outcome}.`;
  if (/No matching/i.test(body)) {
    return `search_session_history found 0 hits: ${outcome}.`;
  }
  return `search_session_history searched: ${outcome}.`;
};

const summarizeDispatchSubagent: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  const name = argString(args, "name") ?? argString(args, "title");
  const batch = argString(args, "batch_id") ?? argString(args, "batchId");
  if (returnCode === 0) {
    const idMatch = modelText(content).match(/id=([^\s,)]+)/);
    const id = idMatch?.[1];
    const label = name ?? id ?? "subagent";
    const batchPart = batch ? `, batch ${batch}` : "";
    return `dispatch_subagent started ${label}${batchPart}: ${outcome}.`;
  }
  return `dispatch_subagent started subagent: ${outcome}.`;
};

const summarizeAwaitSubagent: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const ids = idList(args);
  const n = ids.length;
  return `await_subagent waited for ${n} ${n === 1 ? "subagent" : "subagents"}: ${outcomeWord(returnCode)}.`;
};

const summarizeSubagentBatchResult: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const batch =
    argString(args, "batch_id") ?? argString(args, "batchId") ?? "batch";
  return `subagent_batch_result delivered batch ${batch}: ${outcomeWord(returnCode)}.`;
};

const summarizeGetSubagentStatus: ToolExecutionSummarizer = ({
  args,
  returnCode,
  content,
}) => {
  const ids = idList(args, "ids");
  const outcome = outcomeWord(returnCode);
  if (ids.length > 0) {
    return `get_subagent_status checked ${ids.length} ${ids.length === 1 ? "subagent" : "subagents"}: ${outcome}.`;
  }
  if (returnCode === 0 && /No matching subagents/i.test(modelText(content))) {
    return `get_subagent_status checked subagents: none, ${outcome}.`;
  }
  return `get_subagent_status checked subagents: ${outcome}.`;
};

const summarizeListSubagents: ToolExecutionSummarizer = ({
  returnCode,
  content,
}) => {
  const outcome = outcomeWord(returnCode);
  const body = modelText(content).trim();
  if (returnCode === 0) {
    if (!body || /no subagents/i.test(body)) {
      return `list_subagents listed 0 subagents: ${outcome}.`;
    }
    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return `list_subagents listed ${lines.length} ${lines.length === 1 ? "subagent" : "subagents"}: ${outcome}.`;
  }
  return `list_subagents listed subagents: ${outcome}.`;
};

const summarizeStopSubagent: ToolExecutionSummarizer = ({
  args,
  returnCode,
}) => {
  const ids = idList(args);
  const n = ids.length;
  return `stop_subagent stopped ${n} ${n === 1 ? "subagent" : "subagents"}: ${outcomeWord(returnCode)}.`;
};

/** Per-builtin one-line execution summary templates (no LLM). */
export const BUILTIN_EXECUTION_SUMMARIES: Record<
  BuiltinToolName,
  ToolExecutionSummarizer
> = {
  read_file: summarizeReadFile,
  write_file: summarizeWriteFile,
  dev_tasks: ({ args, returnCode }) => {
    const action = typeof args.action === "string" ? args.action : "?";
    return `dev_tasks ${action}: ${outcomeWord(returnCode)}.`;
  },
  patch: summarizePatch,
  run_shell: summarizeRunShell,
  exec_command: summarizeRunShell,
  upload_files: ({ args, returnCode }) => {
    const src = typeof args.src === "string" ? args.src : "?";
    const host = typeof args.dest_host === "string" ? args.dest_host : "?";
    const path = typeof args.dest_path === "string" ? args.dest_path : "?";
    return returnCode === 0
      ? `upload_files sent ${src} to ${host}:${path}.`
      : `upload_files failed to send ${src} to ${host}:${path}.`;
  },
  list_dir: summarizeListDir,
  grep: summarizeGrep,
  symbols: summarizeSymbols,
  batch_search: summarizeBatchSearch,
  find_cxx_references: summarizeSymbols,
  ask_user: summarizeAskUser,
  request_full_permissions: summarizeRequestFullPermissions,
  search_tools: summarizeSearchTools,
  search_skills: summarizeSearchSkills,
  tool_describe: summarizeToolDescribe,
  tool_call: summarizeToolCall,
  read_image: summarizeReadImage,
  display_image: summarizeDisplayImage,
  generate_image: summarizeGenerateImage,
  capture_app_window: summarizeCaptureAppWindow,
  convert_to_pdf: summarizeConvertToPdf,
  display_pdf: summarizeDisplayPdf,
  present_demo: summarizePresentDemo,
  get_workspace_path: summarizeGetWorkspacePath,
  get_current_time: summarizeGetCurrentTime,
  create_mcp_server: summarizeCreateMcpServer,
  update_mcp_server: summarizeUpdateMcpServer,
  delete_mcp_server: summarizeDeleteMcpServer,
  create_skill: summarizeCreateSkill,
  update_skill: summarizeUpdateSkill,
  delete_skill: summarizeDeleteSkill,
  read_skill: summarizeReadSkill,
  write_skill_file: summarizeWriteSkillFile,
  install_skill: summarizeInstallSkill,
  create_plan: summarizeCreatePlan,
  write_plan_doc: summarizeWritePlanDoc,
  adopt_plan_doc: ({ args, returnCode }) => `adopt_plan_doc bound ${String(args.path ?? "")}: ${outcomeWord(returnCode)}.`,
  update_plan: summarizeUpdatePlan,
  complete_plan: summarizeCompletePlan,
  fsm_route: ({ args }) => {
    const route = typeof args.route === "string" ? args.route.trim() : "";
    return route ? `FSM route: ${route}` : "FSM route";
  },
  report_step_blocked: ({ args }) => {
    const step =
      typeof args.step_id === "string" ? args.step_id.trim() : "";
    const error = typeof args.error === "string" ? args.error.trim() : "";
    if (step && error) return `Blocked ${step}: ${error}`;
    if (step) return `Blocked ${step}`;
    return error || "Step blocked";
  },
  read_user_memory: summarizeReadUserMemory,
  update_user_memory: summarizeUpdateUserMemory,
  read_project_memory: summarizeReadProjectMemory,
  update_project_memory: summarizeUpdateProjectMemory,
  search_session_history: summarizeSearchSessionHistory,
  dispatch_subagent: summarizeDispatchSubagent,
  await_subagent: summarizeAwaitSubagent,
  subagent_batch_result: summarizeSubagentBatchResult,
  get_subagent_status: summarizeGetSubagentStatus,
  list_subagents: summarizeListSubagents,
  stop_subagent: summarizeStopSubagent,

  fsm_graph: ({ args, returnCode }) => {
    const outcome = outcomeWord(returnCode);
    const raw = (args as { action?: unknown } | undefined)?.action;
    const action = typeof raw === "string" ? raw : "unknown";
    return `fsm_graph ${action} ${outcome}.`;
  },
  fsm_graph_edit: ({ args, returnCode }) => {
    const outcome = outcomeWord(returnCode);
    const raw = (args as { action?: unknown } | undefined)?.action;
    const action = typeof raw === "string" ? raw : "unknown";
    return `fsm_graph_edit ${action} ${outcome}.`;
  },
  turn_handoff: ({ args, returnCode }) => {
    const outcome = outcomeWord(returnCode);
    const raw = (args as { action?: unknown } | undefined)?.action;
    const action = typeof raw === "string" ? raw : "unknown";
    return `turn_handoff ${action} ${outcome}.`;
  },
  loops: ({ args, returnCode }) => {
    const outcome = outcomeWord(returnCode);
    const action =
      typeof args.action === "string" && args.action ? args.action : "unknown";
    const ref = typeof args.id === "string" && args.id ? ` ${args.id}` : "";
    return `loops ${action}${ref} ${outcome}.`;
  },
  notify: ({ args, returnCode }) => {
    const outcome = outcomeWord(returnCode);
    const title =
      typeof args.title === "string" && args.title
        ? ` ${JSON.stringify(args.title)}`
        : "";
    return `notify${title} ${outcome}.`;
  },
};

export function getBuiltinExecutionSummarizer(
  name: string,
): ToolExecutionSummarizer | undefined {
  return BUILTIN_EXECUTION_SUMMARIES[name as BuiltinToolName];
}
