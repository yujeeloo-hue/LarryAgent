
import type { CppIndexCompletionHit, CppTextCompletionItem } from "./cppTextCompletion.js";


export type UeReflectionMacroName =
  | "UCLASS"
  | "UDELEGATE"
  | "UENUM"
  | "UFUNCTION"
  | "UINTERFACE"
  | "UMETA"
  | "UPARAM"
  | "UPROPERTY"
  | "USTRUCT";

export type UeSpecifierValueKind =
  | "function"
  | "bool";

export type UeSpecifier = {
  name: string;
  doc: string;
  value?: UeSpecifierValueKind;
  snippet?: string;
};

const PROPERTY_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "AdvancedDisplay", doc: "Collapse into the advanced rollout" },
  { name: "AssetRegistrySearchable", doc: "Expose the value to the asset registry" },
  { name: "BlueprintAssignable", doc: "Expose a delegate property as an assignable event" },
  { name: "BlueprintAuthorityOnly", doc: "Blueprint may only change it on the authority" },
  { name: "BlueprintGetter", doc: "Blueprint accessor function name", value: "function" },
  { name: "BlueprintReadOnly", doc: "Readable from Blueprint, not writable" },
  { name: "BlueprintReadWrite", doc: "Readable and writable from Blueprint" },
  { name: "BlueprintSetter", doc: "Blueprint mutator function name", value: "function" },
  { name: "Category", doc: "Details panel category" },
  { name: "Config", doc: "Load the value from ini files" },
  { name: "DuplicateTransient", doc: "Not copied when an object is duplicated" },
  { name: "EditAnywhere", doc: "Editable on the archetype and on instances" },
  { name: "EditDefaultsOnly", doc: "Editable on the archetype only" },
  { name: "EditFixedSize", doc: "Array size is fixed in the details panel" },
  { name: "EditInlineNew", doc: "Allow new object instances inline" },
  { name: "EditInstanceOnly", doc: "Editable on instances only" },
  { name: "Export", doc: "Exported when copying to text" },
  { name: "ExposeOnSpawn", doc: "Exposed as a spawn parameter" },
  { name: "ExposeFunctionOnSpawn", doc: "Legacy alias of ExposeOnSpawn" },
  { name: "GlobalConfig", doc: "Load from the global config hierarchy" },
  { name: "Instanced", doc: "Per-instance copies of an instanced object" },
  { name: "Interp", doc: "Legacy: animate through Matinee" },
  { name: "Localized", doc: "Value is localized text" },
  { name: "meta", doc: "Editor metadata keys", snippet: "meta=($0)" },
  { name: "Native", doc: "Declared natively in the reflection body" },
  { name: "NoClear", doc: "No clear button in the details panel" },
  { name: "NoExport", doc: "Skip UHT code generation" },
  { name: "NonPIEDuplicateTransient", doc: "Not copied when duplicating outside PIE" },
  { name: "NonTransactional", doc: "Changes stay out of the undo stack" },
  { name: "NotReplicated", doc: "Skip replication even on a replicated class" },
  { name: "Replicated", doc: "Replicate to clients" },
  { name: "ReplicatedUsing", doc: "Replicate and call this OnRep function", value: "function" },
  { name: "SaveGame", doc: "Include in save games" },
  { name: "SimpleDisplay", doc: "Show in the details panel without expanding" },
  { name: "SkipSerialization", doc: "Skip serialization" },
  { name: "TextExportTransient", doc: "Not exported to text" },
  { name: "Transient", doc: "Not saved or serialized" },
  { name: "VisibleAnywhere", doc: "Visible on the archetype and on instances" },
  { name: "VisibleDefaultsOnly", doc: "Visible on the archetype only" },
  { name: "VisibleInstanceOnly", doc: "Visible on instances only" },
];

