import type { JsonObject } from "../types.js";
import type { HandoffOption, HandoffRequest, HandoffWatch } from "./handoff.js";
import { screenShowsOnce, type ScreenShows } from "./screenWatch.js";
import type { ComputerUseService } from "./service.js";
import type { Rect } from "./types.js";
import { ComputerUseError } from "./worker.js";

export const HANDOFF_KINDS = ["action", "choice", "confirm", "password", "qr_code"] as const;
export const HANDOFF_WAIT_UNTIL = ["appears", "disappears", "title_contains", "screen_shows"] as const;
export const HANDOFF_MAX_OPTIONS = 6;
export const HANDOFF_MIN_TIMEOUT_S = 10;
export const HANDOFF_MAX_TIMEOUT_S = 3_600;
const TARGET_FIND_TIMEOUT_S = 5;
const WATCH_FIND_TIMEOUT_S = 2;

export class HandoffArgumentError extends Error {}

export type HandoffLookup = Pick<ComputerUseService, "uiFind" | "uiWindows"> & Partial<Pick<ComputerUseService, "ocrScreen">>;

export type ParsedHandoff = {
  request: HandoffRequest;
  anchored: boolean;
  targetMissed: boolean;
  passwordApp?: string | number;
  signInFailed?: boolean;
  qrCode?: boolean;
};

type ElementQuery = { app: string | number; role?: string; name?: string; windowTitle?: string };

