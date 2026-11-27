import { resolve, sep } from "node:path";
import { IS_WINDOWS } from "../../platformCaps.js";


export type ShellRiskClass = "normal" | "confirm" | "fatal";
export type ShellDangerSeverity = "fatal" | "confirm";

export type ShellDangerFinding = {
  ruleId: string;
  severity: ShellDangerSeverity;
  reason: string;
  hint: string;
};

export type SimpleCommandSegment = {
  text: string;
  name: string;
};

export type ShellDangerRule = {
  id: string;
  severity: ShellDangerSeverity;
  reason: string;
  hint: string;
  commandNames?: readonly string[];
  commandPrefixes?: readonly string[];
  segmentPatterns?: readonly RegExp[];
  commandPatterns?: readonly RegExp[];
};

export const FATAL_RULES: readonly ShellDangerRule[] = [
  {
    id: "mkfs-newfs",
    severity: "fatal",
    reason: "Formats a filesystem — all data on the target is destroyed.",
    hint: "Ask the user to format disks in Disk Utility instead.",
    commandPrefixes: ["mkfs", "newfs"],
  },
  {
    id: "diskutil-destructive",
    severity: "fatal",
    reason:
      "diskutil erase/zero/secureErase destroys the target disk or volume.",
    hint: "Ask the user to run destructive diskutil commands themselves.",
    commandNames: ["diskutil"],
    segmentPatterns: [
      /\b(erase\w*|zeroDisk|secureErase\w*|deleteContainer|splitPartition)\b/i,
    ],
  },
  {
    id: "dd-raw-device",
    severity: "fatal",
    reason: "dd writing to a raw device node overwrites the whole disk.",
    hint: "Write images to regular files, or ask the user to flash the disk.",
    commandNames: ["dd"],
    segmentPatterns: [
      /\bof=\/dev\/(?!null\b)(disk|rdisk|nvme\d|sd[a-z]|hd[a-z]|mmcblk)/i,
    ],
  },
  {
    id: "power-control",
    severity: "fatal",
    reason: "Powers off / reboots the machine, killing every running session.",
    hint: "Ask the user to restart the machine themselves.",
    commandNames: ["shutdown", "reboot", "halt", "poweroff"],
  },
  {
    id: "sudo-power-control",
    severity: "fatal",
    reason: "Runs a shutdown / reboot with superuser privileges.",
    hint: "Ask the user to restart the machine themselves.",
    commandNames: ["sudo", "doas"],
    segmentPatterns: [/\b(shutdown|reboot|halt|poweroff)\b/i],
  },
  {
    id: "fork-bomb",
    severity: "fatal",
    reason: "Fork bomb — exhausts process slots and wedges the system.",
    hint: "Remove this; it is never a legitimate build step.",
    commandPatterns: [
      /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/,
      /:\s*\|\s*:\s*&/,
    ],
  },
] as const;

export const WINDOWS_DELETE_RULES: readonly ShellDangerRule[] = [
  {
    id: "windows-delete",
    severity: "confirm",
    reason:
      "del/erase/rd/rmdir/Remove-Item permanently deletes files — no Trash routing on Windows v1.",
    hint: "List the targets first; confirm destructive scope with the user.",
    commandPatterns: [/(^|[^\w.-])(del|erase|rd|rmdir|remove-item)(\s|$)/i],
  },
];

