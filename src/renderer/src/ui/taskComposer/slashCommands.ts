
export type SlashCommand = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
};

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
    description: "Toggle Dev Mode — the editor workbench layout",
  },
];

export type ComposerRunModeTarget = "agent" | "ask" | "plan";

export const MODE_SLASH_LABELS: Readonly<
  Record<ComposerRunModeTarget, string>
> = {
  agent: "Auto",
  ask: "Ask",
  plan: "Plan",
};

export const MODE_SLASH_COMMANDS: Readonly<
  Record<string, ComposerRunModeTarget>
> = {
  "/plan": "plan",
  "/ask": "ask",
  "/auto": "agent",
};

export function matchWorkspaceTaskCommand(
  name: string,
): "build" | null {
  if (name === "/build") return "build";
  return null;
}

export const DEV_MODE_COMMAND = "/dev";

export function matchModeSlashCommand(
  name: string,
): ComposerRunModeTarget | null {
  return MODE_SLASH_COMMANDS[name] ?? null;
}

export function matchSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  return SLASH_COMMANDS.find((command) => command.name === trimmed) ?? null;
}

export type ArgSlashCommandMatch = {
  command: SlashCommand;
  args: string;
};

export function matchSlashCommandWithArgs(
  text: string,
): ArgSlashCommandMatch | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  for (const command of SLASH_COMMANDS) {
    if (command.acceptsArgs !== true) continue;
    if (!trimmed.startsWith(command.name)) continue;
    const rest = trimmed.slice(command.name.length);
    if (rest.length === 0) continue;
    if (!/^\s/.test(rest)) continue;
    const args = rest.trim();
    if (!args) continue;
    return { command, args };
  }
  return null;
}

const ESCAPE_TARGETS: readonly string[] = [
  "/opt",
  "/plan",
  "/ask",
  "/auto",
  "/compact",
];

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

export function filterSlashCommands(text: string): SlashCommand[] {
  const query = text.trim().toLowerCase();
  if (!query.startsWith("/") || query.startsWith("//")) return [];
  return SLASH_COMMANDS.filter((command) => {
    if (command.name.startsWith(query)) return true;
    if (command.acceptsArgs !== true) return false;
    return query.startsWith(`${command.name} `);
  });
}
