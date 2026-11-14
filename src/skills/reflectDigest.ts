import {
  STEER_CONTINUATION_PART_ID,
  type Message,
  type ToolCallPart,
  type ToolResultPart,
} from "../session/types.js";

function isSteerContinuation(message: Message): boolean {
  return (
    message.role === "user" &&
    message.parts.some((p) => p.type === "text" && p.id === STEER_CONTINUATION_PART_ID)
  );
}

/**
 * Deterministic turn digest for the skill reflector: what failed and
 * recovered, what the user corrected, which skills were read (with track
 * record) and which similar skills already exist.
 */

export const SKILL_REFLECT_DIGEST_MAX_CHARS = 4000;
const PAIR_CLIP = 300;
const MAX_PAIRS = 8;
const MAX_CORRECTIONS = 5;
const ERROR_CODES = new Set([1, 4, 5]);

export type DigestSkillRead = {
  name: string;
  revision?: number;
  origin?: string;
  status?: string;
  uses?: number;
  successRate?: number | null;
};

export type DigestSimilarSkill = {
  name: string;
  origin: string;
  status: string;
  enabled: boolean;
  supersededByName?: string;
  description: string;
};

export type SkillReflectDigestInput = {
  /** Messages of this turn, starting at its user message. */
  turnMessages: Message[];
  counters: {
    turnModelIterations: number;
    toolErrorCount: number;
    toolRecoveryCount: number;
  };
  skillsRead: DigestSkillRead[];
  similar: DigestSimilarSkill[];
};

function clip(text: string, max = PAIR_CLIP): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function underlyingName(call: ToolCallPart): string {
  if (call.name === "tool_call" && typeof call.arguments.name === "string") {
    return call.arguments.name;
  }
  return call.name;
}

function argsText(call: ToolCallPart): string {
  const args =
    call.name === "tool_call" && call.arguments.arguments && typeof call.arguments.arguments === "object"
      ? call.arguments.arguments
      : call.arguments;
  for (const key of ["command", "cmd", "path", "query", "name"]) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return clip(v, 160);
  }
  try {
    return clip(JSON.stringify(args), 160);
  } catch {
    return "";
  }
}

function resultText(result: ToolResultPart): string {
  return clip(
    result.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join(" "),
    160,
  );
}

function userText(message: Message): string {
  return message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();
}

type Pair = { tool: string; failedArgs: string; error: string; okArgs?: string };

function collectFailures(messages: Message[]): {
  pairs: Pair[];
  denials: string[];
} {
  const calls = new Map<string, ToolCallPart>();
  const open = new Map<string, Pair[]>();
  const pairs: Pair[] = [];
  const denials: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        calls.set(part.id, part);
        continue;
      }
      if (part.type !== "tool_result") continue;
      const call = calls.get(part.toolCallId);
      if (!call) continue;
      const tool = underlyingName(call);
      if (ERROR_CODES.has(part.returnCode)) {
        const pair: Pair = { tool, failedArgs: argsText(call), error: resultText(part) };
        pairs.push(pair);
        open.set(tool, [...(open.get(tool) ?? []), pair]);
      } else if (part.returnCode === 6) {
        denials.push(`${tool}: ${argsText(call)}`);
      } else if (part.returnCode === 0) {
        const waiting = open.get(tool);
        const pair = waiting?.shift();
        if (pair) pair.okArgs = argsText(call);
      }
    }
  }
  return { pairs, denials };
}

/** Messages from the last non-continuation user message to the end. */
export function currentTurnMessages(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "user" && !isSteerContinuation(m)) return messages.slice(i);
  }
  return messages;
}

export function buildSkillReflectDigest(input: SkillReflectDigestInput): string {
  const { pairs, denials } = collectFailures(input.turnMessages);
  const steers = input.turnMessages
    .filter(isSteerContinuation)
    .map(userText)
    .filter(Boolean);

  const lines: string[] = ["[SKILL_REFLECT_DIGEST]"];
  const c = input.counters;
  lines.push(
    `Turn: ${c.turnModelIterations} model iterations, ${c.toolErrorCount} tool errors, ${c.toolRecoveryCount} recovered, ${steers.length} user steer(s), ${denials.length} denied call(s).`,
  );

  if (input.skillsRead.length > 0) {
    lines.push("Skills read this turn:");
    for (const s of input.skillsRead) {
      const meta = [
        s.revision !== undefined ? `rev ${s.revision}` : "",
        s.origin ? `origin ${s.origin}` : "",
        s.status && s.status !== "active" ? s.status : "",
        s.uses !== undefined
          ? `${s.uses} uses${s.successRate != null ? `, ${Math.round(s.successRate * 100)}% clean` : ""}`
          : "",
      ].filter(Boolean);
      lines.push(`  - ${s.name}${meta.length > 0 ? ` (${meta.join("; ")})` : ""}`);
    }
  }

  const recovered = pairs.filter((p) => p.okArgs !== undefined).slice(0, MAX_PAIRS);
  const unresolved = pairs
    .filter((p) => p.okArgs === undefined)
    .slice(0, Math.max(0, MAX_PAIRS - recovered.length));
  if (recovered.length > 0) {
    lines.push("Recovered failures:");
    for (const p of recovered) {
      lines.push(`  - ${p.tool}: \`${p.failedArgs}\` → ${p.error}`);
      lines.push(`    later ok: \`${p.okArgs}\``);
    }
  }
  if (unresolved.length > 0) {
    lines.push("Unresolved failures:");
    for (const p of unresolved) lines.push(`  - ${p.tool}: \`${p.failedArgs}\` → ${p.error}`);
  }

  const corrections = [
    ...steers.map((t) => `steer: "${clip(t, 200)}"`),
    ...denials.map((d) => `denied: ${d}`),
  ].slice(0, MAX_CORRECTIONS);
  if (corrections.length > 0) {
    lines.push("User corrections:");
    for (const line of corrections) lines.push(`  - ${line}`);
  }

  if (input.similar.length > 0) {
    lines.push("Similar existing skills (not read this turn):");
    for (const s of input.similar) {
      const state =
        s.status === "deprecated"
          ? `deprecated${s.supersededByName ? ` → ${s.supersededByName}` : ""}`
          : s.enabled
            ? "active"
            : "disabled";
      lines.push(`  - ${s.name} (origin ${s.origin}, ${state}): "${clip(s.description, 140)}"`);
    }
  }

  let text = lines.join("\n");
  if (text.length > SKILL_REFLECT_DIGEST_MAX_CHARS) {
    text = `${text.slice(0, SKILL_REFLECT_DIGEST_MAX_CHARS - 12)}\n…(clipped)`;
  }
  return text;
}

/** Similarity query: the turn's user text, read skill descriptions and failing tools. */
export function skillReflectQuery(
  turnMessages: Message[],
  readDescriptions: string[],
): string {
  const first = turnMessages.find((m) => m.role === "user");
  const { pairs } = collectFailures(turnMessages);
  return [
    first ? clip(userText(first), 1000) : "",
    ...readDescriptions,
    ...pairs.map((p) => p.tool.replace(/_/g, " ")),
  ].join(" ");
}
