/**
 * Tool-result images ("read_image direct"): known-good provider list +
 * transport resolution. Probe-verified 2026-11-05 (see
 * docs/plans/20261105-direct-read-image-tool-role-images.md):
 *
 * - DeepSeek (api.deepseek.com, vision models): tool-role content arrays
 *   accept base64 data URIs; https URLs untested → default to the probe-
 *   verified form (base64) unless imageInput explicitly says "url".
 * - GLM-5.3-Flash on open.bigmodel.cn main endpoints: tool-role images work
 *   ONLY as https URLs — data URIs inside the parts array get silently
 *   stringified into text by the gateway (200 OK + wrong answers). The
 *   URL channel is forced for every bigmodel host.
 * - GLM-5.3 flagship / GLM coding endpoints / Moonshot files API: no
 *   tool-role images at all (text-only or silently dropped).
 *
 * Keep this module dependency-free (renderer imports it too).
 */

export type ToolRoleImageTransport = "url" | "base64";

export type ToolRoleImageSupport =
  | { enabled: true; transport: ToolRoleImageTransport }
  | { enabled: false };

/** Minimal structural input — satisfied by LlmProvider and renderer forms. */
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

/** Verified default-on list; explicit provider settings override it. */
function onVerifiedList(info: ToolRoleImageProviderInfo): boolean {
  const host = hostOf(info.baseUrl);
  if (isBigmodelHost(host)) {
    // glm-5.3-flash only — flagship glm-5.3 and coding endpoints are
    // text-only (probe matrix 2026-11-05).
    return info.modelId.trim().toLowerCase() === "glm-5.3-flash";
  }
  // DeepSeek vision models (deepseek-flash line).
  return isDeepSeekHost(host);
}

/**
 * Whether tool results may carry `image_url` parts on the model wire for
 * this provider, and through which transport. `enabled` is false unless
 * the provider is multimodal AND (explicitly enabled OR on the verified
 * list). Explicit `toolRoleImages: false` always wins.
 */
export function resolveToolRoleImageSupport(
  info: ToolRoleImageProviderInfo | null | undefined,
): ToolRoleImageSupport {
  if (!info || info.supportsMultimodal !== true) return { enabled: false };
  const explicit = info.toolRoleImages;
  if (explicit === false) return { enabled: false };
  if (explicit !== true && !onVerifiedList(info)) return { enabled: false };
  const host = hostOf(info.baseUrl);
  if (isBigmodelHost(host)) {
    // bigmodel gateways stringify data-URI tool parts — force S3 URLs.
    return { enabled: true, transport: "url" };
  }
  return {
    enabled: true,
    // Untested transports are never the default: DeepSeek defaults to the
    // probe-verified base64 form; "url" only when explicitly configured.
    transport: info.imageInput === "url" ? "url" : "base64",
  };
}