import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function resolveProjectPath(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value.replace(/[\\/]/g, "/"));
}

export type NativeConfiguration = {
  additionalTargets: Array<{ target: string; platform: string; configuration: string }>;
  key: string;
  target: string;
  platform: string;
  configuration: string;
  architecture: string;
  output: string | null;
};

/** Extract actual NMake configurations, including UBT's -Target="..." form. */
export function parseNativeConfigurations(text: string, projectPath: string): NativeConfiguration[] {
  const out: NativeConfiguration[] = [];
  for (const match of text.matchAll(/<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi)) {
    const body = match[2]!;
    const command = decodeXml(/<NMakeBuildCommandLine>([\s\S]*?)<\/NMakeBuildCommandLine>/i.exec(body)?.[1] ?? "");
    if (!command) continue;
    const config = /(?:-Target="|\)\s+|Build\.(?:bat|sh)"?\s+)([\w.-]+)\s+([\w]+)\s+(DebugGame|Debug|Development|Shipping|Test)\b/i.exec(command);
    if (!config) continue;
    const condition = decodeXml(match[1]!);
    const key = /==\s*'([^']+)'/.exec(condition)?.[1];
    if (!key) continue;
    const rawOutput = decodeXml(/<NMakeOutput>([\s\S]*?)<\/NMakeOutput>/i.exec(body)?.[1] ?? "").trim();
    const additionalTargets = [...command.matchAll(/-Target="([\w.-]+)\s+(\w+)\s+(DebugGame|Debug|Development|Shipping|Test)\b/gi)]
      .slice(1).map(m => ({ target: m[1]!, platform: m[2]!, configuration: m[3]! }));
    out.push({ key, target: config[1]!, platform: config[2]!, configuration: config[3]!, additionalTargets,
      architecture: /-architecture=([\w+.-]+)/i.exec(command)?.[1] ?? "",
      output: rawOutput && !rawOutput.includes("$(") ? resolveProjectPath(dirname(projectPath), rawOutput) : null });
  }
  return out;
}

export type RiderHeader = {
  Name?: string; Configuration?: string; Platform?: string; TargetFile?: string; ProjectFile?: string;
  ToolchainInfo?: { Architecture?: string };
  BuildInfo?: { Output?: string; BuildCmd?: { Command: string; Args: string } };
};

/** Rider files contain tens of MB of includes; read only the small build header. */
export async function readRiderHeader(path: string): Promise<RiderHeader | null> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const end = /,\s*"(?:EnvironmentIncludePaths|EnvironmentDefinitions|Binaries|Modules)"\s*:/.exec(text);
    return JSON.parse(end ? text.slice(0, end.index) + "}" : text) as RiderHeader;
  } catch { return null; }
  finally { await file.close(); }
}

export async function readText(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}
