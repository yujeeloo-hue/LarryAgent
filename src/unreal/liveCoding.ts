import type { UnrealBuildChoice } from "./workspaceTypes.js";

export type LiveCodingChoice = Pick<
  UnrealBuildChoice,
  "id" | "kind" | "targetType" | "buildReason" | "skipBuild" | "uproject" | "command" | "rebuildCommand" | "cleanCommand"
>;

export function supportsUnrealLiveCoding(
  choice: Pick<LiveCodingChoice, "kind" | "targetType" | "buildReason" | "skipBuild" | "uproject">,
  os: NodeJS.Platform = process.platform,
): boolean {
  return os === "win32"
    && choice.kind === "native"
    && choice.targetType === "Editor"
    && !choice.buildReason
    && !choice.skipBuild
    && !!choice.uproject;
}

export function withLiveCodingFlag(command: string): string {
  return command.split(" && ").map(part => {
    if (!part.trim() || /(?:^|\s)-LiveCoding(?:\s|$)/.test(part)) return part;
    return `${part} -LiveCoding`;
  }).join(" && ");
}

export function unrealBuildCommand(
  choice: Pick<LiveCodingChoice, "kind" | "targetType" | "buildReason" | "skipBuild" | "uproject" | "command" | "rebuildCommand" | "cleanCommand">,
  operation: string | undefined,
  os: NodeJS.Platform = process.platform,
): string | undefined {
  if (operation === "rebuild") return choice.rebuildCommand;
  if (operation === "clean") return choice.cleanCommand;
  if (operation === "liveCoding") {
    if (!supportsUnrealLiveCoding(choice, os) || !choice.command) return undefined;
    return withLiveCodingFlag(choice.command);
  }
  return choice.command;
}
