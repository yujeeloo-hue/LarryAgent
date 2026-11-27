
const INDENT_ACTION = { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } as const;

export type CppLanguageConfiguration = {
  comments?: unknown;
  brackets?: unknown;
  autoClosingPairs: { open: string; close: string; notIn?: string[] }[];
  surroundingPairs: { open: string; close: string }[];
  autoCloseBefore: string;
  indentationRules: { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp };
  onEnterRules: {
    beforeText: RegExp;
    afterText?: RegExp;
    action: { indentAction: number; appendText?: string; removeText?: number };
  }[];
  [key: string]: unknown;
};

export function buildCppLanguageConfiguration(
  stock: Record<string, unknown>,
): CppLanguageConfiguration {
  return {
    ...stock,
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "'", close: "'", notIn: ["string", "comment"] },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "/**", close: " */", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "<", close: ">" },
    ],
    autoCloseBefore: ";:.,=}])>` \n\t",
    indentationRules: {
      increaseIndentPattern:
        /^((?!\/\/).)*(\{[^}"'`]*|\([^)"'`]*)$|^\s*(public|private|protected)\s*:\s*$/,
      decreaseIndentPattern: /^\s*(\/\*.*\*\/\s*)*[}\)]|^\s*(public|private|protected)\s*:\s*$/,
    },
    onEnterRules: [
      {
        beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
        afterText: /^\s*\*\/$/,
        action: { indentAction: INDENT_ACTION.IndentOutdent, appendText: " * " },
      },
      {
        beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
        action: { indentAction: INDENT_ACTION.None, appendText: " * " },
      },
      {
        beforeText: /^(\t|[ ])*[ ]\*([ ]([^*]|\*(?!\/))*)?$/,
        action: { indentAction: INDENT_ACTION.None, appendText: "* " },
      },
      {
        beforeText: /^(\t|[ ])*[ ]\*\/\s*$/,
        action: { indentAction: INDENT_ACTION.None, removeText: 1 },
      },
    ],
  };
}
