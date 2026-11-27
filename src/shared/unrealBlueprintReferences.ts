export type UnrealBlueprintReferenceKind =
  | "call"
  | "event_override"
  | "parent_class"
  | "cast"
  | "variable_type"
  | "class_pin";

export type UnrealBlueprintReference = {
  kind: UnrealBlueprintReferenceKind;
  assetPath: string;
  graph?: string;
  graphGuid?: string;
  nodeClass?: string;
  nodeGuid?: string;
  nodeTitle?: string;
};

export type UnrealBlueprintSymbol =
  | { kind: "class"; className: string }
  | { kind: "function"; className: string; name: string };

export type UnrealBlueprintReferencesResult =
  | { status: "unavailable" }
  | { status: "not_ready" }
  | { status: "ok"; complete: boolean; references: UnrealBlueprintReference[] }
  | { status: "failed"; message: string };

export type UnrealBlueprintOpenTarget = {
  assetPath: string;
  graphGuid?: string;
  nodeGuid?: string;
};

export type UnrealBlueprintOpenResult = { ok: true } | { ok: false; message: string };

export type UnrealBlueprintSelectTarget = {
  assetPath: string;
};

export type UnrealBlueprintSelectResult =
  | { status: "ok" }
  | { status: "unsupported" }
  | { status: "unavailable" }
  | { status: "failed"; message: string };