const FUNCTION_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "BlueprintAuthorityOnly", doc: "Executes on the authority only" },
  { name: "BlueprintCallable", doc: "Callable from Blueprint" },
  { name: "BlueprintCosmetic", doc: "Skipped on a dedicated server" },
  { name: "BlueprintImplementableEvent", doc: "Implemented in Blueprint" },
  { name: "BlueprintNativeEvent", doc: "C++ default with an optional Blueprint override" },
  { name: "BlueprintPure", doc: "No exec pins, no side effects" },
  { name: "CallInEditor", doc: "Show a button in the details panel" },
  { name: "Category", doc: "Details panel category" },
  { name: "Client", doc: "Runs on the owning client" },
  { name: "CustomThunk", doc: "Provide a manual thunk in C++" },
  { name: "Exec", doc: "Callable from the console" },
  { name: "FieldNotify", doc: "Broadcast to field notifications / view models" },
  { name: "meta", doc: "Editor metadata keys", snippet: "meta=($0)" },
  { name: "NetMulticast", doc: "Runs on the server and all clients" },
  { name: "Reliable", doc: "Guaranteed delivery when replicated" },
  { name: "SealedEvent", doc: "Cannot be overridden in Blueprint" },
  { name: "Server", doc: "Runs on the server" },
  { name: "Unreliable", doc: "May be dropped when replicated" },
  { name: "WithValidation", doc: "Pair with an _Validate function" },
];

const CLASS_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "Abstract", doc: "Cannot be spawned or placed directly" },
  { name: "AutoCollapseCategories", doc: "Collapse these categories by default" },
  { name: "AutoExpandCategories", doc: "Expand these categories by default" },
  { name: "Blueprintable", doc: "Blueprint classes may derive from it" },
  { name: "BlueprintType", doc: "Usable as a Blueprint variable type" },
  { name: "ClassGroup", doc: "Group shown in the class picker" },
  { name: "CollapseCategories", doc: "Collapse every category" },
  { name: "Config", doc: "Read defaults from ini files" },
  { name: "DefaultConfig", doc: "Subclass-specific ini section" },
  { name: "Deprecated", doc: "Mark the class as deprecated" },
  { name: "DontCollapseCategories", doc: "Never collapse categories" },
  { name: "Experimental", doc: "Flag as experimental" },
  { name: "GlobalUserConfig", doc: "Read defaults from the user config" },
  { name: "HideCategories", doc: "Hide these categories" },
  { name: "meta", doc: "Editor metadata keys", snippet: "meta=($0)" },
  { name: "MinimalAPI", doc: "Only export the class declaration" },
  { name: "NotBlueprintable", doc: "Blueprint subclasses are rejected" },
  { name: "ShowCategories", doc: "Force these categories visible" },
  { name: "Transient", doc: "Never saved" },
  { name: "Within", doc: "Only valid as a subobject of this outer class" },
];

const STRUCT_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "Atomic", doc: "Serialize as one unit" },
  { name: "BlueprintType", doc: "Usable as a Blueprint variable type" },
  { name: "Immutable", doc: "Cannot be edited after construction" },
  { name: "meta", doc: "Editor metadata keys", snippet: "meta=($0)" },
  { name: "NoExport", doc: "Skip UHT code generation" },
];

const ENUM_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "BlueprintType", doc: "Usable as a Blueprint variable type" },
  { name: "meta", doc: "Editor metadata keys", snippet: "meta=($0)" },
];

const INTERFACE_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "Blueprintable", doc: "Blueprint classes may implement it" },
  { name: "DependsOn", doc: "Compile after this type" },
  { name: "Experimental", doc: "Flag as experimental" },
  { name: "meta", doc: "Editor metadata keys", snippet: "meta=($0)" },
  { name: "MinimalAPI", doc: "Only export the class declaration" },
];

const PARAM_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "DisplayName", doc: "Pin name in Blueprint" },
  { name: "meta", doc: "Editor metadata keys", snippet: "meta=($0)" },
  { name: "ref", doc: "Pass by reference in Blueprint" },
];

const DELEGATE_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "BlueprintAuthorityOnly", doc: "Fires on the authority only" },
  { name: "BlueprintCallable", doc: "Callable from Blueprint" },
  { name: "BlueprintPure", doc: "No exec pins" },
  { name: "meta", doc: "Editor metadata keys", snippet: "meta=($0)" },
];

