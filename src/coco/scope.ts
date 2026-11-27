import type { CocoRule, CocoSettings } from "./types.js";

export function ruleCovers(rule: Pick<CocoRule, "scope">, workspaceId: string): boolean {
  return !rule.scope.excludedWorkspaceIds.includes(workspaceId) && (rule.scope.all || rule.scope.workspaceIds.includes(workspaceId));
}

export function inCocoScope(settings: Pick<CocoSettings, "excludedWorkspaceIds">, workspaceId: string, rule?: Pick<CocoRule, "scope">): boolean {
  return !settings.excludedWorkspaceIds.includes(workspaceId) && (!rule || ruleCovers(rule, workspaceId));
}

export function rulesCover(rules: readonly (CocoRule | undefined)[], workspaceId: string): boolean {
  return rules.every(rule => rule !== undefined && ruleCovers(rule, workspaceId));
}

export function ruleAuthorizes(rule: CocoRule | undefined, workspaceId: string): boolean {
  return Boolean(rule?.enabled && rule.confirmed && ruleCovers(rule, workspaceId));
}

export function executionAuthority(settings: Pick<CocoSettings, "enabled" | "excludedWorkspaceIds">): { enabled: boolean; excludedWorkspaceIds: string[] } {
  return { enabled: settings.enabled, excludedWorkspaceIds: settings.excludedWorkspaceIds };
}
export function sameExecutionAuthority(a: Pick<CocoSettings, "enabled" | "excludedWorkspaceIds">, b: Pick<CocoSettings, "enabled" | "excludedWorkspaceIds">): boolean {
  return JSON.stringify(executionAuthority(a)) === JSON.stringify(executionAuthority(b));
}

export function deniedWorkspacePaths(workspaces: readonly { id: string; path: string }[], settings: Pick<CocoSettings, "excludedWorkspaceIds">, rules: readonly (CocoRule | undefined)[] = []): string[] {
  return workspaces.filter(w => !inCocoScope(settings, w.id) || !rulesCover(rules, w.id)).map(w => w.path);
}

export function siblingWorkspacePaths(workspaces: readonly { id: string; path: string }[], ownWorkspaceId: string, settings: Pick<CocoSettings, "excludedWorkspaceIds">, rules: readonly (CocoRule | undefined)[] = []): string[] {
  return workspaces.filter(w => w.id !== ownWorkspaceId && inCocoScope(settings, w.id) && rulesCover(rules, w.id)).map(w => w.path);
}
