import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { chatCompletionOnce } from "../llm/openaiCompatibleClient.js";
import { noReasoningExtraBody } from "../llm/reasoningDisable.js";
import { jsonSchemaResponseFormat } from "../llm/strictJsonSchema.js";
import { agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import { getDefaultSkillCurationPrompt } from "../settings/promptDefaults.js";
import {
  applyCurationDecision,
  CURATION_DECISION_SCHEMA,
  CURATION_REASON_PREFIX,
  curationItemPrompt,
  curationTrigger,
  loadCurationState,
  parseCurationDecision,
  preselectCurationItems,
  saveCurationState,
  summarizeCurationResult,
  type CurationItemResult,
  type CurationResult,
  type CurationState,
} from "../skills/curation.js";
import { onSkillMutation, skillManager } from "../skills/manager.js";
import {
  getSkillUsageStats,
  listOpenSkillReads,
  listRecentSkillReads,
  onSkillUsageFinalized,
} from "../skills/usage.js";

/**
 * Background skill-library curation (main process). Checks run at startup
 * and after turns that read skills; no polling. Independent of CoCo, which
 * only hears about results through {@link onSkillCurationRun}.
 */

const CHECK_DEBOUNCE_MS = 5_000;
const RECENT_USAGE_LIMIT = 10;

export type SkillCurationStatus = {
  running: boolean;
  lastRunAt?: number;
  lastResult?: CurationResult;
  summary?: string;
};

const runListeners = new Set<(result: CurationResult, summary: string) => void>();

/** Every finished curation run (applied, suggested or failed). */
export function onSkillCurationRun(
  listener: (result: CurationResult, summary: string) => void,
): () => void {
  runListeners.add(listener);
  return () => runListeners.delete(listener);
}

export function createSkillCuration(input: {
  skillsRoot: string;
  /** Self-learning default (`autoSkillSummarizeDefault`). */
  isEnabled: () => Promise<boolean>;
  resolveClient: () => Promise<OpenAiCompatibleClientConfig | null>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const unsubscribers: (() => void)[] = [];

  const withState = <T>(fn: (state: CurationState) => Promise<T>): Promise<T> => {
    const run = chain.then(async () => fn(await loadCurationState(input.skillsRoot)));
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const recentUsage = (skillId: string) =>
    listRecentSkillReads({ skillId, limit: RECENT_USAGE_LIMIT });

  const judge = async (
    client: OpenAiCompatibleClientConfig,
    prompt: string,
  ): Promise<string> => {
    const result = await chatCompletionOnce(client, {
      messages: [
        { role: "system", content: getDefaultSkillCurationPrompt() },
        { role: "user", content: prompt },
      ],
      meta: { purpose: "skill_curation" },
      responseFormat: jsonSchemaResponseFormat(
        "skill_curation",
        CURATION_DECISION_SCHEMA as unknown as Parameters<typeof jsonSchemaResponseFormat>[1],
      ),
      extraBody: noReasoningExtraBody(client.baseUrl),
    });
    return result.content;
  };

  /** `force` skips the enabled / cooldown / trigger checks (Skills → Curate now). */
  const run = async (reason: string, force: boolean): Promise<CurationResult | null> => {
    if (running) return null;
    running = true;
    try {
      const enabled = await input.isEnabled();
      const at = now();
      const state = await withState(async (s) => s);
      const records = skillManager.listRecords();
      const trigger = force
        ? `manual`
        : curationTrigger({ state, now: at, enabled, records, recentUsage });
      if (!trigger) return null;

      let result: CurationResult;
      const client = await input.resolveClient().catch(() => null);
      if (!client) {
        result = { at, trigger, items: [], error: "no LLM provider is configured" };
      } else {
        const stats = getSkillUsageStats();
        const items = preselectCurationItems({
          records,
          stats,
          recentUsage,
          openReads: listOpenSkillReads(),
          touched: state.touched,
          now: at,
        });
        const byId = new Map(records.map((r) => [r.id, r]));
        const statsById = new Map(stats.map((s) => [s.skillId, s]));
        const results: CurationItemResult[] = [];
        for (const item of items) {
          const names = item.skillIds.map((id) => byId.get(id)?.name ?? id);
          try {
            const decision = parseCurationDecision(
              await judge(client, curationItemPrompt(item, byId, statsById, at)),
            );
            if (!decision) {
              results.push({ kind: item.kind, skills: names, decision: "error", applied: false, reason: "unparseable model reply" });
              continue;
            }
            results.push(await applyCurationDecision({ item, decision, manager: skillManager }));
          } catch (err) {
            results.push({
              kind: item.kind,
              skills: names,
              decision: "error",
              applied: false,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        result = { at, trigger, items: results };
      }

      const summary = summarizeCurationResult(result);
      await withState(async (s) => {
        for (const item of result.items) {
          if (!item.applied && !item.proposalId) continue;
          for (const name of item.skills) {
            const record = skillManager.findSkill(name).record;
            if (record) s.touched[record.id] = at;
          }
        }
        if (!result.error) {
          s.lastRunAt = at;
          s.autoWritesSinceRun = 0;
        }
        s.lastResult = result;
        await saveCurationState(input.skillsRoot, s);
      });
      (result.error ? agentLogWarn : agentLogInfo)("skill.curation.run", {
        reason,
        trigger,
        summary,
        items: result.items.map((i) => ({
          kind: i.kind,
          skills: i.skills,
          decision: i.decision,
          applied: i.applied,
          ...(i.proposalId ? { proposalId: i.proposalId } : {}),
        })),
        ...(result.error ? { error: result.error } : {}),
      });
      for (const listener of runListeners) {
        try {
          listener(result, summary);
        } catch (err) {
          console.warn("[skill-curation] run listener failed", err);
        }
      }
      return result;
    } catch (err) {
      console.error("[skill-curation] run failed", err);
      return null;
    } finally {
      running = false;
    }
  };

  const schedule = (reason: string): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run(reason, false);
    }, CHECK_DEBOUNCE_MS);
    timer.unref?.();
  };

  return {
    start(): void {
      if (unsubscribers.length > 0) return;
      unsubscribers.push(
        onSkillMutation((event) => {
          if (event.ctx.actor !== "reflector" && event.ctx.actor !== "coco") return;
          if (event.kind === "delete" || event.kind === "reactivate") return;
          if (event.ctx.reason?.startsWith(CURATION_REASON_PREFIX)) return;
          void withState(async (s) => {
            s.autoWritesSinceRun += 1;
            await saveCurationState(input.skillsRoot, s);
          }).catch((err) => console.warn("[skill-curation] state write failed", err));
        }),
        onSkillUsageFinalized(() => schedule("turn_end")),
      );
      schedule("startup");
    },
    stop(): void {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      if (timer) clearTimeout(timer);
      timer = null;
    },
    runNow(): Promise<CurationResult | null> {
      return run("manual", true);
    },
    async status(): Promise<SkillCurationStatus> {
      const state = await withState(async (s) => s);
      return {
        running,
        ...(state.lastRunAt !== undefined ? { lastRunAt: state.lastRunAt } : {}),
        ...(state.lastResult
          ? { lastResult: state.lastResult, summary: summarizeCurationResult(state.lastResult) }
          : {}),
      };
    },
  };
}

export type SkillCuration = ReturnType<typeof createSkillCuration>;
