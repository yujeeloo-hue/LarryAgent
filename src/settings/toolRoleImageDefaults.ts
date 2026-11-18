
export type ToolRoleImageTransport = "url" | "base64";

export type ToolRoleImageSupport =
  | { enabled: true; transport: ToolRoleImageTransport }
  | { enabled: false };

export type ToolRoleImageProviderInfo = {
  baseUrl: string;
  modelId: string;
  supportsMultimodal?: boolean;
  toolRoleImages?: boolean;
  imageInput?: "url" | "base64" | "file";
};

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isBigmodelHost(host: string): boolean {
  return host === "open.bigmodel.cn" || host.endsWith(".bigmodel.cn");
}

function isDeepSeekHost(host: string): boolean {
  return host === "api.deepseek.com" || host.endsWith(".deepseek.com");
}

function onVerifiedList(info: ToolRoleImageProviderInfo): boolean {
  const host = hostOf(info.baseUrl);
  if (isBigmodelHost(host)) {
    return info.modelId.trim().toLowerCase() === "glm-5.3-flash";
  }
  return isDeepSeekHost(host);
}

export function resolveToolRoleImageSupport(
  info: ToolRoleImageProviderInfo | null | undefined,
): ToolRoleImageSupport {
  if (!info || info.supportsMultimodal !== true) return { enabled: false };
  const explicit = info.toolRoleImages;
  if (explicit === false) return { enabled: false };
  if (explicit !== true && !onVerifiedList(info)) return { enabled: false };
  const host = hostOf(info.baseUrl);
  if (isBigmodelHost(host)) {
    return { enabled: true, transport: "url" };
  }
  return {
    enabled: true,
    transport: info.imageInput === "url" ? "url" : "base64",
  };
}