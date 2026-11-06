import { createAskUserAnswerView } from "../../../../../shared/askUserPanel.js";
import { demoCardStateFor } from "../../../../../session/demoCardState.js";
import { ChevronDown, CloudUpload, Hourglass, LoaderCircle, RectangleEllipsis, Square } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { isShellToolName } from "../../../state/shellToolName.js";
import { formatTokenCount } from "../../../ui/contextUsage.js";
import { createAskUserPanel } from "./AskUserPanelView.js";
import { createToolOutcomeBadge } from "./ToolOutcomeBadge.js";
import { countHunkLineChanges, editStringsFromArgs } from "./buildHunkDiff.js";
import { streamingWritePreviewPathHint } from "./streamingWritePreview.js";
import { parseDiffLinesJson } from "./diffTypes.js";
import {
  getToolDisplayMeta,
  parseLineChangeCounts,
} from "./toolDisplay.js";
import type { PlanProgressDisplay } from "../planSnapshots.js";
import { subagentCardLabel } from "../subagentDisplay.js";
import {
  buildFailureTip,
  contentFromArgs,
  createPlanProgressStatusIcon,
  createSubagentStatusIcon,
  isAskUserTool,
  isDemoTool,
  isEditFileTool,
  isPatchTool,
  isPlanDocTool,
  isPlanProgressTool,
  isReadSkillTool,
  isReadUserMemoryTool,
  isRichToolCard,
  isCocoBackgroundTool,
  isSearchToolsTool,
  isSubagentTool,
  isWriteFileTool,
  patchPathHintFromResultText,
  patchTextFromArgs,
  pathFromArgs,
  planDocPathHintFromTitle,
  planDocTitleFromArgs,
  planProgressKindFromArgs,
  planProgressTitleFromArgs,
  questionFromArgs,
  returnCodeLabel,
  searchToolsQueryFromArgs,
  skillRefFromArgs,
  statusLabel,
  toolCardHint,
  unwrapToolCallBridge,
} from "./toolInvocationHelpers.js";
import {
  appendOutputBody,
  appendWriteFileContent,
  parseResultContent,
} from "./toolInvocationOutputBody.js";
import {
  parseUploadFinished,
  seedUploadLive,
  uploadInfoFromTool,
  type UploadFinishedStats,
} from "./uploadCard.js";
import type { UploadCardInfo } from "./uploadCard.js";
import {
  createUploadFinishedSection,
  createUploadLiveZone,
} from "./uploadCardView.js";
import {
  createDemoCardPanel,
  demoArgsInfo,
  demoCardHint,
  type DemoCardState,
} from "./DemoCardView.js";
import {
  createSleepFinishedSection,
  createSleepZone,
  parseSleepResultOutput,
  sleepFinishedHint,
  sleepHint,
  sleepInfoFromArgs,
} from "./sleepCardView.js";
import type {
  SubagentStatusKind,
  ToolInvocationCardInput,
} from "./toolInvocationTypes.js";
import {
  createVirtualToolCard,
  isVirtualizedToolName,
} from "./virtualToolCard.js";
import { attachToolCardBody } from "./toolCardState.js";

export type {
  PendingAskSnapshot,
  SubagentStatusKind,
  ToolInvocationCardInput,
  ToolResultSnapshot,
} from "./toolInvocationTypes.js";

/** Summary-row hint: src → dest. Transfer stats live in the card body. */
function uploadCardHint(info: UploadCardInfo): string {
  return `${info.src} → ${info.dest}`;
}

/**
 * Running run_shell right-side control: a spinning loader that swaps to a
 * stop button on hover. The stop button aborts just this tool call (the turn
 * keeps going; the model receives a Cancelled result and decides next steps).
 */
function createRunShellRunControl(
  input: ToolInvocationCardInput,
): HTMLElement {
  const control = document.createElement("span");
  control.className = "content-card-tool-run-control";
  control.dataset.toolRunning = "1";

  const spinner = createLucideIcon(LoaderCircle, { size: 15 });
  spinner.classList.add("content-card-tool-run-spinner");
  control.append(spinner);

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "content-card-tool-stop-btn";
  stopBtn.title = "Stop command";
  stopBtn.setAttribute("aria-label", "Stop command");
  const stopIcon = createLucideIcon(Square, { size: 12, strokeWidth: 2.25 });
  stopIcon.classList.add("content-card-tool-stop-icon");
  stopBtn.append(stopIcon);
  stopBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (stopBtn.disabled) return;
    stopBtn.disabled = true;
    input.onAbortToolCall?.(input.id);
  });
  control.append(stopBtn);

  return control;
}

