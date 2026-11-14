/**
 * Slash command layer for the composer — `/pause` `/resume` `/compact` `/opt`
 * plus the mode switches `/plan` `/ask` `/auto`.
 *
 * Matching rules (decided in docs/plans/20260828-composer-slash-pause-resume-compact.md):
 * - A prompt is a command only when its trimmed value equals a registered
 *   lowercase command name exactly (case-sensitive).
 * - Unknown `/xxx`, partial prefixes, and trailing text are NOT commands —
 *   they fall through as normal user messages (no error popup).
 *
 * Argument layer (docs/plans/20260828-composer-prompt-optimizer.md):
 * - Commands with `acceptsArgs: true` (`/opt`, `/plan`, `/ask`, `/auto`,
 *   `/compact`) additionally match as `/name <argument>` via
 *   {@link matchSlashCommandWithArgs}. Exact no-arg matching above is
 *   untouched. Mode commands consume the argument as the prompt to send
 *   after the switch; `/opt` optimizes its argument before sending;
 *   `/compact` takes one decimal keep ratio (`/compact 0.1` — parsed by
 *   parseProtectTokenRatioArg, invalid args get a usage hint).
 * - `//<name> <text>` escapes interception: one leading `/` is stripped and
 *   the text is sent literally, so users can still send prompt text that
 *   begins with a command word (Slack-style escape; only this one rule).
 */

/** A registered slash command. `name` includes the leading slash. */
export type SlashCommand = {
  name: string;
  description: string;
  /**
   * Command consumes trailing text after its name as an argument
   * (`/opt <prompt>`). Exact-match commands leave this unset.
   */
  acceptsArgs?: boolean;
};

/** Registry — append here to add commands (lightweight by design). */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "/pause",
    description: "Pause the running turn at the next round boundary",
  },
  {
    name: "/resume",
    description: "Resume the paused task with a continuation turn",
  },
  {
    name: "/compact",
    description:
      "Compact the task context now (idle tasks only) — optional keep ratio: /compact 0.1 keeps only the newest 10% context budget raw",
    acceptsArgs: true,
  },
  {
    name: "/opt",
    description:
      "Polish the prompt after the command (typos/grammar/clarity) with one fast LLM pass, then send it",
    acceptsArgs: true,
  },
  {
    name: "/clear",
    description:
      "Clear the conversation history and start fresh (idle tasks only)",
  },
  {
    name: "/end",
    description:
      "Summarize the whole conversation and reset the context to the digest (idle tasks only)",
  },
  {
    name: "/plan",
    description:
      "Switch to Plan mode — with trailing text, switches and sends it as the prompt",
    acceptsArgs: true,
  },
  {
    name: "/ask",
    description:
      "Switch to Ask mode — with trailing text, switches and sends it as the prompt",
    acceptsArgs: true,
  },
  {
    name: "/auto",
    description:
      "Switch to Auto mode — with trailing text, switches and sends it as the prompt",
    acceptsArgs: true,
  },
  {
    name: "/build",
    description:
      "Run the workspace build task (.larry/tasks.json) and stream output",
  },
  {
    name: "/dev",
    description: "Toggle Dev Mode (⌘1) — the editor workbench layout",
  },
];

/** Run modes reachable via slash commands (excludes `"custom"`). */
export type ComposerRunModeTarget = "agent" | "ask" | "plan";

/** Menu labels for the slash-reachable run modes. */
export const MODE_SLASH_LABELS: Readonly<
  Record<ComposerRunModeTarget, string>
> = {
  agent: "Auto",
  ask: "Ask",
  plan: "Plan",
};

/**
 * Mode-switch commands → composer run mode (`/auto` maps to the internal
 * `"agent"` mode labeled "Auto" in the menu). Switching always clears any
 * custom graph pin, mirroring the plus-menu mode rows.
 */
export const MODE_SLASH_COMMANDS: Readonly<
  Record<string, ComposerRunModeTarget>
> = {
  "/plan": "plan",
  "/ask": "ask",
  "/auto": "agent",
};

/** Map a matched command to a workspace task id ("/build" → "build"). */
export function matchWorkspaceTaskCommand(
  name: string,
): "build" | null {
  if (name === "/build") return "build";
  return null;
}

/** Dev Mode toggle command name. */
export const DEV_MODE_COMMAND = "/dev";

/**
 * Map a matched command name to its run-mode target, or null when the
 * command is not a mode switch.
 */
export function matchModeSlashCommand(
  name: string,
): ComposerRunModeTarget | null {
  return MODE_SLASH_COMMANDS[name] ?? null;
}

/**
 * Exact whole-message match for submission interception.
 * Returns the command, or null when the text should be sent as a normal
 * message (unknown command, partial prefix, trailing text, wrong case).
 */
export function matchSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  return SLASH_COMMANDS.find((command) => command.name === trimmed) ?? null;
}

/** A `/name <argument>` match from {@link matchSlashCommandWithArgs}. */
export type ArgSlashCommandMatch = {
  command: SlashCommand;
  /** Trimmed text after the command name (internal blank lines preserved). */
  args: string;
};

/**
 * Argument-carrying match for submission interception: `/opt <text>`.
 * Returns null for bare `/opt` (no argument), wrong case, `/option`-style
 * run-ons, and every non-argument command (`/pause now` stays null).
 */
export function matchSlashCommandWithArgs(
  text: string,
): ArgSlashCommandMatch | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  for (const command of SLASH_COMMANDS) {
    if (command.acceptsArgs !== true) continue;
    // Case-sensitive prefix check — "/OPT fix this" must not match /opt.
    if (!trimmed.startsWith(command.name)) continue;
    const rest = trimmed.slice(command.name.length);
    if (rest.length === 0) continue; // bare command — not an arg match
    if (!/^\s/.test(rest)) continue; // "/option" is a different word
    const args = rest.trim();
    if (!args) continue;
    return { command, args };
  }
  return null;
}

/** Escape targets — `//<name>` sends `<name> ...` literally. */
const ESCAPE_TARGETS: readonly string[] = [
  "/opt",
  "/plan",
  "/ask",
  "/auto",
  "/compact",
];

/**
 * `//opt <text>` escape: returns the literal text to send (one leading `/`
 * stripped, outer whitespace trimmed), or null when not an escape.
 */
export function matchSlashEscape(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("//")) return null;
  const unescaped = trimmed.slice(1);
  for (const target of ESCAPE_TARGETS) {
    const boundary = new RegExp(`^${target}(?:$|\\s)`);
    if (boundary.test(unescaped)) return unescaped;
  }
  return null;
}

/**
 * Autocomplete candidates for the popup: commands whose name starts with
 * the trimmed input (case-insensitive). Argument commands stay listed once
 * the user has typed past the name into the argument (`/opt fix this`).
 * Empty when the input is not a slash prefix — callers hide the popup then.
 */
export function filterSlashCommands(text: string): SlashCommand[] {
  const query = text.trim().toLowerCase();
  if (!query.startsWith("/") || query.startsWith("//")) return [];
  return SLASH_COMMANDS.filter((command) => {
    if (command.name.startsWith(query)) return true;
    if (command.acceptsArgs !== true) return false;
    return query.startsWith(`${command.name} `);
  });
}
