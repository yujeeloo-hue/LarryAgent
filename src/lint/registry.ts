import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LintRule, LintSeverity } from "./types.js";

const RULE_FILE_RE = /\.(?:ts|mjs|js)$/;
const IGNORED_RULE_FILE_RE = /\.(?:test|spec|d)\.(?:ts|mjs|js)$/;
const RULE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export class LintRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LintRegistryError";
  }
}

function isSeverity(value: unknown): value is LintSeverity {
  return value === "error" || value === "warn";
}

export function validateRule(value: unknown, source: string): LintRule {
  if (typeof value !== "object" || value === null) {
    throw new LintRegistryError(`${source} must default-export a lint rule object`);
  }
  const rule = value as Partial<LintRule>;
  if (typeof rule.id !== "string" || !RULE_ID_RE.test(rule.id)) {
    throw new LintRegistryError(`${source} needs a kebab-case "id"`);
  }
  if (typeof rule.title !== "string" || !rule.title.trim()) {
    throw new LintRegistryError(`${source} needs a non-empty "title"`);
  }
  if (!isSeverity(rule.severity)) {
    throw new LintRegistryError(`${source} needs "severity": "error" | "warn"`);
  }
  if (rule.include !== undefined) {
    const include = rule.include as unknown;
    if (!Array.isArray(include) || include.some((item) => typeof item !== "string" || !item.trim())) {
      throw new LintRegistryError(`${source} "include" must be a list of glob strings`);
    }
  }
  if (typeof rule.check !== "function") {
    throw new LintRegistryError(`${source} needs a "check(context)" function`);
  }
  return {
    id: rule.id,
    title: rule.title.trim(),
    severity: rule.severity,
    check: rule.check,
    ...(rule.include ? { include: rule.include } : {}),
  };
}

export async function listRuleFiles(rulesDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rulesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !name.startsWith("_"))
    .filter((name) => RULE_FILE_RE.test(name) && !IGNORED_RULE_FILE_RE.test(name))
    .sort()
    .map((name) => join(rulesDir, name));
}

export async function loadRules(rulesDir: string): Promise<LintRule[]> {
  const files = await listRuleFiles(rulesDir);
  const rules: LintRule[] = [];
  const origins = new Map<string, string>();
  for (const file of files) {
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const rule = validateRule(module.default, file);
    const previous = origins.get(rule.id);
    if (previous) {
      throw new LintRegistryError(`duplicate lint rule id "${rule.id}" (${previous} and ${file})`);
    }
    origins.set(rule.id, file);
    rules.push(rule);
  }
  return rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
