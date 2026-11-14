import { homedir } from "node:os";
import { resolve } from "node:path";
import { IS_WINDOWS } from "../../platformCaps.js";
import {
  evaluateShellDangerRules,
  isSystemWipeTarget,
  pathTargetsGitDir,
  worstSeverity,
  type ShellDangerFinding,
  type ShellRiskClass,
} from "./shellDangerRules.js";
import { classifyPathTarget } from "./trustDomain.js";

/**
 * Lightweight shell command analyzer (plan:
 * docs/plans/20260819-shell-safe-mode.md).
 *
 * NOT a full shell parser: tokenize quotes / && ; | compounds / redirects,
 * expand the few path variables the agent plausibly uses, and resolve
 * targets against the workspace root. Whenever parsing is uncertain the
 * analysis escalates to confirm/fatal — it never silently allows.
 *
 * rm policy v2 (settled): every rm that ultimately runs is rewritten to a
 * Trash move in BOTH Safe Mode and Bypass — inside the workspace, outside
 * it, sensitive paths, .git, sudo-wrapped, multi-segment `rm a; rm b`, and
 * globs (kept as patterns, expanded bounded at runtime). Graded findings
 * still surface (outside → confirm; sensitive/system/.git/root → fatal)
 * so the user approves with full context, and the approved action is
 * always the recoverable Trash move. rm that cannot be safely rewritten
 * (command substitution, compound with non-rm segments, parse errors,
 * unresolvable operands) is flagged rmUnrewritable — the assessor blocks
 * it outright; no approval path ever performs a hard delete.
 *
 * Pure functions; no filesystem access.
 */

export type ShellTrashRewrite = {
  type: "trash";
  /** Absolute targets in argument order: literal paths or glob patterns. */
  targets: string[];
  /** -f given: tolerate missing targets silently. */
  force: boolean;
  originalCommand: string;
};

export type ShellCommandAnalysis = {
  riskClass: ShellRiskClass;
  findings: ShellDangerFinding[];
  rewrite?: ShellTrashRewrite;
  /**
   * An rm exists that can never be safely Trash-routed (command
   * substitution, compound with non-rm segments, parse error, unresolvable
   * operand). Assessors block these outright — approving must never become
   * a hard delete.
   */
  rmUnrewritable?: boolean;
};

export type AnalyzeShellCommandOptions = {
  /** Workspace root = trust domain + cwd for relative paths. */
  workspacePath: string;
  homeDir?: string;
};

type RawToken = { text: string; quoted: boolean };
type Redirect = { target: RawToken };

type ParsedSegment = {
  /** Raw slice of the original command. */
  text: string;
  tokens: RawToken[];
  redirects: Redirect[];
  /** Command name after stripping sudo / env / wrapper prefixes. */
  name: string;
  /**
   * First token before sudo / env / wrapper stripping (rules match on this
   * too, so `sudo …` / `env rm …` keep their wrapper-level rules).
   */
  rawName: string;
  sudoUsed: boolean;
};

/** Leading command wrappers stripped before name resolution. */
const WRAPPERS = new Set(["command", "builtin", "nice", "nohup", "time"]);
/** sudo flags that consume the next argument. */
const SUDO_ARG_FLAGS = new Set(["-u", "-g", "-p", "-C", "-t", "-i", "-s"]);
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GLOB_RE = /[*?]/;
/** Path variables the analyzer can expand. */
const EXPAND_VARS: Record<string, (ctx: { home: string; cwd: string }) => string> = {
  HOME: (c) => c.home,
  PWD: (c) => c.cwd,
  TMPDIR: () => "",
  TMP: () => "",
};

function splitSegments(command: string): {
  segments: string[];
  hasSubstitution: boolean;
  parseError: boolean;
} {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let inBacktick = false;
  let hasSubstitution = false;

  const push = (end: number) => {
    const text = command.slice(start, end);
    if (text.trim().length > 0) segments.push(text);
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    // POSIX shells treat backslash as an escape; on Windows it is a literal
    // path separator (cmd.exe escapes with ^ instead).
    if (ch === "\\" && !IS_WINDOWS) {
      i += 1; // skip escaped char
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" && next === "(") {
        depth += 1;
        hasSubstitution = true;
        i += 1;
      } else if (ch === "`") {
        inBacktick = !inBacktick;
        hasSubstitution = true;
      }
      continue;
    }
    // unquoted
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === "`") {
      inBacktick = !inBacktick;
      hasSubstitution = true;
      continue;
    }
    if (ch === "$" && next === "(") {
      depth += 1;
      hasSubstitution = true;
      i += 1;
      continue;
    }
    if (ch === "(" && command[i - 1] === "<") {
      depth += 1;
      hasSubstitution = true;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth > 0 || inBacktick) continue;
    // Do not split inside >& / &> redirect operators.
    if (ch === "&" && (next === ">" || command[i - 1] === ">")) continue;
    if (ch === ";" || ch === "|" || ch === "&") {
      push(i);
      if ((ch === "|" || ch === "&") && next === ch) i += 1;
      start = i + 1;
    }
  }
  push(command.length);
  return {
    segments,
    hasSubstitution: hasSubstitution || inBacktick,
    parseError: quote !== null || depth !== 0,
  };
}