export const CONFIRM_RULES: readonly ShellDangerRule[] = [
  {
    id: "pipe-download-to-shell",
    severity: "confirm",
    reason: "Downloads piped straight into a shell execute remote code unseen.",
    hint: "Download to a file, review it, then run it.",
    commandPatterns: [
      /\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+|env\s+|xargs\s+)?(ba|z|da|a)?sh\b/,
    ],
  },
  {
    id: "sudo-any",
    severity: "confirm",
    reason: "Runs with superuser privileges — mistakes are system-wide.",
    hint: "Prefer a command without sudo.",
    commandNames: ["sudo", "doas"],
  },
  {
    id: "dd-any",
    severity: "confirm",
    reason: "dd performs raw, unforgiving device/file I/O.",
    hint: "Prefer cp / ditto for file copies.",
    commandNames: ["dd"],
  },
  {
    id: "killall-pkill",
    severity: "confirm",
    reason:
      "Kills processes by name — may take down user apps or the wrong service.",
    hint: "Kill a specific PID after listing candidates.",
    commandNames: ["killall", "pkill"],
  },
  {
    id: "git-push-force",
    severity: "confirm",
    reason: "Force push rewrites remote history others may depend on.",
    hint: "Push normally, or use --force-with-lease.",
    commandNames: ["git"],
    segmentPatterns: [/\bpush\b[^;&|]*\s(--force(?!-with-lease)|-f)(?=\s|$)/],
  },
  {
    id: "git-reset-hard",
    severity: "confirm",
    reason: "Hard reset discards uncommitted work with no recovery.",
    hint: "Prefer git stash or a soft reset.",
    commandNames: ["git"],
    segmentPatterns: [/\breset\b[^;&|]*\s--hard(?=\W|$)/],
  },
  {
    id: "git-clean-force",
    severity: "confirm",
    reason: "git clean -f deletes untracked files permanently.",
    hint: "List with git clean -n first; prefer moving files to Trash.",
    commandNames: ["git"],
    segmentPatterns: [/\bclean\b[^;&|]*\s-f(?=\w|\s|$)/],
  },
  {
    id: "git-branch-force-delete",
    severity: "confirm",
    reason: "Force-deleting a branch can discard unmerged commits.",
    hint: "Use lowercase -d so git refuses unmerged branches.",
    commandNames: ["git"],
    segmentPatterns: [/\bbranch\b[^;&|]*\s-D(?=\w|\s|$)/],
  },
  {
    id: "chmod-chown-recursive",
    severity: "confirm",
    reason: "Recursive chmod/chown can break system or app permissions.",
    hint: "Scope the change to workspace files only.",
    commandNames: ["chmod", "chown"],
    segmentPatterns: [/\s-R[fhlpH]*(?=\s|$)/, /\s--recursive(?=\s|$)/],
  },
  {
    id: "find-delete",
    severity: "confirm",
    reason: "find -delete permanently removes matched files.",
    hint: "Prefer rm with literal paths — those are routed to the Trash.",
    commandNames: ["find"],
    segmentPatterns: [/\s-delete(?=\s|$)/],
  },
  {
    id: "indirect-rm",
    severity: "confirm",
    reason: "rm invoked through a wrapper command bypasses the Trash rewrite.",
    hint: "Run rm directly with literal paths so deletions go to the Trash.",
    commandNames: [
      "xargs",
      "sh",
      "bash",
      "zsh",
      "dash",
      "ksh",
      "timeout",
      "nohup",
      "parallel",
      "env",
      "time",
    ],
    segmentPatterns: [/(^|[\s;"'])rm(\s|$)/],
  },
  ...(IS_WINDOWS ? WINDOWS_DELETE_RULES : []),
];

function nameMatches(rule: ShellDangerRule, name: string): boolean {
  if (rule.commandNames?.includes(name)) return true;
  if (rule.commandPrefixes?.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  return false;
}

function segmentMatches(
  rule: ShellDangerRule,
  segment: SimpleCommandSegment,
): boolean {
  if (!nameMatches(rule, segment.name)) return false;
  if (!rule.segmentPatterns) return true;
  return rule.segmentPatterns.some((re) => re.test(segment.text));
}

export function evaluateShellDangerRules(input: {
  command: string;
  segments: readonly SimpleCommandSegment[];
  rules?: readonly ShellDangerRule[];
}): ShellDangerFinding[] {
  const findings: ShellDangerFinding[] = [];
  const seen = new Set<string>();
  const all = input.rules ?? [...FATAL_RULES, ...CONFIRM_RULES];
  for (const rule of all) {
    let matched =
      rule.commandPatterns?.some((re) => re.test(input.command)) ?? false;
    if (!matched) {
      matched = input.segments.some((seg) => segmentMatches(rule, seg));
    }
    if (matched && !seen.has(rule.id)) {
      seen.add(rule.id);
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        reason: rule.reason,
        hint: rule.hint,
      });
    }
  }
  return findings;
}

const SEVERITY_RANK: Record<ShellDangerSeverity, number> = {
  confirm: 1,
  fatal: 2,
};

const CLASS_RANK: Record<ShellRiskClass, number> = {
  normal: 0,
  confirm: 1,
  fatal: 2,
};

export function worstSeverity(
  findings: readonly ShellDangerFinding[],
): ShellRiskClass {
  let worst: ShellRiskClass = "normal";
  for (const f of findings) {
    if (CLASS_RANK[f.severity] > CLASS_RANK[worst]) worst = f.severity;
  }
  return worst;
}

export function worstFinding(
  findings: readonly ShellDangerFinding[],
): ShellDangerFinding | null {
  let best: ShellDangerFinding | null = null;
  for (const f of findings) {
    if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best.severity]) {
      best = f;
    }
  }
  return best;
}

const SYSTEM_WIPE_ROOTS: ReadonlySet<string> = new Set([
  "/users",
  "/system",
  "/library",
  "/applications",
  "/private",
  "/etc",
  "/usr",
  "/var",
  "/bin",
  "/sbin",
  "/opt",
  "/home",
  "/volumes",
]);

const WINDOWS_SYSTEM_WIPE_ROOTS = new Set([
  "\\windows",
  "\\program files",
  "\\program files (x86)",
  "\\programdata",
  "\\users",
  "\\system volume information",
  "\x5crecovery",
]);

export function isSystemWipeTarget(
  absolutePath: string,
  homeDir: string,
): boolean {
  const p = resolve(absolutePath).toLowerCase().replace(/[\\/]+$/, "") || "/";
  const home = resolve(homeDir).toLowerCase().replace(/[\\/]+$/, "");
  if (IS_WINDOWS) {
    if (/^[a-z]:$/.test(p)) return true;
    if (p === home) return true;
    return WINDOWS_SYSTEM_WIPE_ROOTS.has(p.slice(2));
  }
  if (p === "/") return true;
  if (p === home) return true;
  return SYSTEM_WIPE_ROOTS.has(p);
}

export function pathTargetsGitDir(absolutePath: string): boolean {
  return resolve(absolutePath).split(sep).includes(".git");
}
