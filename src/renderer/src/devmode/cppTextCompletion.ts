
export type CppCompletionAccess =
  | "none"
  | "this"
  | "member"
  | "member-unknown"
  | "scope";

export type CppCompletionContext = {
  prefix: string;
  access: CppCompletionAccess;
  name?: string;
  chain?: string[];
};

const MEMBER_CHAIN_PART = /^(?:this|[A-Za-z_]\w*)$/;

export function memberChain(receiverText: string): string[] | null {
  const text = receiverText.trim();
  if (!text) return null;
  const parts = text.split(/\s*(?:->|\.)\s*/);
  if (parts.length === 0 || parts.length > 6) return null;
  if (!parts.every((part) => MEMBER_CHAIN_PART.test(part))) return null;
  return parts;
}

export function completionContextAt(lineBefore: string): CppCompletionContext {
  const prefix = /[A-Za-z_]\w*$/.exec(lineBefore)?.[0] ?? "";
  const rest = lineBefore.slice(0, lineBefore.length - prefix.length).replace(/\s+$/, "");
  if (rest.endsWith("::")) {
    const qualifier = /([A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*::$/.exec(rest)?.[1];
    return qualifier ? { prefix, access: "scope", name: qualifier } : { prefix, access: "none" };
  }
  const arrow = rest.endsWith("->");
  if (arrow || (rest.endsWith(".") && !/\d\.$/.test(rest))) {
    const receiverText = rest.slice(0, rest.length - (arrow ? 2 : 1)).replace(/\s+$/, "");
    const chain = memberChain(receiverText);
    if (!chain) return { prefix, access: "member-unknown" };
    if (chain.length === 1 && chain[0] === "this") return { prefix, access: "this" };
    const name = chain[chain.length - 1]!;
    return {
      prefix,
      access: "member",
      name,
      ...(chain.length > 1 ? { chain } : {}),
    };
  }
  return { prefix, access: "none" };
}

const POINTER_WRAPPERS = new Set([
  "TObjectPtr",
  "TWeakObjectPtr",
  "TSoftObjectPtr",
  "TStrongObjectPtr",
  "TSharedPtr",
  "TSharedRef",
  "TWeakPtr",
  "TUniquePtr",
  "TSubclassOf",
  "unique_ptr",
  "shared_ptr",
  "weak_ptr",
]);

function stripTemplateArgs(text: string): string {
  let out = text;
  for (let n = 0; n < 6; n++) {
    const next = out.replace(/<[^<>]*>/g, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

export function memberAccessType(typeText: string): string | null {
  let text = typeText
    .replace(/\b(?:const|volatile|mutable|static|class|struct|typename)\b/g, " ")
    .trim();
  for (let n = 0; n < 3; n++) {
    const wrapped = /^(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)\s*<\s*(.+?)\s*>\s*[*&]*$/.exec(text);
    if (!wrapped || !POINTER_WRAPPERS.has(wrapped[1]!)) break;
    text = wrapped[2]!;
  }
  const name = /([A-Za-z_]\w*)[\s*&]*$/.exec(stripTemplateArgs(text))?.[1];
  if (!name || name === "auto" || CPP_KEYWORDS.has(name)) return null;
  return name;
}

export function localTypeOf(textBefore: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;(){}]*>)?)\\s*[*&]*\\s*\\b${escaped}\\s*(?=[=;,)\\[{(:]|$)`,
    "gm",
  );
  let found: string | null = null;
  for (let m = re.exec(textBefore); m; m = re.exec(textBefore)) {
    const type = memberAccessType(m[1]!);
    if (type && !NOT_A_TYPE.has(m[1]!.trim())) found = type;
  }
  return found;
}

const NOT_A_TYPE = new Set(["return", "new", "delete", "else", "case", "goto", "throw", "co_return", "co_yield"]);

const CPP_KEYWORDS = new Set([
  "alignas", "alignof", "and", "asm", "auto", "bool", "break", "case", "catch", "char",
  "class", "const", "constexpr", "const_cast", "continue", "decltype", "default", "delete",
  "do", "double", "dynamic_cast", "else", "enum", "explicit", "export", "extern", "false",
  "float", "for", "friend", "goto", "if", "inline", "int", "long", "mutable", "namespace",
  "new", "noexcept", "not", "nullptr", "operator", "or", "private", "protected", "public",
  "register", "reinterpret_cast", "return", "short", "signed", "sizeof", "static",
  "static_assert", "static_cast", "struct", "switch", "template", "this", "throw", "true",
  "try", "typedef", "typeid", "typename", "union", "unsigned", "using", "virtual", "void",
  "volatile", "while", "override", "final", "include", "define", "ifdef", "ifndef", "endif",
  "pragma",
]);

export function bufferIdentifiers(
  text: string,
  caretOffset: number,
  prefix: string,
  limit = 40,
  allowEmptyPrefix = false,
): string[] {
  if (!prefix && !allowEmptyPrefix) return [];
  const lower = prefix.toLowerCase();
  const best = new Map<string, number>();
  const re = /[A-Za-z_]\w*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const word = m[0];
    if (word.length < 2 || !word.toLowerCase().startsWith(lower)) continue;
    const start = m.index;
    const end = start + word.length;
    if (start <= caretOffset && caretOffset <= end) continue;
    if (CPP_KEYWORDS.has(word)) continue;
    const distance = Math.abs(start - caretOffset);
    const prev = best.get(word);
    if (prev === undefined || distance < prev) best.set(word, distance);
  }
  return [...best.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([word]) => word);
}

const LOCAL_SCAN_CAP = 60_000;

export function enclosingBodyBefore(text: string, caret: number): string {
  const from = Math.max(0, caret - LOCAL_SCAN_CAP);
  const slice = text.slice(from, caret);
  let depth = 0;
  let functionBrace = -1;
  for (let i = slice.length - 1; i >= 0; i--) {
    const ch = slice.charCodeAt(i);
    if (ch === 125 ) depth++;
    else if (ch === 123 ) {
      if (depth === 0) functionBrace = i;
      else depth--;
    }
  }
  if (functionBrace < 0) return slice;
  let paren = 0;
  let signature = functionBrace;
  for (let i = functionBrace - 1; i >= 0 && functionBrace - i < 2000; i--) {
    const ch = slice.charCodeAt(i);
    if (ch === 41 ) paren++;
    else if (ch === 40 ) paren = Math.max(0, paren - 1);
    else if (paren === 0 && (ch === 59  || ch === 125 )) {
      signature = i + 1;
      break;
    }
  }
  return slice.slice(signature);
}

export function localNamesInScope(
  text: string,
  caret: number,
  prefix: string,
  limit = 40,
  allowEmptyPrefix = false,
): string[] {
  const body = enclosingBodyBefore(text, caret);
  return bufferIdentifiers(body, body.length, prefix, limit, allowEmptyPrefix);
}

export function quickBareCompletionItems(
  text: string,
  caret: number,
  prefix: string,
  explicit = false,
): CppTextCompletionItem[] {
  const words = localNamesInScope(text, caret, prefix, 40, explicit);
  const macros = ueMacroHits(prefix);
  const keywords = keywordItems(prefix);
  const common = commonTypeHits(prefix);
  return [...buildTextCompletionItems([...common, ...macros], words), ...keywords];
}

export type CppIndexCompletionHit = {
  name: string;
  kind: "class" | "interface" | "struct" | "enum" | "type" | "function" | "variable";
  container?: string;
  params?: string;
  returnType?: string;
  path?: string;
  depth?: number;
  paramsUnknown?: boolean;
  macro?: boolean;
  common?: boolean;
};

export type CppTextCompletionItem = {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  signature?: string;
  headerPath?: string;
  insertText: string;
  isSnippet: boolean;
  showParameterHints: boolean;
  sortText: string;
};

function lspKindOf(hit: CppIndexCompletionHit): number {
  if (hit.macro) return 21;
  switch (hit.kind) {
    case "function": return hit.container ? 2 : 3;
    case "variable": return hit.container ? 5 : 6;
    case "struct": return 22;
    case "enum": return 13;
    case "interface": return 8;
    default: return 7;
  }
}

function paramsBody(params: string | undefined): string {
  const body = (params ?? "").trim().replace(/^\(/, "").replace(/\)$/, "").trim();
  return body === "void" ? "" : body;
}

const UE_MACROS: readonly [string, "args" | "none" | "object"][] = [
  ["UE_LOG", "args"], ["UE_CLOG", "args"], ["UE_LOGFMT", "args"],
  ["check", "args"], ["checkf", "args"], ["checkSlow", "args"], ["checkNoEntry", "none"],
  ["checkNoReentry", "none"], ["ensure", "args"], ["ensureMsgf", "args"],
  ["ensureAlways", "args"], ["ensureAlwaysMsgf", "args"], ["verify", "args"], ["verifyf", "args"],
  ["TEXT", "args"], ["LOCTEXT", "args"], ["NSLOCTEXT", "args"], ["INVTEXT", "args"],
  ["UPROPERTY", "args"], ["UFUNCTION", "args"], ["UCLASS", "args"], ["USTRUCT", "args"],
  ["UENUM", "args"], ["UINTERFACE", "args"], ["UMETA", "args"], ["UPARAM", "args"],
  ["GENERATED_BODY", "none"], ["GENERATED_UCLASS_BODY", "none"], ["GENERATED_USTRUCT_BODY", "none"],
  ["DECLARE_LOG_CATEGORY_EXTERN", "args"], ["DEFINE_LOG_CATEGORY", "args"],
  ["DEFINE_LOG_CATEGORY_STATIC", "args"], ["DECLARE_DELEGATE", "args"],
  ["DECLARE_DELEGATE_OneParam", "args"], ["DECLARE_DELEGATE_TwoParams", "args"],
  ["DECLARE_MULTICAST_DELEGATE", "args"], ["DECLARE_MULTICAST_DELEGATE_OneParam", "args"],
  ["DECLARE_DYNAMIC_DELEGATE", "args"], ["DECLARE_DYNAMIC_MULTICAST_DELEGATE", "args"],
  ["DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam", "args"],
  ["DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams", "args"],
  ["SCOPE_CYCLE_COUNTER", "args"], ["QUICK_SCOPE_CYCLE_COUNTER", "args"],
  ["TRACE_CPUPROFILER_EVENT_SCOPE", "args"], ["GET_MEMBER_NAME_CHECKED", "args"],
  ["GET_FUNCTION_NAME_CHECKED", "args"], ["PURE_VIRTUAL", "args"], ["ENUM_CLASS_FLAGS", "args"],
  ["IMPLEMENT_MODULE", "args"], ["IMPLEMENT_PRIMARY_GAME_MODULE", "args"],
  ["INDEX_NONE", "object"], ["FORCEINLINE", "object"], ["FORCENOINLINE", "object"],
];

export function ueMacroHits(prefix: string): CppIndexCompletionHit[] {
  if (!prefix) return [];
  const lower = prefix.toLowerCase();
  return UE_MACROS.filter(([name]) => name.toLowerCase().startsWith(lower) && name !== prefix).map(
    ([name, shape]): CppIndexCompletionHit =>
      shape === "object"
        ? { name, kind: "type", macro: true }
        : shape === "none"
          ? { name, kind: "function", macro: true, params: "" }
          : { name, kind: "function", macro: true, paramsUnknown: true },
  );
}

const COMMON_TYPES: readonly { name: string; kind: "struct" | "class" }[] = [
  { name: "FVector", kind: "struct" },
  { name: "FVector2D", kind: "struct" },
  { name: "FVector4", kind: "struct" },
  { name: "FRotator", kind: "struct" },
  { name: "FQuat", kind: "struct" },
  { name: "FTransform", kind: "struct" },
  { name: "FMatrix", kind: "struct" },
  { name: "FPlane", kind: "struct" },
  { name: "FBox", kind: "struct" },
  { name: "FBox2D", kind: "struct" },
  { name: "FIntPoint", kind: "struct" },
  { name: "FIntVector", kind: "struct" },
  { name: "FString", kind: "struct" },
  { name: "FName", kind: "struct" },
  { name: "FText", kind: "struct" },
  { name: "FColor", kind: "struct" },
  { name: "FLinearColor", kind: "struct" },
  { name: "FGuid", kind: "struct" },
  { name: "TArray", kind: "class" },
  { name: "TMap", kind: "class" },
  { name: "TSet", kind: "class" },
  { name: "TSharedPtr", kind: "class" },
  { name: "TWeakObjectPtr", kind: "class" },
  { name: "TSubclassOf", kind: "class" },
  { name: "TSoftObjectPtr", kind: "class" },
  { name: "TOptional", kind: "class" },
];

const UE_TYPE_LEADING = /^[AUFEITS][A-Z]/;

export function matchesTypedPrefix(name: string, prefix: string): boolean {
  if (!prefix) return true;
  const lower = prefix.toLowerCase();
  const n = name.toLowerCase();
  if (n.startsWith(lower)) return true;
  return UE_TYPE_LEADING.test(name) && n.slice(1).startsWith(lower);
}

export function completionFilterText(label: string, prefix: string): string {
  if (!prefix || label.toLowerCase().startsWith(prefix.toLowerCase())) return label;
  if (UE_TYPE_LEADING.test(label) && label.toLowerCase().slice(1).startsWith(prefix.toLowerCase())) {
    return label.slice(1);
  }
  return label;
}

export function commonTypeHits(prefix: string): CppIndexCompletionHit[] {
  if (!prefix) return [];
  return COMMON_TYPES.filter(({ name }) => matchesTypedPrefix(name, prefix)).map(({ name, kind }) => ({
    name,
    kind,
    common: true,
  }));
}

const COMPLETION_KEYWORDS = [
  "auto", "bool", "break", "case", "catch", "char", "class", "const", "const_cast",
  "constexpr", "continue", "default", "delete", "double", "dynamic_cast", "enum",
  "explicit", "false", "float", "friend", "inline", "int", "mutable", "namespace",
  "new", "nullptr", "operator", "override", "private", "protected", "public",
  "reinterpret_cast", "return", "sizeof", "static", "static_cast", "struct",
  "template", "this", "throw", "true", "try", "typedef", "typename", "unsigned",
  "using", "virtual", "void", "volatile",
];

export function keywordItems(prefix: string): CppTextCompletionItem[] {
  if (!prefix) return [];
  return COMPLETION_KEYWORDS.filter((kw) => kw.startsWith(prefix) && kw !== prefix).map(
    (kw, index) => ({
      label: kw,
      kind: 14,
      insertText: kw,
      isSnippet: false,
      showParameterHints: false,
      sortText: `5${String(index).padStart(4, "0")}`,
    }),
  );
}

export function buildTextCompletionItems(
  hits: readonly CppIndexCompletionHit[],
  words: readonly string[],
): CppTextCompletionItem[] {
  const out: CppTextCompletionItem[] = [];
  const seen = new Set<string>();
  hits.forEach((hit, index) => {
    if (seen.has(hit.name)) return;
    seen.add(hit.name);
    const isCall = hit.kind === "function";
    const body = paramsBody(hit.params);
    const takesArgs = hit.paramsUnknown === true || body !== "";
    const band =
      hit.depth === 0
        ? "0"
        : hit.depth !== undefined
          ? `2${String(Math.min(hit.depth, 9))}`
          : hit.common
            ? "3"
            : "4";
    out.push({
      label: hit.name,
      kind: lspKindOf(hit),
      ...(hit.returnType ? { detail: hit.returnType } : {}),
      ...(hit.path ? { headerPath: hit.path } : {}),
      ...(isCall ? { signature: hit.paramsUnknown ? "(…)" : `(${body})` } : {}),
      insertText: isCall ? (takesArgs ? `${hit.name}($0)` : `${hit.name}()`) : hit.name,
      isSnippet: isCall,
      showParameterHints: isCall && takesArgs,
      sortText: `${band}${String(index).padStart(4, "0")}`,
    });
  });
  words.forEach((word, index) => {
    if (seen.has(word)) return;
    seen.add(word);
    out.push({
      label: word,
      kind: 1,
      insertText: word,
      isSnippet: false,
      showParameterHints: false,
      sortText: `1${String(index).padStart(4, "0")}`,
    });
  });
  return out;
}


export type CppBraceStyle = "allman" | "kr";

export function detectBraceStyle(text: string): CppBraceStyle {
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text;
  const ownLine = sample.match(/^[ \t]*\{[ \t]*$/gm)?.length ?? 0;
  const sameLine = sample.match(/[)\w][ \t]*\{[ \t]*$/gm)?.length ?? 0;
  return sameLine > ownLine ? "kr" : "allman";
}

export const CONTROL_SNIPPET_LABELS = [
  "if",
  "else if",
  "else",
  "for",
  "for range",
  "while",
  "do",
  "switch",
] as const;

export function controlFlowSnippets(
  lineBefore: string,
  prefix: string,
  style: CppBraceStyle,
): CppTextCompletionItem[] {
  const lead = lineBefore.slice(0, lineBefore.length - prefix.length);
  const atStatement = /^\s*$/.test(lead);
  const afterClose = /^\s*\}\s*$/.test(lead);
  if (!atStatement && !afterClose) return [];
  const lower = prefix.toLowerCase();
  const open = style === "allman" ? "\n{\n\t$0\n}" : " {\n\t$0\n}";
  const doBody = style === "allman" ? "do\n{\n\t$0\n} while (${1:condition});" : "do {\n\t$0\n} while (${1:condition});";
  const all: { label: string; insertText: string; signature: string; afterCloseOk?: boolean }[] = [
    { label: "if", insertText: `if (\${1:condition})${open}`, signature: " (…) { }" },
    { label: "else if", insertText: `else if (\${1:condition})${open}`, signature: " (…) { }", afterCloseOk: true },
    { label: "else", insertText: `else${open}`, signature: " { }", afterCloseOk: true },
    { label: "for", insertText: `for (\${1:int32 Index = 0}; \${2:Index < Count}; \${3:++Index})${open}`, signature: " (…; …; …) { }" },
    { label: "for range", insertText: `for (\${1:auto}& \${2:Item} : \${3:Items})${open}`, signature: " (auto& Item : Items) { }" },
    { label: "while", insertText: `while (\${1:condition})${open}`, signature: " (…) { }" },
    { label: "do", insertText: doBody, signature: " { } while (…);" },
    { label: "switch", insertText: `switch (\${1:value})${open}`, signature: " (…) { }" },
  ];
  const out: CppTextCompletionItem[] = [];
  all.forEach((entry, index) => {
    if (afterClose && !entry.afterCloseOk) return;
    if (lower && !entry.label.startsWith(lower)) return;
    out.push({
      label: entry.label,
      kind: 15,
      detail: "snippet",
      signature: entry.signature,
      insertText: entry.insertText,
      isSnippet: true,
      showParameterHints: false,
      sortText: `!${String(index).padStart(2, "0")}`,
    });
  });
  return out;
}


export type CppCallContext = {
  name: string;
  owner?: string;
  activeParameter: number;
};

export function callContextAt(textBefore: string): CppCallContext | null {
  const text = textBefore.slice(-4000);
  let depth = 0;
  let commas = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) {
        if (ch !== "(") return null;
        const head = text.slice(0, i);
        const m = /(?:([A-Za-z_]\w*)\s*(?:::|->|\.)\s*)?([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*$/.exec(head);
        if (!m?.[2] || CPP_KEYWORDS.has(m[2])) return null;
        return {
          name: m[2],
          ...(m[1] ? { owner: m[1] } : {}),
          activeParameter: commas,
        };
      }
      depth--;
    } else if (ch === "," && depth === 0) commas++;
    else if (ch === ";" && depth === 0) return null;
  }
  return null;
}

export function splitParams(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function signatureFromHit(hit: {
  name: string;
  params?: string;
  returnType?: string;
  container?: string;
}): { label: string; parameters: string[] } {
  const body = paramsBody(hit.params);
  const owner = hit.container ? `${hit.container}::` : "";
  const ret = hit.returnType ? `${hit.returnType} ` : "";
  return { label: `${ret}${owner}${hit.name}(${body})`, parameters: splitParams(body) };
}
