/**
 * Structured provider subscription-usage snapshots for the tray usage popup.
 *
 * Unlike src/llm/balance/ (one English text line for the conversation view),
 * these adapters return render-ready structured data modeled after the
 * CursorUsage menu-bar app (Sources/Shared/*.swift in that project).
 */

export type UsageProviderKey =
  | "kimi-code"
  | "glm-code"
  | "kimi"
  | "deepseek"
  | "openrouter"
  | "qwen-code";

export type UsageBar = {
  /** Short row label, e.g. "5h" / "Weekly" / "Monthly". */
  label: string;
  /** 0–100. */
  percent: number;
  /** Optional absolute detail rendered under the bar, e.g. "1,234 / 5,000 credits". */
  detail?: string;
};

export type ProviderUsageSnapshot = {
  key: UsageProviderKey;
  /** Section title, e.g. "Kimi Code". */
  title: string;
  /** Optional gold badge text, e.g. plan level "Pro". */
  badge?: string;
  bars: UsageBar[];
  /** Caption detail lines (reset times, balance breakdowns). */
  lines: string[];
  /** Set when this source failed; bars/lines are empty and the UI shows this in red. */
  error?: string;
  /** Date.now() when the fetch completed (successful or not). */
  fetchedAt: number;
};

export type ProviderUsageProfile = {
  id: string;
  name: string;
  baseUrl: string;
  modelId?: string;
};

export type ProviderUsageQueryInput = ProviderUsageProfile & {
  apiKey: string;
};

export type ProviderUsageAdapter = {
  key: UsageProviderKey;
  matches: (provider: ProviderUsageProfile) => boolean;
  /** Never throws: failures come back as a snapshot with `error` set. */
  query: (input: ProviderUsageQueryInput) => Promise<ProviderUsageSnapshot>;
};
