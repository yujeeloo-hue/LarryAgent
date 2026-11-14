import {
  commandHooksAsListEntries,
  loadHookConfigs,
  projectHooksPath,
  userHooksPath,
  type LoadedHookConfigs,
} from "./config.js";
import {
  applyCommandFailure,
  runCommandHook,
} from "./commandRunner.js";
import {
  matchesHookMatcher,
  matcherCandidateForToolEvent,
} from "./matcher.js";
import {
  applyDenyFailure,
  emptyMergedResult,
  mergeHookDecision,
  parseHookDecision,
} from "./merge.js";
import {
  inProcessHooksAsListEntries,
  listInProcessHooks,
} from "./registry.js";
import type {
  HookBasePayload,
  HookEventName,
  HookListEntry,
  HookPayload,
  HookRunner,
  HookRunnerOptions,
  MergedHookResult,
} from "./types.js";

function buildBasePayload(
  options: HookRunnerOptions,
  partial: Partial<HookBasePayload> & Record<string, unknown>,
): HookPayload {
  const workspacePath =
    (typeof partial.workspacePath === "string" && partial.workspacePath) ||
    options.workspacePath;
  const cwd =
    (typeof partial.cwd === "string" && partial.cwd) || workspacePath;
  const sessionId =
    typeof partial.sessionId === "string" ? partial.sessionId : "";
  return {
    ...partial,
    sessionId,
    workspacePath,
    cwd,
  };
}

function matcherCandidate(
  event: HookEventName,
  payload: HookPayload,
): string {
  const toolName =
    typeof payload.tool_name === "string"
      ? payload.tool_name
      : typeof payload.toolName === "string"
        ? payload.toolName
        : "";
  const shellCommand =
    typeof payload.command === "string"
      ? payload.command
      : typeof payload.shell_command === "string"
        ? payload.shell_command
        : undefined;
  const mcpServerId =
    typeof payload.mcp_server_id === "string"
      ? payload.mcp_server_id
      : typeof payload.mcpServerId === "string"
        ? payload.mcpServerId
        : undefined;
  if (toolName || shellCommand || mcpServerId) {
    return matcherCandidateForToolEvent({
      event,
      toolName: toolName || "",
      ...(shellCommand ? { shellCommand } : {}),
      ...(mcpServerId ? { mcpServerId } : {}),
    });
  }
  if (event === "beforeSubmitPrompt" || event === "turnStart") {
    return "UserPromptSubmit";
  }
  return event;
}

export function createHookRunner(options: HookRunnerOptions): HookRunner {
  let loaded: LoadedHookConfigs | null = null;
  let workspacePath = options.workspacePath;

  async function ensureLoaded(): Promise<LoadedHookConfigs> {
    if (!loaded) {
      loaded = await loadHookConfigs({
        userDataRoot: options.userDataRoot,
        workspacePath,
      });
    }
    return loaded;
  }

  const runner: HookRunner = {
    async reload(): Promise<void> {
      loaded = await loadHookConfigs({
        userDataRoot: options.userDataRoot,
        workspacePath,
      });
    },

    paths() {
      return {
        user: userHooksPath(options.userDataRoot),
        project: projectHooksPath(workspacePath),
      };
    },

    listEntries(): HookListEntry[] {
      const commandEntries = loaded
        ? commandHooksAsListEntries(loaded)
        : [];
      return [...inProcessHooksAsListEntries(), ...commandEntries];
    },

    async run(
      event: HookEventName,
      partialPayload: Omit<HookPayload, keyof HookBasePayload> &
        Partial<HookBasePayload>,
    ): Promise<MergedHookResult> {
      const payload = buildBasePayload(
        { ...options, workspacePath },
        partialPayload,
      );
      const configs = await ensureLoaded();
      let acc = emptyMergedResult();
      const candidate = matcherCandidate(event, payload);

      // 1) In-process hooks first (registration order)
      for (const reg of listInProcessHooks(event)) {
        if (!matchesHookMatcher(reg.matcher, candidate)) continue;
        try {
          const raw = await reg.handler(event, payload);
          const decision = parseHookDecision(raw ?? {});
          acc = mergeHookDecision(acc, decision);
          if (acc.denied) return acc;
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          if (reg.failClosed) {
            return applyDenyFailure(acc, message);
          }
          // fail-open: continue
        }
      }

      // 2) Command hooks: user then project
      const commandList = configs.orderedByEvent.get(event) ?? [];
      for (const item of commandList) {
        if (!matchesHookMatcher(item.config.matcher, candidate)) continue;
        const result = await runCommandHook({
          command: item.config.command,
          cwd: payload.cwd,
          payload: { ...payload, hook_event_name: event },
          ...(typeof item.config.timeout === "number"
            ? { timeoutSec: item.config.timeout }
            : {}),
          failClosed: item.config.failClosed === true,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!result.ok) {
          acc = applyCommandFailure(acc, result);
          if (acc.denied) return acc;
          continue;
        }
        acc = mergeHookDecision(acc, result.decision);
        if (acc.denied) return acc;
      }

      return acc;
    },
  };

  // Allow workspace path updates when reusing a long-lived runner factory
  (runner as HookRunner & { setWorkspacePath?: (path: string) => void }).setWorkspacePath =
    (path: string) => {
      workspacePath = path;
      loaded = null;
    };

  return runner;
}

/**
 * Create a per-turn runner bound to a workspace (reloads config each create).
 */
export async function createTurnHookRunner(input: {
  userDataRoot: string;
  workspacePath: string;
  signal?: AbortSignal;
}): Promise<HookRunner> {
  const runner = createHookRunner({
    userDataRoot: input.userDataRoot,
    workspacePath: input.workspacePath,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  await runner.reload();
  return runner;
}