function tokenizeSegment(text: string): {
  tokens: RawToken[];
  redirects: Redirect[];
} {
  const tokens: RawToken[] = [];
  const redirects: Redirect[] = [];
  let cur = "";
  let curQuoted = false;
  let quote: "'" | '"' | null = null;

  const flush = () => {
    if (cur.length > 0) {
      tokens.push({ text: cur, quoted: curQuoted });
    }
    cur = "";
    curQuoted = false;
  };

  const readUntilDelim = (from: number): { end: number; quoted: boolean } => {
    let j = from;
    let quote: "'" | '"' | null = null;
    let quoted = false;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        quoted = true;
        continue;
      }
      if (c === " " || c === "\t" || c === "|" || c === ";" || c === "&") {
        break;
      }
    }
    return { end: j, quoted };
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else {
        cur += ch;
        curQuoted = true;
      }
      continue;
    }
    if (ch === "\\") {
      if (IS_WINDOWS) {
        cur += ch; // literal path separator
      } else {
        cur += text[i + 1] ?? "";
        i += 1;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else {
        cur += ch;
        curQuoted = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      curQuoted = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    if (ch === ">") {
      // 2> / 1> / &> attach to the flushed fd token.
      if (
        (cur === "1" || cur === "2" || cur === "&") &&
        tokens.length >= 0 &&
        cur.length === 1
      ) {
        cur = "";
        curQuoted = false;
      } else {
        flush();
      }
      let j = i + 1;
      while (text[j] === ">") j += 1;
      if (j < text.length && text[j] !== " " && text[j] !== "\t") {
        const { end, quoted } = readUntilDelim(j);
        redirects.push({
          target: { text: text.slice(j, end).replace(/['"]/g, ""), quoted },
        });
        i = end - 1;
      } else {
        // Target is the next token — capture it directly.
        let k = j;
        while (k < text.length && (text[k] === " " || text[k] === "\t")) k += 1;
        const { end, quoted } = readUntilDelim(k);
        if (end > k) {
          redirects.push({
            target: { text: text.slice(k, end).replace(/['"]/g, ""), quoted },
          });
          i = end - 1;
        } else {
          i = j - 1;
        }
      }
      continue;
    }
    cur += ch;
  }
  flush();
  return { tokens, redirects };
}

function parseSegment(text: string): ParsedSegment {
  const { tokens: rawTokens, redirects } = tokenizeSegment(text);
  let tokens = rawTokens;
  // Strip leading env assignments (FOO=bar rm …).
  for (;;) {
    const head = tokens[0];
    if (!head || head.quoted || !ENV_ASSIGN_RE.test(head.text)) break;
    tokens = tokens.slice(1);
  }
  let sudoUsed = false;
  const rawName = tokens[0]?.text ?? "";
  for (;;) {
    const first = tokens[0];
    if (!first) break;
    if (!first.quoted && (first.text === "sudo" || first.text === "doas")) {
      sudoUsed = true;
      tokens = tokens.slice(1);
      // Skip sudo flags (and their arguments) up to the command.
      for (;;) {
        const t = tokens[0];
        if (!t) break;
        if (!t.quoted && t.text.startsWith("-")) {
          const consumed = SUDO_ARG_FLAGS.has(t.text);
          tokens = tokens.slice(1);
          if (consumed && tokens.length > 0) tokens = tokens.slice(1);
          continue;
        }
        break;
      }
      continue;
    }
    if (!first.quoted && first.text === "env") {
      tokens = tokens.slice(1);
      for (;;) {
        const t = tokens[0];
        if (!t || t.quoted || !ENV_ASSIGN_RE.test(t.text)) break;
        tokens = tokens.slice(1);
      }
      if (tokens[0]?.text === "--") tokens = tokens.slice(1);
      continue;
    }
    if (!first.quoted && WRAPPERS.has(first.text)) {
      tokens = tokens.slice(1);
      continue;
    }
    break;
  }
  return {
    text,
    tokens,
    redirects,
    name: tokens[0]?.text ?? "",
    rawName,
    sudoUsed,
  };
}

type ResolvedTarget =
  | { ok: true; path: string }
  | { ok: false; reason: "unresolvable" | "glob" };

function resolveTargetToken(
  token: RawToken,
  ctx: { home: string; cwd: string },
): ResolvedTarget {
  let t = token.text;
  if (t.length === 0) return { ok: false, reason: "unresolvable" };
  if (!token.quoted && GLOB_RE.test(t)) return { ok: false, reason: "glob" };
  if (t === "~") t = ctx.home;
  else if (t.startsWith("~/")) t = `${ctx.home}${t.slice(1)}`;
  else if (t.startsWith("~")) return { ok: false, reason: "unresolvable" };
  // Expand leading known variables ($HOME, ${HOME}, $PWD …).
  for (;;) {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(t);
    if (!m) break;
    const expander = EXPAND_VARS[m[1] ?? ""];
    if (!expander) return { ok: false, reason: "unresolvable" };
    t = expander(ctx) + t.slice(m[0].length);
  }
  if (t.includes("$")) return { ok: false, reason: "unresolvable" };
  return { ok: true, path: resolve(ctx.cwd, t) };
}

type RmParse = {
  force: boolean;
  recursive: boolean;
  operands: RawToken[];
};

function parseRm(tokens: readonly RawToken[]): RmParse | null {
  const force = new Set<string>();
  const operands: RawToken[] = [];
  let noMoreFlags = false;
  for (const tok of tokens.slice(1)) {
    if (!noMoreFlags && tok.text === "--") {
      noMoreFlags = true;
      continue;
    }
    if (
      !noMoreFlags &&
      !tok.quoted &&
      tok.text.startsWith("-") &&
      tok.text.length > 1
    ) {
      for (const ch of tok.text.slice(1)) force.add(ch);
      continue;
    }
    operands.push(tok);
  }
  return {
    force: force.has("f"),
    recursive: force.has("r") || force.has("R"),
    operands,
  };
}

/**
 * Expand an unquoted glob operand into an absolute pattern (pure string
 * work; no fs access — the Trash executor expands it at runtime, bounded).
 */
function expandGlobPattern(
  text: string,
  ctx: { home: string; cwd: string },
): { ok: true; pattern: string } | { ok: false } {
  let t = text;
  if (t.length === 0) return { ok: false };
  if (t === "~") t = ctx.home;
  else if (t.startsWith("~/")) t = `${ctx.home}${t.slice(1)}`;
  else if (t.startsWith("~")) return { ok: false };
  for (;;) {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(t);
    if (!m) break;
    const expander = EXPAND_VARS[m[1] ?? ""];
    if (!expander) return { ok: false };
    t = expander(ctx) + t.slice(m[0].length);
  }
  if (t.includes("$")) return { ok: false };
  return { ok: true, pattern: resolve(ctx.cwd, t) };
}

/**
 * Grade a glob pattern by its literal prefix (everything before the first
 * wildcard). A prefix that IS the workspace root is fine — that is the
 * common `rm build/*` shape (matches are root's children, inside the
 * workspace); system/sensitive/.git prefixes and prefixes outside the
 * workspace escalate.
 */
function gradeGlobPrefix(
  pattern: string,
  workspaceRoot: string,
  home: string,
): "workspace" | "outside" | "fatal" {
  const idx = pattern.search(/[*?]/);
  const prefix = (idx < 0 ? pattern : pattern.slice(0, idx)) || ".";
  const resolved = resolve(prefix);
  if (isSystemWipeTarget(resolved, home) || pathTargetsGitDir(resolved)) {
    return "fatal";
  }
  const zone = classifyPathTarget({
    absolutePath: resolved,
    workspaceRoot,
    homeDir: home,
  });
  if (zone === "workspace") return "workspace";
  if (zone === "sensitive") return "fatal";
  return "outside";
}

function localFinding(
  ruleId: string,
  severity: "fatal" | "confirm",
  reason: string,
  hint: string,
): ShellDangerFinding {
  return { ruleId, severity, reason, hint };
}

/** Class of a write-target command operand set (mv/cp/touch/mkdir/tee/ln). */
const MULTI_SOURCE_WRITERS = new Set(["cp", "mv", "ln", "rsync", "install"]);
const ALL_OPERAND_WRITERS = new Set(["touch", "mkdir", "tee", "truncate"]);

/**
 * Redirect targets that never count as outside writes (discard sinks).
 * Matched after resolve, case-insensitive.
 */
const SAFE_REDIRECT_TARGETS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

function isSafeRedirectTarget(path: string): boolean {
  const p = resolve(path).toLowerCase();
  if (SAFE_REDIRECT_TARGETS.has(p)) return true;
  if (p.startsWith("/dev/fd/")) return true;
  // Windows discard sink: "nul" / "NUL" resolves under any drive letter.
  return IS_WINDOWS && p.endsWith("\\nul");
}

export function analyzeShellCommand(
  command: string,
  options: AnalyzeShellCommandOptions,
): ShellCommandAnalysis {
  const home = options.homeDir ?? homedir();
  const cwd = resolve(options.workspacePath);
  const ctx = { home, cwd };
  const workspaceRoot = cwd;

  const { segments: rawSegments, hasSubstitution, parseError } =
    splitSegments(command);
  const segments = rawSegments.map(parseSegment);

  const findings: ShellDangerFinding[] = evaluateShellDangerRules({
    command,
    // Feed both the raw first token (sudo/env/wrapper rules) and the
    // stripped command name (the underlying command's rules).
    segments: segments.flatMap((s) => {
      const list = [{ name: s.name, text: s.text }];
      if (s.rawName !== s.name) list.unshift({ name: s.rawName, text: s.text });
      return list;
    }),
  });

  const add = (f: ShellDangerFinding) => {
    if (!findings.some((x) => x.ruleId === f.ruleId)) findings.push(f);
  };

  if (parseError) {
    add(
      localFinding(
        "shell-parse-uncertain",
        "confirm",
        "The command could not be parsed with confidence (unbalanced quotes or substitution).",
        "Simplify the command into plain, literal invocations.",
      ),
    );
  }

  // ---- rm analysis v2: Trash rewrite whenever every segment is pure rm ----
  let rewrite: ShellTrashRewrite | undefined;
  let rmUnrewritable = false;
  const rmSegments = segments.filter((s) => s.name === "rm");

  // A Trash rewrite replaces the whole command, so every segment must be a
  // pure rm (sudo/env wrappers already stripped into `name`): no pipes to
  // other commands, no redirects, no substitution, no parse errors.
  const allSegmentsPureRm =
    segments.length > 0 &&
    segments.every((s) => s.name === "rm" && s.redirects.length === 0);

  if (
    rmSegments.length > 0 &&
    (!allSegmentsPureRm || hasSubstitution || parseError)
  ) {
    rmUnrewritable = true;
    add(
      localFinding(
        "rm-unrewritable",
        "fatal",
        "rm is embedded in a command that cannot be safely routed to the Trash (substitution, pipes, redirects, or non-rm parts).",
        "Run rm as a standalone command (multiple rm segments are fine) so the delete is routed to the Trash.",
      ),
    );
  } else if (rmSegments.length > 0) {
    const targets: string[] = [];
    let allForce = true;
    let anyRm = false;
    let unresolvable = false;

    for (const seg of rmSegments) {
      const rm = parseRm(seg.tokens);
      if (!rm || rm.operands.length === 0) continue;
      anyRm = true;
      if (!rm.force) allForce = false;

      for (const operand of rm.operands) {
        const res = resolveTargetToken(operand, ctx);
        if (res.ok) {
          targets.push(res.path);
          if (
            isSystemWipeTarget(res.path, home) ||
            pathTargetsGitDir(res.path) ||
            res.path === workspaceRoot
          ) {
            add(
              localFinding(
                "rm-critical-target",
                "fatal",
                `rm target ${res.path} is a system path, version-control directory, or the workspace root itself.`,
                "Approving moves it to the Trash instead of deleting; prefer narrower targets.",
              ),
            );
          } else {
            const zone = classifyPathTarget({
              absolutePath: res.path,
              workspaceRoot,
              homeDir: home,
            });
            if (zone === "sensitive") {
              add(
                localFinding(
                  "rm-sensitive-target",
                  "fatal",
                  `rm target ${res.path} lies in a sensitive system location.`,
                  "Approving moves it to the Trash instead of deleting.",
                ),
              );
            } else if (zone === "outside") {
              add(
                localFinding(
                  "rm-outside-target",
                  "confirm",
                  `rm target ${res.path} lies outside the workspace trust domain.`,
                  "Approving moves it to the Trash instead of deleting.",
                ),
              );
            }
          }
          continue;
        }
        if (res.reason === "glob") {
          const g = expandGlobPattern(operand.text, ctx);
          if (!g.ok) {
            unresolvable = true;
            break;
          }
          targets.push(g.pattern);
          const grade = gradeGlobPrefix(g.pattern, workspaceRoot, home);
          if (grade === "fatal") {
            add(
              localFinding(
                "rm-critical-target",
                "fatal",
                `rm wildcard "${operand.text}" may match system, sensitive, or version-control paths.`,
                "Approving moves matches to the Trash instead of deleting; prefer narrower patterns.",
              ),
            );
          } else if (grade === "outside") {
            add(
              localFinding(
                "rm-outside-target",
                "confirm",
                `rm wildcard "${operand.text}" may match files outside the workspace trust domain.`,
                "Approving moves matches to the Trash instead of deleting.",
              ),
            );
          }
          continue;
        }
        // Non-glob unresolvable target (unknown $VAR, ~user …).
        unresolvable = true;
        break;
      }
      if (unresolvable) break;
    }

    if (unresolvable) {
      rmUnrewritable = true;
      add(
        localFinding(
          "rm-unresolvable-target",
          "fatal",
          "An rm target cannot be resolved to a literal path or simple glob — approving can never become a hard delete.",
          "Use literal paths or simple globs so the delete is routed to the Trash.",
        ),
      );
    } else if (anyRm) {
      rewrite = {
        type: "trash",
        targets,
        force: allForce,
        originalCommand: command,
      };
    }
  }

  // ---- chmod/chown -R escalation outside the workspace ----
  const chmodRecursive = findings.some((f) => f.ruleId === "chmod-chown-recursive");
  if (chmodRecursive) {
    for (const seg of segments) {
      if (seg.name !== "chmod" && seg.name !== "chown") continue;
      for (const tok of seg.tokens.slice(1)) {
        const res = resolveTargetToken(tok, ctx);
        if (!res.ok) continue;
        const zone = classifyPathTarget({
          absolutePath: res.path,
          workspaceRoot,
          homeDir: home,
        });
        if (zone !== "workspace") {
          add(
            localFinding(
              "chmod-recursive-outside",
              "fatal",
              `Recursive ${seg.name} targets ${res.path} outside the workspace — permission damage can be system-wide.`,
              "Scope recursive permission changes to workspace paths only.",
            ),
          );
          break;
        }
      }
    }
  }

  // ---- write targets outside the workspace (redirects / mv / cp / …) ----
  const noteOutsideWrite = (path: string, what: string) => {
    add(
      localFinding(
        "write-outside-workspace",
        "confirm",
        `${what} writes to ${path}, outside the workspace trust domain.`,
        "Prefer writing inside the workspace, or let the user approve this path.",
      ),
    );
  };
  for (const seg of segments) {
    for (const red of seg.redirects) {
      const res = resolveTargetToken(red.target, ctx);
      if (!res.ok) continue;
      if (isSafeRedirectTarget(res.path)) continue;
      const zone = classifyPathTarget({
        absolutePath: res.path,
        workspaceRoot,
        homeDir: home,
      });
      if (zone !== "workspace") {
        noteOutsideWrite(res.path, `A redirect in "${seg.text.trim()}"`);
      }
    }
    const name = seg.name;
    if (MULTI_SOURCE_WRITERS.has(name) || ALL_OPERAND_WRITERS.has(name)) {
      const operands = seg.tokens
        .slice(1)
        .filter((t) => t.quoted || !t.text.startsWith("-") || t.text === "--");
      const targets =
        MULTI_SOURCE_WRITERS.has(name) && operands.length >= 2
          ? operands.slice(-1)
          : operands;
      for (const tok of targets) {
        const res = resolveTargetToken(tok, ctx);
        if (!res.ok) continue;
        const zone = classifyPathTarget({
          absolutePath: res.path,
          workspaceRoot,
          homeDir: home,
        });
        if (zone !== "workspace") {
          noteOutsideWrite(res.path, `${name} destination`);
        }
      }
    }
  }

  return {
    riskClass: worstSeverity(findings),
    findings,
    ...(rewrite ? { rewrite } : {}),
    ...(rmUnrewritable ? { rmUnrewritable: true } : {}),
  };
}