/** Sum add/del rows across all file_diff parts of a patch result. */
function sumDiffLineChanges(
  diffJsons: string[],
): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let seen = false;
  for (const json of diffJsons) {
    const lines = parseDiffLinesJson(json);
    if (!lines) continue;
    for (const line of lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "del") removed += 1;
    }
    seen = true;
  }
  return seen ? { added, removed } : null;
}

/**
 * Pair per-file diff parts with their paths: explicit part.path when the
 * tool emitted one, else a legacy zip with the report lines. The legacy zip
 * ignores `Deleting file` lines — deletes report a line but carry no diff
 * part, which shifted every later pairing onto the wrong file.
 */
function buildPatchDiffEntries(
  diffJsons: string[],
  diffPaths: Array<string | undefined>,
  resultText: string,
): { pathOrName?: string; diffJson: string }[] {
  const paths = [
    ...resultText.matchAll(/^(?:Patching|Creating) file (.+)$/gm),
  ]
    .map((match) => match[1]?.trim())
    .filter((path): path is string => path !== undefined && path.length > 0);
  return diffJsons.map((diffJson, i) => ({
    ...((diffPaths[i] ?? paths[i]) !== undefined
      ? { pathOrName: diffPaths[i] ?? paths[i] }
      : {}),
    diffJson,
  }));
}

/** Single card: tool input + output (when available). */
export function createToolInvocationCard(
  input: ToolInvocationCardInput,
): HTMLElement {
  // Deferred `tool_call` bridge: render as the inner tool (upload_files
  // progress card, sleep countdown, …) so live tool_live snapshots patch
  // the right zone shape. argumentsRaw keeps the bridge wire format.
  const bridged = unwrapToolCallBridge(input.name, input.arguments);
  input = { ...input, name: bridged.name, arguments: bridged.arguments };
  return isVirtualizedToolName(input.name)
    ? createVirtualToolCard(input, renderToolInvocationCard)
    : renderToolInvocationCard(input);
}