export const UE_META_SPECIFIERS: readonly UeSpecifier[] = [
  { name: "AdvancedClassDisplay", doc: "Only show the class in the advanced picker" },
  { name: "AdvancedDisplay", doc: "Collapse into the advanced rollout" },
  { name: "AllowAbstract", doc: "Allow abstract classes in a class property" },
  { name: "AllowPrivateAccess", doc: "Allow a private property in Blueprint" },
  { name: "AllowedClasses", doc: "Restrict which classes the property accepts" },
  { name: "ArrayClamp", doc: "Clamp an int against an array size" },
  { name: "AssetBundles", doc: "Assign these asset bundles" },
  { name: "AutoCreateRefTerm", doc: "Create a temporary for a const-ref pin" },
  { name: "BindWidget", doc: "Bind a required widget by name" },
  { name: "BindWidgetAnim", doc: "Bind a required widget animation" },
  { name: "BindWidgetOptional", doc: "Bind an optional widget by name" },
  { name: "Bitmask", doc: "Treat an int as a bitmask" },
  { name: "BitmaskEnum", doc: "Enum describing the bitmask flags" },
  { name: "BlueprintInternalUseOnly", doc: "Hide the node from Blueprint" },
  { name: "BlueprintProtected", doc: "Only callable from the owning Blueprint" },
  { name: "BlueprintSpawnableComponent", doc: "Offer the component in Add Component" },
  { name: "BlueprintThreadSafe", doc: "Safe to call on a non-game thread" },
  { name: "Categories", doc: "Extra categories for the node" },
  { name: "ClampMax", doc: "Maximum slider value" },
  { name: "ClampMin", doc: "Minimum slider value" },
  { name: "Column", doc: "Column header of a struct property" },
  { name: "Comment", doc: "Comment shown on the node" },
  { name: "ConfigHierarchyEditable", doc: "Editable through the config hierarchy" },
  { name: "Console", doc: "Auto-register a console command" },
  { name: "DeprecatedFunction", doc: "Scripts get a deprecation warning" },
  { name: "DeprecatedProperty", doc: "Scripts get a deprecation warning" },
  { name: "DevelopmentOnly", doc: "Strip the property from shipping builds" },
  { name: "DisplayAfter", doc: "Show after this property" },
  { name: "DisplayName", doc: "Pin / details panel name" },
  { name: "DisplayPriority", doc: "Ordering inside the category" },
  { name: "DisplayThumbnail", doc: "Show an asset thumbnail" },
  { name: "EditCondition", doc: "Only editable while this bool is true", value: "bool" },
  { name: "EditConditionHides", doc: "Hide when the EditCondition fails" },
  { name: "EditFixedOrder", doc: "Keep array order fixed in the panel" },
  { name: "ExactClass", doc: "Reject subclasses of the property type" },
  { name: "ExposeFunctionCategories", doc: "Expose these categories on the node" },
  { name: "ExposeOnSpawn", doc: "Exposed as a spawn parameter" },
  { name: "FilePathFilter", doc: "File picker filter for a path property" },
  { name: "FixedIncrement", doc: "Slider step size" },
  { name: "ForceShowEngineContent", doc: "Picker includes engine content" },
  { name: "ForceUnits", doc: "Units suffix for the value" },
  { name: "GetOptions", doc: "Function returning the allowed values" },
  { name: "HideAlphaChannel", doc: "Hide alpha on a color property" },
  { name: "HideAssetPicker", doc: "Hide the asset picker button" },
  { name: "HideCategories", doc: "Hide these categories" },
  { name: "HideDropdown", doc: "Hide the enum dropdown" },
  { name: "Hidden", doc: "Hide the enum entry from the panel" },
  { name: "HidePin", doc: "Hide the pin on the node" },
  { name: "ImportantToggleSetting", doc: "Show the toggle above categories" },
  { name: "InlineEditConditionToggle", doc: "Pair the bool with this property" },
  { name: "Keywords", doc: "Extra search keywords in the panel" },
  { name: "Latent", doc: "Latent node with a LatentInfo parameter" },
  { name: "LatentInfo", doc: "Parameter carrying the latent action" },
  { name: "LongPackageName", doc: "Property holds a long package name" },
  { name: "MakeEditWidget", doc: "Editable world-space widget" },
  { name: "MakeStructureDefaultValue", doc: "Default for a struct pin" },
  { name: "MustImplement", doc: "Interface the class value must implement" },
  { name: "NativeBreakFunc", doc: "Native break function for the struct" },
  { name: "NativeMakeFunc", doc: "Native make function for the struct" },
  { name: "NoClear", doc: "No clear button for the property" },
  { name: "NoResetToDefault", doc: "No reset to default arrow" },
  { name: "NoSpinbox", doc: "Hide the numeric spinbox" },
  { name: "PinDisplayName", doc: "Pin name on the node" },
  { name: "PinHiddenByDefault", doc: "Pin starts hidden" },
  { name: "PinShownByDefault", doc: "Pin starts visible" },
  { name: "RelativeToGameContentDir", doc: "Path picker starts in Content" },
  { name: "RequiredAssetDataTags", doc: "Asset registry tag requirements" },
  { name: "ScriptName", doc: "Name used by script / Python" },
  { name: "ShowTreeView", doc: "Show a class picker tree" },
  { name: "SliderExponent", doc: "Slider response curve" },
  { name: "TitleProperty", doc: "Struct field shown as the array row title" },
  { name: "ToolTip", doc: "Tooltip in the details panel" },
  { name: "TrimWhitespace", doc: "Trim surrounding whitespace on input" },
  { name: "UIMax", doc: "Maximum slider value (UI only)" },
  { name: "UIMin", doc: "Minimum slider value (UI only)" },
  { name: "Units", doc: "Units suffix for the value" },
];

