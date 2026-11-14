/**
 * C++ editing rules layered over monaco's stock cpp configuration: bracket
 * auto-closing / surround (stock), plus the Rider-like typing behavior the
 * stock config lacks — indent after `{` / `(`, outdent on `}` / access
 * specifiers, and `/** … *\/` doc-comment continuation on Enter.
 *
 * Pure data; `IndentAction` values match monaco.languages.IndentAction.
 */

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
    // Close only before whitespace / closers / separators: typing `(` in
    // front of an identifier (`(|Foo`) must not insert a stray `)`.
    autoCloseBefore: ";:.,=}])>` \n\t",
    indentationRules: {
      increaseIndentPattern:
        /^((?!\/\/).)*(\{[^}"'`]*|\([^)"'`]*)$|^\s*(public|private|protected)\s*:\s*$/,
      decreaseIndentPattern: /^\s*(\/\*.*\*\/\s*)*[}\)]|^\s*(public|private|protected)\s*:\s*$/,
    },
    onEnterRules: [
      // `/** | */` → middle line ` * |`
      {
        beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
        afterText: /^\s*\*\/$/,
        action: { indentAction: INDENT_ACTION.IndentOutdent, appendText: " * " },
      },
      {
        beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
        action: { indentAction: INDENT_ACTION.None, appendText: " * " },
      },
      // Continue ` * text` lines inside a block comment.
      {
        beforeText: /^(\t|[ ])*[ ]\*([ ]([^*]|\*(?!\/))*)?$/,
        action: { indentAction: INDENT_ACTION.None, appendText: "* " },
      },
      // After ` */` drop the extra alignment space.
      {
        beforeText: /^(\t|[ ])*[ ]\*\/\s*$/,
        action: { indentAction: INDENT_ACTION.None, removeText: 1 },
      },
    ],
  };
}
