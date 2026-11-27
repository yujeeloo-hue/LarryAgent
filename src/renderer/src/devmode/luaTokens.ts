type MonarchRule = unknown[] | { include: string };

export type StockLuaLanguage = {
  keywords?: string[];
  tokenizer: Record<string, MonarchRule[]> & { root: MonarchRule[]; whitespace: MonarchRule[] };
  [key: string]: unknown;
};

const UE_TYPE_SOURCE = "(?:[UAFEIT][A-Z][A-Za-z0-9_]*|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_C)";

const IDENTIFIER_CASES = {
  cases: {
    "@keywords": { token: "keyword.$0" },
    "~@ueType": "type",
    "@default": "identifier",
  },
};

const ROOT_RULES: MonarchRule[] = [
  [/function(?=\s+[A-Za-z_])/, { token: "keyword.function", next: "@funcname" }],
  [/self\b/, "variable.predefined"],
  [/UE(?=\s*\.)/, "namespace"],
  [/(:)(\s*)([A-Za-z_]\w*)(?=\s*[("'{])/, ["delimiter", "", "function.call"]],
  [/[A-Za-z_]\w*(?=\s*\()/, { cases: { "@keywords": { token: "keyword.$0" }, "@default": "function.call" } }],
  [/[A-Za-z_]\w*/, IDENTIFIER_CASES],
];

const FUNCNAME_RULES: MonarchRule[] = [
  [/\s+/, ""],
  [/[A-Za-z_]\w*(?=\s*[.:])/, "type"],
  [/[.:]/, "delimiter"],
  [/[A-Za-z_]\w*/, "function.declaration", "@pop"],
  [/./, { token: "@rematch", next: "@pop" }],
];

type MonarchAction = string | { token: string; next?: string } | MonarchAction[];

const LUADOC_BASE: Array<[RegExp, MonarchAction]> = [
  [
    /(@(?:param|field))(\s+)((?:(?:public|private|protected)\s+)?)([A-Za-z_]\w*\??)/,
    ["annotation", "", "keyword", "variable.parameter"],
  ],
  [/@[A-Za-z_]+/, "annotation"],
  [/(?:fun|nil|any|boolean|number|integer|string|table|function|userdata|thread|self)\b/, "keyword.type"],
  [/[A-Za-z_][\w.]*/, "type"],
  [/"[^"]*"|'[^']*'/, "string"],
  [/[|<>,[\]():?]/, "delimiter"],
  [/\s+/, ""],
  [/[^\s\x40A-Za-z_"'|<>,[\]():?]+/, "comment.doc"],
  [/./, "comment.doc"],
];

function withPop(action: MonarchAction): MonarchAction {
  if (typeof action === "string") return { token: action, next: "@pop" };
  if (Array.isArray(action)) return [...action.slice(0, -1), withPop(action[action.length - 1]!)];
  return { ...action, next: "@pop" };
}

const LUADOC_RULES: MonarchRule[] = LUADOC_BASE.flatMap(([re, action]) => [
  [new RegExp(`(?:${re.source})$`), withPop(action)],
  [re, action],
]);

export function buildLuaLanguage(base: StockLuaLanguage): StockLuaLanguage {
  const stockRoot = base.tokenizer.root;
  const rest = Array.isArray(stockRoot[0]) ? stockRoot.slice(1) : stockRoot;
  return {
    ...base,
    ueType: UE_TYPE_SOURCE,
    tokenizer: {
      ...base.tokenizer,
      root: [...ROOT_RULES, ...rest],
      whitespace: [[/---(?=\s*@)/, "comment.doc", "@luadoc"], ...base.tokenizer.whitespace],
      funcname: FUNCNAME_RULES,
      luadoc: LUADOC_RULES,
    },
  };
}