export const UE_SPECIFIERS: Readonly<Record<UeReflectionMacroName, readonly UeSpecifier[]>> = {
  UCLASS: CLASS_SPECIFIERS,
  UDELEGATE: DELEGATE_SPECIFIERS,
  UENUM: ENUM_SPECIFIERS,
  UFUNCTION: FUNCTION_SPECIFIERS,
  UINTERFACE: INTERFACE_SPECIFIERS,
  UMETA: UE_META_SPECIFIERS,
  UPARAM: PARAM_SPECIFIERS,
  UPROPERTY: PROPERTY_SPECIFIERS,
  USTRUCT: STRUCT_SPECIFIERS,
};

export const UE_REFLECTION_MACRO_NAMES = Object.keys(UE_SPECIFIERS) as UeReflectionMacroName[];

export const UE_SPECIFIER_ALIAS_SPELLINGS = [
  "config",
  "customconstructor",
  "hidecategories",
  "showcategories",
] as const;

export function ueSpecifierVocabulary(): string[] {
  const words = new Set<string>();
  for (const list of Object.values(UE_SPECIFIERS)) {
    for (const specifier of list) words.add(specifier.name);
  }
  for (const alias of UE_SPECIFIER_ALIAS_SPELLINGS) words.add(alias);
  return [...words].sort();
}

export function isUeSpecifierName(word: string): boolean {
  for (const list of Object.values(UE_SPECIFIERS)) {
    if (list.some((specifier) => specifier.name === word)) return true;
  }
  return (UE_SPECIFIER_ALIAS_SPELLINGS as readonly string[]).includes(word);
}

export function isUeBoolName(word: string): boolean {
  return /^b[A-Z][A-Za-z0-9_]*[a-z]/.test(word);
}


export type UeReflectionZone =
  | "specifier"
  | "meta"
  | "value";

export type UeReflectionContext = {
  macro: UeReflectionMacroName;
  zone: UeReflectionZone;
  specifier?: string;
  quoted?: boolean;
};

