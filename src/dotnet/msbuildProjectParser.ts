
export interface MsBuildFileItem {
  tag: string;
  include: string;
}

export interface MsBuildProjectInfo {
  items: MsBuildFileItem[];
  sdkStyle: boolean;
  unrealGenerated: boolean;
}

const FILE_ITEM_TAGS = new Set<string>([
  "ClCompile",
  "ClInclude",
  "ResourceCompile",
  "Midl",
  "MASM",
  "CustomBuild",
  "Natvis",
  "AppxManifest",
  "Compile",
  "None",
  "Content",
  "EmbeddedResource",
  "Resource",
  "Page",
  "ApplicationDefinition",
  "TypeScriptCompile",
  "ShaderCompile",
  "Text",
  "Xml",
  "Manifest",
  "Image",
]);

export function decodeXmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

export function parseMsBuildProject(text: string): MsBuildProjectInfo {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let sdkStyle = false;
  const items: MsBuildFileItem[] = [];
  const seen = new Set<string>();
  const openTag = /<([A-Za-z_][A-Za-z0-9_.-]*)([^>]*)>/g;
  const includeAttr = /\bInclude\s*=\s*(?:"([^"]*)"|'([^']*)')/;
  const sdkAttr = /\bSdk\s*=\s*(?:"[^"]*"|'[^']*')/;

  let m: RegExpExecArray | null;
  while ((m = openTag.exec(src)) !== null) {
    const tag = m[1] ?? "";
    const attrs = m[2] ?? "";
    if (tag === "Project" && sdkAttr.test(attrs)) {
      sdkStyle = true;
      continue;
    }
    if (!FILE_ITEM_TAGS.has(tag)) continue;
    const inc = includeAttr.exec(attrs);
    const value = inc ? (inc[1] ?? inc[2] ?? "") : "";
    if (!value) continue;
    const key = value.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ tag, include: decodeXmlEntities(value) });
  }

  return {
    items,
    sdkStyle,
    unrealGenerated: src.includes("UnrealBuildTool") || src.includes(".uproject"),
  };
}
