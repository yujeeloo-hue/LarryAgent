/** Shared content formatting for Monaco's hover and parameter-hints widgets. */
export type PopoverLocation = { role: "Decl" | "Impl" | "Engine"; path: string; line: number };

export type CompactSignature = {
  label: string;
  parameters: string[];
  activeParameter?: number;
  documentation?: string;
  parameterDocumentation?: string[];
};

export function escapePopoverHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]!);
}

/** Split only outer commas; defaults can contain templates, lambdas and strings. */
function signatureParameters(label: string): { open: number; close: number; parameters: string[] } | null {
  const open = label.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  let quote = "";
  let start = open + 1;
  const parameters: string[] = [];
  for (let i = start; i < label.length; i++) {
    const ch = label[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ")" && depth === 0) {
      if (label.slice(start, i).trim()) parameters.push(label.slice(start, i).trim());
      return { open, close: i, parameters };
    }
    if ("(<[{".includes(ch)) depth++;
    else if (")>]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parameters.push(label.slice(start, i).trim()); start = i + 1;
    }
  }
  return null;
}

/** Long signatures wrap at parameter boundaries without altering parameter text. */
export function compactSignatureLabel(label: string, parameters?: readonly string[]): string {
  if (label.length <= 90 || label.includes("\n")) return label.trim();
  const parts = signatureParameters(label);
  if (!parts || parts.parameters.length === 0) return label.trim();
  const params = parameters?.length ? parameters : parts.parameters;
  // A malformed server label must remain intact, rather than silently lose text.
  if (params.length !== parts.parameters.length || params.some((param, i) => param.trim() !== parts.parameters[i])) return label.trim();
  return `${label.slice(0, parts.open + 1)}\n    ${params.join(",\n    ")}\n${label.slice(parts.close)}`;
}

export function signatureFunctionName(label: string): string {
  return /([~\w:]+)\s*\(/.exec(label)?.[1]?.split("::").at(-1) ?? "Parameters";
}

function codeFence(code: string): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length + 1)));
  return `${fence}cpp\n${compactSignatureLabel(code)}\n${fence}`;
}

/** Clangd's redundant title/type/parameter preamble is superseded by the signature. */
export function semanticHoverParts(markdown: string): { signature: string | null; documentation: string } {
  let rest = markdown.trim();
  let signature: string | null = null;
  rest = rest.replace(/(^|\n)(`{3,}|~{3,})(?:cpp|c\+\+|c)?[ \t]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/, (_all, lead: string, _fence: string, code: string) => {
    signature = code.trim(); return lead;
  });
  rest = rest.replace(/^#{1,6}\s+[^\n]+\n*/, "");
  if (signature) {
    rest = rest.replace(/^(?:Type:|Return type:|→)[^\n]*(?:\n|$)/gm, "");
    rest = rest.replace(/^Parameters:\s*\n(?:[ \t]*[-*]\s+`[^`\n]+`[ \t]*(?:\n|$))+/gm, "");
  }
  rest = rest.replace(/^provided by [^\n]*(?:\n|$)/gim, "");
  rest = rest.replace(/^\s*---+\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return { signature, documentation: rest };
}

export function formatCompactHover(input: {
  name: string;
  kind?: string;
  signature?: string | null;
  documentation?: string;
  locations?: readonly PopoverLocation[];
}): string {
  const icon = input.kind === "function" ? "ƒ" : ["class", "struct", "interface", "type"].includes(input.kind ?? "") ? "C" : "";
  const sections = [`<h4>${icon ? `<em>${icon}</em> ` : ""}${escapePopoverHtml(input.name)}</h4>`];
  if (input.signature) sections.push(codeFence(input.signature));
  const docs = input.documentation?.trim();
  if (docs) {
    const split = /\n\s*\n/.exec(docs);
    const summary = split ? docs.slice(0, split.index) : docs;
    // Never split a code fence, table, list or HTML block across <details>.
    const block = /^(?:#{1,6}\s|`{3,}|~{3,}|[|<]|[-*]\s|\d+\.\s)/.test(summary) || /`{3,}|~{3,}/.test(summary);
    sections.push("---");
    if (block) sections.push(`<details>\n<summary>More details</summary>\n\n${docs}\n\n</details>`);
    else {
      sections.push(summary);
      if (split) sections.push(`<details>\n<summary>More details</summary>\n\n${docs.slice(split.index + split[0].length)}\n\n</details>`);
    }
  }
  const seen = new Set<string>();
  const locations = (input.locations ?? []).filter((location) => {
    const key = `${location.path.replace(/\\/g, "/").toLowerCase()}:${location.line}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 3);
  if (locations.length) {
    const rows = locations.map((loc) => {
      const full = loc.path.replace(/\\/g, "/");
      return `<tr><td>${loc.role}</td><td><code title="${escapePopoverHtml(full)}">${escapePopoverHtml(full.split("/").at(-1) ?? full)}</code></td><td>:${loc.line}</td></tr>`;
    });
    sections.push("---", `<table><tbody>${rows.join("")}</tbody></table>`);
  }
  return sections.join("\n\n");
}

export function compactParameterDocumentation(label: string, index: number, total: number, documentation?: string): string {
  const [declaration = "", defaultValue] = label.split(/\s*=\s*(.*)/s);
  const match = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/.exec(declaration);
  const name = match?.[1] ?? declaration;
  const type = match ? declaration.slice(0, match.index).trim() : "";
  const heading = `<h5><code>${escapePopoverHtml(name)}</code> <small>${escapePopoverHtml(type)}</small><small>Parameter ${index + 1} of ${total}</small></h5>`;
  return [heading, documentation?.trim(), defaultValue ? `<small>Default: ${escapePopoverHtml(defaultValue)}</small>` : ""].filter(Boolean).join("\n\n");
}