function maskNonCode(text: string, caret: number): { masked: string; inString: boolean; inComment: boolean } {
  let masked = "";
  let last = 0;
  let inString = false;
  let inComment = false;
  const blank = (from: number, to: number) => {
    masked += text.slice(last, from) + " ".repeat(Math.max(0, to - from));
    last = to;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      if (caret > i && caret <= stop) inComment = true;
      blank(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      if (caret > i && caret <= stop) inComment = true;
      blank(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(text.length, j + 1);
      if (ch === '"' && caret > i && caret <= stop) inString = true;
      blank(i, stop);
      i = stop - 1;
    }
  }
  return { masked: masked + text.slice(last), inString, inComment };
}

function enclosingParen(masked: string, caret: number): number {
  let depth = 0;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = masked[i]!;
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) return -1;
  }
  return -1;
}

function wordBefore(text: string, end: number): { word: string; start: number } | null {
  let i = end;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  const stop = i;
  while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1]!)) i--;
  if (i === stop) return null;
  return { word: text.slice(i, stop), start: i };
}

const REFLECTION_WORD = new Set<string>(UE_REFLECTION_MACRO_NAMES);

function callNameBefore(text: string, open: number): { word: string; start: number } | null {
  let i = open;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  if (text[i - 1] === "=") {
    i--;
    while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  }
  return wordBefore(text, i);
}

const MAX_MACRO_SPAN = 4000;
const MACRO_NAME_RE = /\bU(?:CLASS|FUNCTION|PROPERTY|STRUCT|ENUM|INTERFACE|PARAM|META|DELEGATE)\b/g;

function lastMacroStart(text: string, caret: number): number {
  const from = Math.max(0, caret - MAX_MACRO_SPAN);
  const window = text.slice(from, caret);
  MACRO_NAME_RE.lastIndex = 0;
  let start = -1;
  for (let m = MACRO_NAME_RE.exec(window); m; m = MACRO_NAME_RE.exec(window)) {
    let i = m.index + m[0].length;
    while (i < window.length && /\s/.test(window[i]!)) i++;
    if (window[i] !== "(") {
      let j = i;
      if (window[j] === "=") {
        j++;
        while (j < window.length && /\s/.test(window[j]!)) j++;
      }
      if (window[j] !== "(") continue;
    }
    start = from + m.index;
  }
  return start;
}

export function reflectionContextAt(text: string, caret: number): UeReflectionContext | null {
  if (caret <= 0 || caret > text.length) return null;
  const base = lastMacroStart(text, caret);
  if (base < 0) return null;
  const lineStart = text.lastIndexOf("\n", base - 1) + 1;
  const region = text.slice(lineStart, caret);
  const localCaret = region.length;
  const { masked, inString, inComment } = maskNonCode(region, localCaret);
  if (inComment) return null;
  const open = enclosingParen(masked, localCaret);
  if (open < 0) return null;
  const head = callNameBefore(masked, open);
  if (!head) return null;

  let macro: UeReflectionMacroName;
  let inMeta = false;
  let argStart = open + 1;
  if (head.word === "meta") {
    const outerOpen = enclosingParen(masked, head.start);
    if (outerOpen < 0) return null;
    const outer = callNameBefore(masked, outerOpen);
    if (!outer || !REFLECTION_WORD.has(outer.word)) return null;
    macro = outer.word as UeReflectionMacroName;
    inMeta = true;
  } else {
    if (!REFLECTION_WORD.has(head.word)) return null;
    macro = head.word as UeReflectionMacroName;
  }

  let depth = 0;
  let segmentStart = argStart;
  for (let i = argStart; i < localCaret; i++) {
    const ch = masked[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) segmentStart = i + 1;
  }
  const segment = region.slice(segmentStart);
  const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(segment);
  if (assignment) {
    return {
      macro,
      zone: "value",
      specifier: assignment[1]!,
      quoted: /^\s*"/.test(assignment[2]!) || inString,
    };
  }
  return { macro, zone: inMeta ? "meta" : "specifier" };
}


export type UeCompletionPlan =
  | { kind: "items"; context: UeReflectionContext; prefix: string; items: CppTextCompletionItem[] }
  | {
      kind: "value";
      context: UeReflectionContext;
      prefix: string;
      specifier: string;
      valueKind: UeSpecifierValueKind;
    }
  | { kind: "none"; context: UeReflectionContext; prefix: string };

