export type UnrealProject = {
  id: string;
  name: string;
  path: string;
  sourceRoot: string;
  kind: "native" | "managed";
};

export type UnrealBuildChoice = {
  id: string;
  solution: string;
  project: string;
  target: string;
  targetType: string;
  configuration: string;
  platform: string;
  architecture: string;
  engineRoot: string;
  projectRoot: string;
  uproject: string | null;
  kind: "native" | "managed" | "custom";
  managedAdapter?: { path: string; args: string[] };
  additionalTargets?: Array<{ target: string; platform: string; configuration: string }>;
  command: string;
  rebuildCommand?: string;
  cleanCommand?: string;
  output: string | null;
  buildReason: string | null;
  runReason: string | null;
  debugReason: string | null;
  runNote?: string;
  skipBuild?: boolean;
};

export type UnrealWorkspace = {
  workspacePath: string;
  engineRoot: string | null;
  projects: UnrealProject[];
  choices: UnrealBuildChoice[];
  selectedId: string | null;
  hasChoices: boolean;
  warnings: string[];
};

export type UnrealWorkspaceResult =
  | { ok: true; workspace: UnrealWorkspace | null }
  | { ok: false; message: string };
