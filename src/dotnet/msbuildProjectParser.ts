/**
 * Pure MSBuild project-file parser (no fs, no DOM — safe in main & renderer).
 *
 * Extracts the explicit file item list (ClCompile / ClInclude / Compile /
 * None / …) from a .vcxproj or .csproj. Callers resolve each `include`
 * against the project file's directory (see devmode/slnPaths.ts — UE writes
 * `..\..\`-style paths relative to Intermediate/ProjectFiles).
 *
 * SDK-style projects (<Project Sdk="…">) rely on implicit globs, so their
 * explicit item list is NOT exhaustive — callers should fall back to a
 * directory listing when `sdkStyle` is true.
 */

export interface MsBuildFileItem {
  /** Item tag, e.g. "ClCompile", "Compile", "None". */
  tag: string;
  /** Include value exactly as written (backslashes, `..` segments), entities decoded. */
  include: string;
}

export interface MsBuildProjectInfo {
  /** Distinct file items in document order (deduped by normalized path). */
  items: MsBuildFileItem[];
  /** True for `<Project Sdk="…">` — implicit globs, item list not exhaustive. */
  sdkStyle: boolean;
  /** True when the content carries UnrealBuildTool / .uproject markers. */
  unrealGenerated: boolean;
}

/**
 * Item tags whose `Include` attribute points at a file on disk.
 * Excludes references (Reference, ProjectReference, PackageReference),
 * imports and logical folders (Folder / Filter).
 */
const FILE_ITEM_TAGS = new Set<string>([
  // C++ (vcxproj)
  "ClCompile",
  "ClInclude",
  "ResourceCompile",
  "Midl",
  "MASM",
  "CustomBuild",
  "Natvis",
  "AppxManifest",
  // C# / shared (csproj + vcxproj)
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

/** Decode the handful of XML entities MSBuild paths realistically contain. */
export function decodeXmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&"); // amp last so pre-encoded entities stay intact
}

export function parseMsBuildProject(text: string): MsBuildProjectInfo {
  // Strip BOM; tolerate empty / non-XML input.
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
      continue; // root <Project> never carries a file Include
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