function text(value: unknown, key: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HandoffArgumentError(`"${key}" must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new HandoffArgumentError(`"${key}" must be at most ${max} characters; keep it short.`);
  return trimmed;
}

function object(value: unknown, key: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new HandoffArgumentError(`"${key}" must be an object.`);
  return value as JsonObject;
}

function appRef(value: unknown, key: string): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new HandoffArgumentError(`"${key}" must be an app name, bundle id or pid.`);
}

function regionOf(value: unknown, key: string): Rect {
  if (!Array.isArray(value) || value.length !== 4 || value.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new HandoffArgumentError(`"${key}" must be [x, y, width, height].`);
  }
  const [x, y, width, height] = value as number[];
  if (width! <= 0 || height! <= 0) throw new HandoffArgumentError(`"${key}" width and height must be positive.`);
  return { x: x!, y: y!, width: width!, height: height! };
}

function options(value: unknown): HandoffOption[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > HANDOFF_MAX_OPTIONS) {
    throw new HandoffArgumentError(`kind=choice needs 2–${HANDOFF_MAX_OPTIONS} "options".`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const source = typeof item === "string" ? { label: item } : object(item, `options[${index}]`);
    const label = text(source?.label, `options[${index}].label`, 40);
    if (!label) throw new HandoffArgumentError(`"options[${index}].label" is empty.`);
    if (seen.has(label)) throw new HandoffArgumentError(`Duplicate option label ${JSON.stringify(label)}.`);
    seen.add(label);
    const detail = text(source?.detail, `options[${index}].detail`, 60);
    return { label, ...(detail ? { detail } : {}) };
  });
}

function elementQuery(source: JsonObject, key: string): ElementQuery {
  const app = appRef(source.app, `${key}.app`);
  if (app === undefined) throw new HandoffArgumentError(`"${key}.app" is required.`);
  const role = text(source.role, `${key}.role`, 80);
  const name = text(source.name, `${key}.name`, 200);
  const windowTitle = text(source.window_title, `${key}.window_title`, 200);
  return { app, ...(role ? { role } : {}), ...(name ? { name } : {}), ...(windowTitle ? { windowTitle } : {}) };
}

function requireLookup(lookup: HandoffLookup | null, key: string): HandoffLookup {
  if (!lookup) throw new HandoffArgumentError(`"${key}" needs computer use (macOS or Windows).`);
  return lookup;
}

async function resolveTarget(source: JsonObject | undefined, lookup: HandoffLookup | null): Promise<{ anchor: Rect | null; missed: boolean }> {
  if (!source) return { anchor: null, missed: false };
  if (source.region !== undefined) return { anchor: regionOf(source.region, "target.region"), missed: false };
  const query = elementQuery(source, "target");
  const index = source.index === undefined ? 0 : source.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new HandoffArgumentError('"target.index" must be a non-negative integer.');
  }
  try {
    const found = await requireLookup(lookup, "target").uiFind({ ...query, timeoutS: TARGET_FIND_TIMEOUT_S });
    const frame = found.matches[index]?.frame;
    return frame && frame.width > 0 && frame.height > 0 ? { anchor: frame, missed: false } : { anchor: null, missed: true };
  } catch (error) {
    if (error instanceof HandoffArgumentError) throw error;
    return { anchor: null, missed: true };
  }
}

function buildWatch(source: JsonObject | undefined, lookup: HandoffLookup | null): HandoffWatch | undefined {
  if (!source) return undefined;
  const until = source.until;
  if (typeof until !== "string" || !(HANDOFF_WAIT_UNTIL as readonly string[]).includes(until)) {
    throw new HandoffArgumentError(`"wait_for.until" must be one of ${HANDOFF_WAIT_UNTIL.join(", ")}.`);
  }
  const svc = requireLookup(lookup, "wait_for");
  if (until === "screen_shows") {
    const wanted = text(source.text, "wait_for.text", 200);
    if (!wanted) throw new HandoffArgumentError('wait_for.until=screen_shows requires "wait_for.text".');
    const area = source.region === undefined ? undefined : regionOf(source.region, "wait_for.region");
    const ocr = svc.ocrScreen?.bind(svc);
    if (!ocr) throw new HandoffArgumentError('wait_for.until=screen_shows needs screen OCR.');
    let previous: ScreenShows | null = null;
    return {
      check: async (signal) => {
        previous = await screenShowsOnce(ocr, wanted, area, { signal }, previous);
        return previous.status === "yes";
      },
    };
  }
  if (until === "title_contains") {
    const app = appRef(source.app, "wait_for.app");
    if (app === undefined) throw new HandoffArgumentError('"wait_for.app" is required.');
    const needle = text(source.text, "wait_for.text", 200)?.toLowerCase();
    if (!needle) throw new HandoffArgumentError('wait_for.until=title_contains requires "wait_for.text".');
    return {
      check: async () => {
        const result = await svc.uiWindows(app);
        const windows = Array.isArray(result.windows) ? (result.windows as Array<{ title?: unknown }>) : [];
        return windows.some((w) => typeof w.title === "string" && w.title.toLowerCase().includes(needle));
      },
    };
  }
  const query = elementQuery(source, "wait_for");
  if (!query.role && !query.name) throw new HandoffArgumentError(`wait_for.until=${until} requires "wait_for.role" or "wait_for.name".`);
  const wantPresent = until === "appears";
  return {
    check: async () => {
      try {
        const found = await svc.uiFind({ ...query, timeoutS: WATCH_FIND_TIMEOUT_S });
        if (found.truncated === true && found.matches.length === 0) return false;
        return wantPresent ? found.matches.length > 0 : found.matches.length === 0;
      } catch (error) {
        if (!wantPresent && error instanceof ComputerUseError && error.code === "not_found") return true;
        throw error;
      }
    },
  };
}

function timeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HandoffArgumentError('"timeout_s" must be a number.');
  const seconds = Math.min(HANDOFF_MAX_TIMEOUT_S, Math.max(HANDOFF_MIN_TIMEOUT_S, value));
  return Math.round(seconds * 1000);
}

export async function parseHandoffRequest(args: JsonObject, lookup: HandoffLookup | null): Promise<ParsedHandoff> {
  const kindValue = args.kind ?? "action";
  if (typeof kindValue !== "string" || !(HANDOFF_KINDS as readonly string[]).includes(kindValue)) {
    throw new HandoffArgumentError(`"kind" must be one of ${HANDOFF_KINDS.join(", ")}.`);
  }
  const kind = kindValue === "choice" || kindValue === "confirm" ? kindValue : "action";
  const title = text(args.title, "title", 80);
  if (!title) throw new HandoffArgumentError('"title" is required.');
  const message = text(args.message, "message", 240) ?? "";
  const primaryLabel = text(args.confirm_label, "confirm_label", 24);
  const secondaryLabel = text(args.cancel_label, "cancel_label", 24);
  const choiceOptions = kind === "choice" ? options(args.options) : undefined;
  const watch = buildWatch(object(args.wait_for, "wait_for"), lookup);
  const timeout = timeoutMs(args.timeout_s);
  const targetSource = object(args.target, "target");
  if (args.password !== undefined && typeof args.password !== "boolean") {
    throw new HandoffArgumentError('"password" must be a boolean.');
  }
  if (args.qr_code !== undefined && typeof args.qr_code !== "boolean") {
    throw new HandoffArgumentError('"qr_code" must be a boolean.');
  }
  const qrCode = kindValue === "qr_code" || args.qr_code === true;
  const password = kindValue === "password" || args.password === true ||
    (kindValue === "action" && args.password === undefined && !qrCode &&
      typeof targetSource?.role === "string" && targetSource.role.toLowerCase() === "axsecuretextfield");
  const passwordApp = password ? appRef(targetSource?.app, "target.app") : undefined;
  if (password && (kind !== "action" || passwordApp === undefined)) {
    throw new HandoffArgumentError('Password handoff requires "target.app" for the secure field.');
  }
  if (args.sign_in_failed !== undefined && (!password || typeof args.sign_in_failed !== "boolean")) {
    throw new HandoffArgumentError('"sign_in_failed" is a boolean for password handoff only.');
  }
  if (qrCode && (kind !== "action" || !targetSource || password)) {
    throw new HandoffArgumentError('QR handoff requires a target around the code and must be a separate request from a password.');
  }
  const target = passwordApp === undefined
    ? await resolveTarget(targetSource, lookup)
    : { anchor: targetSource?.region === undefined ? null : regionOf(targetSource.region, "target.region"), missed: false };
  const request: HandoffRequest = {
    kind,
    title,
    message,
    ...(choiceOptions ? { options: choiceOptions } : {}),
    ...(primaryLabel ? { primaryLabel } : {}),
    ...(secondaryLabel ? { secondaryLabel } : {}),
    ...(target.anchor ? { anchor: target.anchor } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    ...(watch ? { watch } : {}),
    ...(kind === "choice" && args.allow_custom === true ? { allowCustom: true } : {}),
  };
  return {
    request,
    anchored: Boolean(target.anchor),
    targetMissed: target.missed,
    ...(passwordApp !== undefined ? { passwordApp } : {}),
    ...(args.sign_in_failed === true ? { signInFailed: true } : {}),
    ...(qrCode ? { qrCode: true } : {}),
  };
}