/** Pure rendering path, also used when a destroyed offscreen card returns. */
function renderToolInvocationCard(input: ToolInvocationCardInput): HTMLElement {
  const meta = getToolDisplayMeta(input.name);
  const result = input.result;
  const hasResult = result !== undefined;
  const ok = hasResult ? result.returnCode === 0 : false;
  const pendingAsk = input.pendingAsk;
  const askUser = isAskUserTool(input.name);
  const demoTool = isDemoTool(input.name);
  const readSkill = isReadSkillTool(input.name);
  const searchTools = isSearchToolsTool(input.name);
  const readUserMemory = isReadUserMemoryTool(input.name);
  const subagentTool = isSubagentTool(input.name);
  const planProgress = isPlanProgressTool(input.name);
  const writeFile = isWriteFileTool(input.name);
  const planDoc = isPlanDocTool(input.name);
  const patchTool = isPatchTool(input.name);
  const patchFailure = patchTool && hasResult && !ok;
  const previewContent = toolPreviewContent(input);
  const hasPreview = typeof previewContent === "string" && !hasResult;
  // Rich = expandable full-width (writes / edits / ask). Everything else is
  // a compact ≤520px status row with no expand.
  // Upload-detected cards: running stays compact (progress zone), finished
  // becomes rich with the transfer summary. Sleep-detected run_shell stays
  // compact for the whole lifetime (countdown zone → wait summary).
  const uploadInfo = uploadInfoFromTool(input.name, input.arguments);
  // Sleep-detected wait-then-check cards (upload takes precedence on the
  // rare overlap; the two shapes are mutually exclusive in practice).
  const sleepInfo = uploadInfo ? null : sleepInfoFromArgs(input.arguments);
  const demoInfo = demoTool ? demoArgsInfo(input.arguments) : null;
  const demoState: DemoCardState | null = demoInfo
    ? demoCardStateFor(input.demoStates, input.id, input.demoSettled ?? null)
    : null;
  const uploadFinished = Boolean(uploadInfo && hasResult);
  const sleepFinished = Boolean(sleepInfo && hasResult);
  const rich =
    isRichToolCard(input.name) ||
    Boolean(pendingAsk) ||
    hasPreview ||
    uploadFinished;
  const compact = !rich;
  const expandable = rich;

  const askQuestion = pendingAsk?.question ?? questionFromArgs(input.arguments);
  const skillRef = readSkill ? skillRefFromArgs(input.arguments) : undefined;
  const searchQuery = searchTools
    ? searchToolsQueryFromArgs(input.arguments)
    : undefined;
  const planDisplay: PlanProgressDisplay | undefined = planProgress
    ? input.planProgress ?? {
        label: planProgressTitleFromArgs(input.name, input.arguments),
        kind: planProgressKindFromArgs(input.name, input.arguments),
      }
    : undefined;
  const subagentStatusKind: SubagentStatusKind | undefined = subagentTool
    ? input.subagentStatus ??
      (input.status === "done"
        ? hasResult && !ok
          ? "error"
          : "completed"
        : input.status === "error"
          ? "error"
          : input.status === "cancelled"
            ? "cancelled"
            : input.status === "running" || input.status === "pending"
              ? "running"
              : undefined)
    : undefined;
  const expand = !input.initiallyCollapsed && !patchFailure && (
    Boolean(pendingAsk) ||
    askUser ||
    demoTool ||
    hasPreview ||
    // Upload cards stay expanded once finished — the transfer summary is the
    // point of the card, no need to click it open.
    uploadFinished ||
    (hasResult && rich ? meta.expandResultByDefault : false)
  );

  const card = document.createElement(expandable ? "details" : "div");
  card.className = [
    "content-card",
    "content-card-tool-invocation",
    compact ? "is-compact" : "is-rich",
    askUser ? "content-card-ask-user-tool" : "",
    readSkill ? "content-card-read-skill-tool" : "",
    searchTools ? "content-card-search-tools-tool" : "",
    readUserMemory ? "content-card-read-user-memory-tool" : "",
    subagentTool ? "content-card-subagent-tool" : "",
    planProgress ? "content-card-plan-tool" : "",
    uploadInfo ? "content-card-tool-upload" : "",
    sleepInfo ? "content-card-tool-sleep" : "",
    demoTool ? "content-card-demo-tool" : "",
    hasResult && !planProgress && !subagentTool
      ? ok
        ? "is-success"
        : "is-error"
      : "",
    pendingAsk ? "is-asking" : "",
    hasPreview ? "is-streaming-preview" : "",
    `content-card-tool-${input.status || "pending"}`,
  ]
    .filter(Boolean)
    .join(" ");
  card.dataset.toolCallId = input.id;
  card.dataset.toolName = input.name;
  if (hasPreview) {
    card.dataset.toolStreaming = "1";
  }
  if (expandable && card.tagName === "DETAILS") {
    (card as HTMLDetailsElement).open = expand;
  }

  const summary = document.createElement(rich ? "summary" : "div");
  summary.className = "content-card-tool-result-summary";

  const left = document.createElement("div");
  left.className = "content-card-tool-result-left";

  const icon = createLucideIcon(
    uploadInfo ? CloudUpload : sleepInfo ? Hourglass : meta.icon,
    { size: 15 },
  );
  icon.classList.add("content-card-tool-icon");

  const name = document.createElement("span");
  name.className = "content-card-tool-name";
  if (input.name === "ask_user") {
    name.textContent = meta.displayName;
  } else if (askUser && askQuestion) {
    name.classList.add("content-card-ask-user-title");
    name.textContent = askQuestion;
    name.title = askQuestion;
  } else if (askUser && input.name === "request_full_permissions") {
    const fallback = "Enable bypass permissions?";
    name.classList.add("content-card-ask-user-title");
    name.textContent = fallback;
    name.title = fallback;
  } else if (readSkill) {
    name.classList.add("content-card-read-skill-title");
    const label = skillRef ? `Skill → ${skillRef}` : "Read Skill";
    name.textContent = label;
    name.title = label;
  } else if (searchTools) {
    name.classList.add("content-card-search-tools-title");
    const label = searchQuery || "Search Tools";
    name.textContent = label;
    name.title = label;
  } else if (planDisplay) {
    name.classList.add("content-card-plan-tool-title");
    name.textContent = planDisplay.label;
    name.title = planDisplay.label;
  } else if (subagentTool) {
    name.classList.add("content-card-subagent-tool-title");
    const label = subagentCardLabel(
      input.name,
      input.arguments,
      input.subagentNamesById,
    );
    name.textContent = label;
    name.title = label;
  } else if (demoInfo) {
    name.classList.add("content-card-demo-title");
    name.textContent = demoInfo.title;
    name.title = demoInfo.title;
  } else {
    name.textContent = meta.displayName;
  }

  left.append(icon, name);

  if (planDisplay) {
    const statusIcon = createPlanProgressStatusIcon(planDisplay.kind);
    if (statusIcon) left.append(statusIcon);
  }

  const right = document.createElement("div");
  right.className = "content-card-tool-result-right";

  const parsed = hasResult
    ? parseResultContent(result.content)
    : {
        textParts: [] as string[],
        bodyText: null,
        diffJson: null,
        diffJsons: [] as string[],
        diffPaths: [] as Array<string | undefined>,
      };
  const uploadStats: UploadFinishedStats | null = uploadFinished
    ? parseUploadFinished(parsed.textParts.join("\n"))
    : null;
  const headline = parsed.textParts[0] ?? "";
  const countsFromHeadline = headline ? parseLineChangeCounts(headline) : null;
  const editArgs =
    (isEditFileTool(input.name) || patchTool) && ok
      ? editStringsFromArgs(input.arguments)
      : null;
  // write_file / write_plan_doc full writes — no add/del badge. edit_file
  // keeps hunk counts from its args; patch sums its file_diff parts.
  const counts = writeFile
    ? null
    : patchTool
      ? (sumDiffLineChanges(parsed.diffJsons) ?? countsFromHeadline)
      : planDoc
        ? null
        : countsFromHeadline ??
          (editArgs
            ? countHunkLineChanges(editArgs.oldString, editArgs.newString)
            : null);

  if (counts && rich && !askUser) {
    const changes = document.createElement("span");
    changes.className = "content-card-tool-result-changes";
    const add = document.createElement("span");
    add.className = "is-add";
    add.textContent = `+${counts.added}`;
    const del = document.createElement("span");
    del.className = "is-del";
    del.textContent = `−${counts.removed}`;
    changes.append(add, del);
    right.append(changes);
  }

  // Plan progress: status icon sits inline with the title (left), not as a right badge.
  // Subagent: status icon on the right, like other tool outcome badges.
  if (subagentStatusKind) {
    if (
      input.name === "dispatch_subagent" &&
      typeof input.subagentUsedTokens === "number" &&
      input.subagentUsedTokens > 0
    ) {
      const ctxEl = document.createElement("span");
      ctxEl.className = "content-card-subagent-context";
      const label = formatTokenCount(input.subagentUsedTokens);
      ctxEl.textContent = label;
      ctxEl.title = `${label} context used`;
      right.append(ctxEl);
    }
    const statusIcon = createSubagentStatusIcon(subagentStatusKind);
    if (statusIcon) right.append(statusIcon);
  } else if (!planProgress) {
    if (hasResult) {
      if (patchFailure) {
        const badge = createToolOutcomeBadge({
          ok: false,
          tip: "Patch failed. No changes applied.",
        });
        badge.setAttribute("aria-hidden", "true");
        badge.removeAttribute("aria-label");
        const label = document.createElement("span");
        label.className = "content-card-tool-failure-label";
        label.textContent = "Failed · No changes applied";
        right.append(badge, label);
      } else {
        const tip = ok
          ? returnCodeLabel(0)
          : buildFailureTip(result.returnCode, parsed.textParts);
        right.append(createToolOutcomeBadge({ ok, tip }));
      }
    } else if (pendingAsk) {
      const statusEl = document.createElement("span");
      statusEl.className = "content-card-tool-status";
      statusEl.textContent = "Waiting for answer…";
      right.append(statusEl);
    } else {
      const status = input.status || "pending";
      if (status === "done") {
        right.append(createToolOutcomeBadge({ ok: true, tip: "Success" }));
      } else if (status === "error" || status === "cancelled") {
        right.append(
          createToolOutcomeBadge({ ok: false, tip: statusLabel(status) }),
        );
      } else if (
        isShellToolName(input.name) &&
        (status === "running" || status === "pending")
      ) {
        right.append(createRunShellRunControl(input));
      } else {
        const statusEl = document.createElement("span");
        statusEl.className = "content-card-tool-status";
        statusEl.textContent = statusLabel(status);
        right.append(statusEl);
      }
    }
  }

  if (!askUser) {
    const resultText = parsed.textParts.join("\n");
    let hintText = toolCardHint({
      name: input.name,
      arguments: input.arguments,
      resultText,
    });
    if (demoInfo) {
      hintText = demoCardHint(demoInfo);
    } else if (uploadInfo) {
      hintText = uploadCardHint(uploadInfo);
    } else if (sleepInfo) {
      // Sleep cards: countdown wait (running) or the wait summary (finished).
      hintText = sleepFinished
        ? sleepFinishedHint(sleepInfo, ok, input.status === "cancelled")
        : sleepHint(sleepInfo);
    }
    if (hintText) {
      const pathHint = pathFromArgs(input.arguments);
      const hint = document.createElement("span");
      hint.className = "content-card-tool-result-hint";
      hint.textContent =
        uploadInfo || hintText.length <= 64
          ? hintText
          : `${hintText.slice(0, 61)}…`;
      hint.title = pathHint || hintText;
      left.append(hint);
    }
  }

  if (expandable) {
    const chevron = createLucideIcon(ChevronDown, { size: 14 });
    chevron.classList.add("content-card-tool-result-chevron");
    right.append(chevron);
  }

  summary.append(left, right);
  card.append(summary);

  // Running upload: compact card + live progress zone below the summary row.
  if (!hasResult && uploadInfo) {
    card.append(createUploadLiveZone(input.uploadLive ?? seedUploadLive(uploadInfo)));
  }

  // Running sleep: compact card + local RAF countdown zone. startedAt
  // defaults to card creation (ConversationView seeds it at tool_call).
  if (!hasResult && sleepInfo) {
    card.append(
      createSleepZone(
        input.sleepLive ?? {
          startedAt: Date.now(),
          seconds: sleepInfo.seconds,
          hasFollowUp: sleepInfo.hasFollowUp,
        },
      ),
    );
  }

  // Finished sleep stays compact: designed wait zone, never the expandable
  // generic run_shell card (Arguments JSON + `$ cmd` / cwd / exit dump).
  if (sleepFinished && sleepInfo) {
    const shellOut = parseSleepResultOutput(parsed.textParts.join("\n"));
    card.append(
      createSleepFinishedSection({
        info: sleepInfo,
        ok,
        cancelled: input.status === "cancelled",
        stdoutText: shellOut.stdout,
        stderrText: shellOut.stderr,
      }),
    );
  }

  if (compact) {
    return card;
  }

  const renderBody = (): HTMLElement => {
    // The virtual slot updates this input in place while closed. Reopening must
    // use the latest stream, not the preview captured when the summary was built.
    const previewContent = toolPreviewContent(input);
    const hasPreview = typeof previewContent === "string" && !hasResult;
    const writeContent =
      (writeFile || planDoc) && ok
        ? (contentFromArgs(input.arguments) ??
          (typeof parsed.bodyText === "string" ? parsed.bodyText : undefined))
        : undefined;
    const body = document.createElement("div");
    body.className = "content-card-tool-invocation-body";

    if (!askUser) {
      const inputSection = document.createElement("section");
      inputSection.className = "content-card-tool-section";

      // Arguments JSON is Shell-only; other tools rely on summary hints / result body.
      // (run_shell is compact now — left here for any future rich shell card.)
      const showArguments = isShellToolName(input.name) || isCocoBackgroundTool(input.name);
      const raw =
        input.argumentsRaw ||
        (input.arguments !== undefined
          ? JSON.stringify(input.arguments, null, 2)
          : "");
      if (showArguments && raw && !pendingAsk) {
        const details = document.createElement("details");
        details.className = "content-card-tool-details";
        const detailsSummary = document.createElement("summary");
        detailsSummary.className = "content-card-tool-details-summary";

        const detailsLeft = document.createElement("span");
        detailsLeft.className = "content-card-tool-details-summary-left";
        const argsIcon = createLucideIcon(RectangleEllipsis, { size: 14 });
        argsIcon.classList.add("content-card-tool-details-icon");
        detailsLeft.append(argsIcon, document.createTextNode("Arguments"));

        const detailsChevron = createLucideIcon(ChevronDown, { size: 14 });
        detailsChevron.classList.add("content-card-tool-details-chevron");

        detailsSummary.append(detailsLeft, detailsChevron);
        const pre = document.createElement("pre");
        pre.className = "content-card-tool-json";
        pre.textContent = raw;
        details.append(detailsSummary, pre);
        inputSection.append(details);
      }

      if (inputSection.childElementCount > 0) {
        body.append(inputSection);
      }
    }

    const outputSection = document.createElement("section");
    outputSection.className =
      "content-card-tool-section content-card-tool-section-output";

    if (demoInfo) {
      outputSection.append(
        createDemoCardPanel({
          toolCallId: input.id,
          path: demoInfo.path,
          title: demoInfo.title,
          ...(demoInfo.prompt ? { prompt: demoInfo.prompt } : {}),
          params: demoInfo.params,
          hasResult,
          ok,
          settled: input.demoSettled ?? null,
          state: demoState ?? { values: {}, note: "" },
          ...(input.onSubmitDemoParams
            ? { onSubmitDemoParams: input.onSubmitDemoParams }
            : {}),
        }),
      );
      body.append(outputSection);
      return body;
    }

    const askAnswerView = input.name === "ask_user" && ok ? createAskUserAnswerView(parsed.textParts.join("\n"), askQuestion) : null;
    if (askAnswerView) {
      outputSection.append(askAnswerView);
    } else if (hasResult) {
      // Upload-detected run_shell: replace the generic output body with the
      // transfer summary section (stats + file snapshot + excludes / error).
      if (uploadFinished && uploadInfo) {
        // Flush wrapper: the upload section carries its own tight padding —
        // the generic 10px 12px here would stack on top of it.
        outputSection.classList.add("content-card-tool-section-output-flush");
        outputSection.append(
          createUploadFinishedSection({
            ok,
            cancelled: input.status === "cancelled",
            info: uploadInfo,
            stats: uploadStats ?? {
              files: null,
              bytes: null,
              elapsedSec: null,
              finalLine: null,
              fileLines: [],
              stderrTail: [],
            },
          }),
        );
        body.append(outputSection);
        return body;
      }
      const outputBody = document.createElement("div");
      outputBody.className = "content-card-tool-result-body";
      const resultText = parsed.textParts.join("\n");
      const pathHint =
        pathFromArgs(input.arguments) ??
        (patchTool ? patchPathHintFromResultText(resultText) : undefined) ??
        (planDoc
          ? planDocPathHintFromTitle(planDocTitleFromArgs(input.arguments))
          : undefined);
      appendOutputBody(
        outputBody,
        parsed,
        result.returnCode,
        pathHint,
        {
          foldUnchanged: isEditFileTool(input.name) || patchTool,
          ...((isEditFileTool(input.name) || patchTool) && editArgs
            ? { editArgs: input.arguments }
            : {}),
          ...((isWriteFileTool(input.name) || planDoc) &&
          writeContent !== undefined
            ? { writeContent }
            : {}),
          ...(patchTool && ok && parsed.diffJsons.length > 0
            ? {
                diffEntries: buildPatchDiffEntries(
                  parsed.diffJsons,
                  parsed.diffPaths,
                  resultText,
                ),
              }
            : {}),
        },
      );
      outputSection.append(outputBody);
    } else if (pendingAsk) {
      outputSection.append(
        createAskUserPanel({
          question: pendingAsk.question,
          options: pendingAsk.options,
          ...(pendingAsk.optionDetails ? { optionDetails: pendingAsk.optionDetails } : {}),
          allowCustom: pendingAsk.allowCustom,
          allowMultiple: pendingAsk.allowMultiple,
          hideQuestion: input.name !== "ask_user",
          draftKey: pendingAsk.requestId,
          onAnswer: (answer) => {
            input.onUserAskAnswer?.(pendingAsk.requestId, answer);
          },
        }),
      );
    } else if (hasPreview) {
      const outputBody = document.createElement("div");
      outputBody.className =
        "content-card-tool-result-body content-card-tool-preview-body";
      const pathHint = streamingWritePreviewPathHint({
        name: input.name,
        arguments: input.arguments,
        argumentsRaw: input.argumentsRaw,
      });
      appendWriteFileContent(outputBody, previewContent!, pathHint, {
        streaming: true,
      });
      outputSection.append(outputBody);
    } else {
      const pending = document.createElement("p");
      pending.className = "md-paragraph content-card-tool-pending";
      pending.textContent =
        input.status === "running" ? "Executing tool…" : "Waiting for result…";
      outputSection.append(pending);
    }

    body.append(outputSection);
    return body;
  };
  if (isVirtualizedToolName(input.name) || demoTool) {
    attachToolCardBody(card as HTMLDetailsElement, renderBody);
  } else {
    card.append(renderBody());
  }
  return card;
}

function toolPreviewContent(input: ToolInvocationCardInput): string | undefined {
  if (input.result) return undefined;
  if (input.previewContent !== undefined) return input.previewContent;
  if (isWriteFileTool(input.name) || isPlanDocTool(input.name)) {
    return contentFromArgs(input.arguments);
  }
  if (isPatchTool(input.name)) {
    const args = input.arguments as { new_string?: unknown } | undefined;
    return patchTextFromArgs(input.arguments) ??
      (typeof args?.new_string === "string" ? args.new_string : undefined);
  }
  return undefined;
}
