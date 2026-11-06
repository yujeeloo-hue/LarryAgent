export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
};

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/**
 * Parse SKILL.md with optional YAML frontmatter (`---` … `---`).
 * Only reads `name` and `description` keys (simple `key: value` lines).
 */
export function parseSkillMarkdown(raw: string): ParsedSkillMd {
  const text = raw.replace(/^\uFEFF/, "");
  const trimmedStart = text.trimStart();
  if (!trimmedStart.startsWith("---")) {
    return { name: "", description: "", body: text.replace(/\s+$/, "") };
  }

  const afterOpen = trimmedStart.slice(3);
  const nl = afterOpen.search(/\r?\n/);
  if (nl < 0) {
    return { name: "", description: "", body: text.replace(/\s+$/, "") };
  }
  const rest = afterOpen.slice(nl + (afterOpen[nl] === "\r" ? 2 : 1));
  const closeMatch = rest.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { name: "", description: "", body: text.replace(/\s+$/, "") };
  }

  const front = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length).replace(
    /^\s+/,
    "",
  );

  let name = "";
  let description = "";
  for (const line of front.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = unquoteYamlScalar(match[2] ?? "");
    if (key === "name") name = value;
    if (key === "description") description = value;
  }

  return {
    name: name.trim().slice(0, MAX_NAME),
    description: description.trim().slice(0, MAX_DESCRIPTION),
    body: body.replace(/\s+$/, ""),
  };
}

/** Serialize frontmatter + body for SKILL.md. */
export function serializeSkillMarkdown(input: {
  name: string;
  description: string;
  body: string;
}): string {
  const name = input.name.trim().slice(0, MAX_NAME);
  const description = input.description.trim().slice(0, MAX_DESCRIPTION);
  const body = input.body.replace(/^\s+/, "").replace(/\s+$/, "");
  const lines = [
    "---",
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    "---",
    "",
  ];
  if (body) {
    lines.push(body, "");
  }
  return lines.join("\n");
}

function unquoteYamlScalar(raw: string): string {
  const v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    const inner = v.slice(1, -1);
    if (v.startsWith('"')) {
      return inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return inner.replace(/''/g, "'");
  }
  return v;
}

function yamlScalar(value: string): string {
  if (
    value === "" ||
    /[:#{}[\],&*!|>'"%@`]/.test(value) ||
    /^\s|\s$/.test(value) ||
    value.includes("\n")
  ) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return value;
}

export { MAX_NAME as SKILL_NAME_MAX, MAX_DESCRIPTION as SKILL_DESCRIPTION_MAX };
