import type { ClangdSignature, ClangdSignatureHelpResult } from "./types.js";

function documentationOf(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw || undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const { value, kind } = raw as { value?: unknown; kind?: unknown };
  if (typeof value !== "string" || !value) return undefined;
  return kind === "plaintext" ? value.replace(/[\\`*_{}\[\]<>#+|]/g, "\\$&") : value;
}

/** Keep documentation alongside labels instead of dropping it at the IPC boundary. */
export function parseSignatureHelp(raw: unknown): Extract<ClangdSignatureHelpResult, { ok: true }> {
  const result: Extract<ClangdSignatureHelpResult, { ok: true }> = { ok: true, signatures: [], activeSignature: 0 };
  if (!raw || typeof raw !== "object") return result;
  const source = raw as { signatures?: unknown; activeSignature?: unknown; activeParameter?: unknown };
  if (!Array.isArray(source.signatures)) return result;
  for (const entry of source.signatures) {
    if (!entry || typeof entry !== "object" || typeof entry.label !== "string") continue;
    const label: string = entry.label;
    const rawParams: unknown[] = Array.isArray(entry.parameters) ? entry.parameters : [];
    const parameters = rawParams.map((p) => {
      const value = p && typeof p === "object" ? (p as { label?: unknown }).label : undefined;
      if (typeof value === "string") return value;
      if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) && value[0] >= 0 && value[1] >= value[0] && value[1] <= label.length) return label.slice(value[0], value[1]);
      return "";
    });
    const parameterDocumentation = rawParams.map((p) => documentationOf(p && typeof p === "object" ? (p as { documentation?: unknown }).documentation : undefined) ?? "");
    const documentation = documentationOf(entry.documentation);
    const active = entry.activeParameter ?? source.activeParameter;
    const signature: ClangdSignature = {
      label,
      parameters,
      activeParameter: typeof active === "number" && Number.isInteger(active) && active >= 0 ? Math.min(active, Math.max(0, parameters.length - 1)) : 0,
      ...(documentation ? { documentation } : {}),
      ...(parameterDocumentation.some(Boolean) ? { parameterDocumentation } : {}),
    };
    result.signatures.push(signature);
  }
  if (typeof source.activeSignature === "number" && Number.isInteger(source.activeSignature) && source.activeSignature >= 0 && source.activeSignature < result.signatures.length) result.activeSignature = source.activeSignature;
  return result;
}
