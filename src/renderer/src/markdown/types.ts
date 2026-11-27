
export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "codespan"; text: string }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "image"; src: string; alt: string }
  | { type: "br" }
  | { type: "del"; children: InlineNode[] };

export type ProseBlock =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | {
      kind: "list";
      ordered: boolean;
      items: Array<{ children: InlineNode[] }>;
    }
  | { kind: "blockquote"; children: DisplayBlock[] }
  | { kind: "hr" }
  | { kind: "image"; src: string; alt: string };

export type PromotedBlock =
  | {
      kind: "table";
      header: InlineNode[][];
      rows: InlineNode[][][];
      align: Array<"left" | "center" | "right" | null>;
    }
  | { kind: "code"; language: string; text: string };

export type DisplayBlock = ProseBlock | PromotedBlock;