function specifierItem(
  specifier: UeSpecifier,
  index: number,
  prefix: string,
): CppTextCompletionItem {
  const snippet = specifier.snippet;
  return {
    label: specifier.name,
    kind: 14,
    detail: specifier.doc,
    documentation: specifier.doc,
    insertText: snippet ?? specifier.name,
    isSnippet: snippet !== undefined,
    showParameterHints: false,
    sortText: `${specifier.name.toLowerCase().startsWith(prefix.toLowerCase()) ? "0" : "1"}${String(index).padStart(4, "0")}`,
  };
}

export function ueSpecifierItems(
  context: UeReflectionContext,
  prefix: string,
): CppTextCompletionItem[] {
  const list =
    context.zone === "meta" ? UE_META_SPECIFIERS : (UE_SPECIFIERS[context.macro] ?? []);
  const lower = prefix.toLowerCase();
  return list
    .filter((specifier) => specifier.name !== prefix && specifier.name.toLowerCase().startsWith(lower))
    .map((specifier, index) => specifierItem(specifier, index, prefix));
}

export function ueValueKind(
  context: UeReflectionContext,
  specifier: string,
): UeSpecifierValueKind | null {
  const pool = context.zone === "meta" ? UE_META_SPECIFIERS : (UE_SPECIFIERS[context.macro] ?? []);
  const hit = pool.find((entry) => entry.name === specifier);
  if (!hit?.value) return null;
  if (hit.value === "bool") return context.quoted ? "bool" : null;
  return context.quoted ? null : hit.value;
}

export function planUeReflectionCompletion(text: string, caret: number): UeCompletionPlan | null {
  const context = reflectionContextAt(text, caret);
  if (!context) return null;
  const prefix = /[A-Za-z_]\w*$/.exec(text.slice(Math.max(0, caret - 200), caret))?.[0] ?? "";
  if (context.zone === "value") {
    const specifier = context.specifier ?? "";
    const valueKind = ueValueKind(context, specifier);
    return valueKind
      ? { kind: "value", context, prefix, specifier, valueKind }
      : { kind: "none", context, prefix };
  }
  return { kind: "items", context, prefix, items: ueSpecifierItems(context, prefix) };
}

export function ueValueItems(
  valueKind: UeSpecifierValueKind,
  specifier: string,
  hits: readonly CppIndexCompletionHit[],
  words: readonly string[],
): CppTextCompletionItem[] {
  const out: CppTextCompletionItem[] = [];
  const seen = new Set<string>();
  const accepts = (hit: CppIndexCompletionHit): boolean => {
    if (valueKind === "bool") {
      if (hit.kind === "variable") return isUeBoolName(hit.name);
      return hit.kind === "function" && /^(?:bool|uint8)$/i.test((hit.returnType ?? "").trim());
    }
    return hit.kind === "function";
  };
  const rank = (hit: CppIndexCompletionHit): string => {
    if (specifier === "ReplicatedUsing") return hit.name.startsWith("OnRep_") ? "0" : "2";
    return hit.depth === 0 ? "0" : hit.depth !== undefined ? "1" : "2";
  };
  const sorted = [...hits].filter(accepts).sort((a, b) => rank(a).localeCompare(rank(b)));
  sorted.forEach((hit) => {
    if (seen.has(hit.name)) return;
    seen.add(hit.name);
    const detail = hit.params !== undefined ? `(${hit.params})` : hit.returnType;
    out.push({
      label: hit.name,
      kind: hit.kind === "function" ? 2 : 5,
      ...(detail ? { detail } : {}),
      insertText: hit.name,
      isSnippet: false,
      showParameterHints: false,
      sortText: `${rank(hit)}${String(out.length).padStart(4, "0")}`,
    });
  });
  words.forEach((word) => {
    if (seen.has(word)) return;
    const usable = valueKind === "bool" ? isUeBoolName(word) : word.startsWith("OnRep_");
    if (!usable) return;
    seen.add(word);
    out.push({
      label: word,
      kind: valueKind === "bool" ? 5 : 2,
      insertText: word,
      isSnippet: false,
      showParameterHints: false,
      sortText: `3${String(out.length).padStart(4, "0")}`,
    });
  });
  return out;
}
