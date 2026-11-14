/**
 * present_demo parameter declarations (plan §1/D5) — single source shared by
 * the main-process tool handler and both card renderers (desktop + relay
 * web). Pure data + validation only: no Node/Electron/DOM imports so every
 * surface consumes the exact same parse rules.
 */

/** Defensive cap on declared params (keeps the generated form reviewable). */
export const MAX_DEMO_PARAMS = 32;

export type DemoParamType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "color";

/** Normalized param declaration rendered as one form control on the card. */
export type DemoParamSpec = {
  name: string;
  label: string;
  type: DemoParamType;
  default: string | number | boolean;
  /** select only — ≥2 trimmed choices including the default. */
  options?: string[];
  /** number only. */
  min?: number;
  max?: number;
  step?: number;
  /** string only. */
  placeholder?: string;
  /** Value may be left empty (form-side; a default is still required). */
  optional?: boolean;
};

export type ParsedDemoParams =
  | { ok: true; params: DemoParamSpec[] }
  | { ok: false; error: string };

/** Number params with a usable min<max range render as a slider (v1.1). */
export function isSliderNumberSpec(spec: DemoParamSpec): boolean {
  return (
    spec.type === "number" &&
    typeof spec.min === "number" &&
    typeof spec.max === "number" &&
    spec.min < spec.max
  );
}

/** Readout decimals derived from step (integer/absent step → 0). */
export function sliderDecimals(step: number | undefined): number {
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Validate the declared params (plan §1): names unique, defaults required and
 * type-matched, select needs ≥2 options including the default, number bounds
 * must hold. Errors name the offending field so the model can self-correct.
 */
export function parseDemoParams(raw: unknown): ParsedDemoParams {
  if (raw === undefined || raw === null) return { ok: true, params: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        'Invalid arguments: "params" must be an array of parameter objects.',
    };
  }
  if (raw.length > MAX_DEMO_PARAMS) {
    return {
      ok: false,
      error: `Invalid arguments: "params" supports at most ${MAX_DEMO_PARAMS} parameters (got ${raw.length}).`,
    };
  }

  const params: DemoParamSpec[] = [];
  const names = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        error: `Invalid arguments: params[${i}] must be an object.`,
      };
    }
    const record = item as Record<string, unknown>;

    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      return {
        ok: false,
        error: `Invalid arguments: params[${i}].name (non-empty string) is required.`,
      };
    }
    if (names.has(name)) {
      return {
        ok: false,
        error: `Invalid arguments: params[${i}].name "${name}" is duplicated — names must be unique.`,
      };
    }
    names.add(name);

    const type = record.type;
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "boolean" &&
      type !== "select" &&
      type !== "color"
    ) {
      return {
        ok: false,
        error: `Invalid arguments: params[${i}].type must be one of string, number, boolean, select, color.`,
      };
    }

    const def = record.default;
    if (type === "number") {
      if (typeof def !== "number" || !Number.isFinite(def)) {
        return {
          ok: false,
          error: `Invalid arguments: params[${i}].default must be a finite number for type number.`,
        };
      }
    } else if (type === "boolean") {
      if (typeof def !== "boolean") {
        return {
          ok: false,
          error: `Invalid arguments: params[${i}].default must be a boolean for type boolean.`,
        };
      }
    } else if (typeof def !== "string") {
      return {
        ok: false,
        error: `Invalid arguments: params[${i}].default must be a string for type ${type}.`,
      };
    }

    const spec: DemoParamSpec = {
      name,
      label:
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : name,
      type,
      default: def as string | number | boolean,
    };

    if (type === "select") {
      if (!Array.isArray(record.options)) {
        return {
          ok: false,
          error: `Invalid arguments: params[${i}].options (array of strings) is required for type select.`,
        };
      }
      const options: string[] = [];
      for (const opt of record.options) {
        if (typeof opt !== "string" || !opt.trim()) {
          return {
            ok: false,
            error: `Invalid arguments: params[${i}].options must contain non-empty strings.`,
          };
        }
        options.push(opt.trim());
      }
      if (options.length < 2) {
        return {
          ok: false,
          error: `Invalid arguments: params[${i}].options needs at least 2 choices for type select.`,
        };
      }
      const defaultLabel = (spec.default as string).trim();
      if (!defaultLabel || !options.includes(defaultLabel)) {
        return {
          ok: false,
          error: `Invalid arguments: params[${i}].default is not among params[${i}].options.`,
        };
      }
      spec.default = defaultLabel;
      spec.options = options;
    }

    if (type === "number") {
      if (record.min !== undefined) {
        if (typeof record.min !== "number" || !Number.isFinite(record.min)) {
          return {
            ok: false,
            error: `Invalid arguments: params[${i}].min must be a finite number.`,
          };
        }
        spec.min = record.min;
      }
      if (record.max !== undefined) {
        if (typeof record.max !== "number" || !Number.isFinite(record.max)) {
          return {
            ok: false,
            error: `Invalid arguments: params[${i}].max must be a finite number.`,
          };
        }
        spec.max = record.max;
      }
      if (
        spec.min !== undefined &&
        spec.max !== undefined &&
        spec.min > spec.max
      ) {
        return {
          ok: false,
          error: `Invalid arguments: params[${i}].min must be ≤ params[${i}].max.`,
        };
      }
      if (record.step !== undefined) {
        if (
          typeof record.step !== "number" ||
          !Number.isFinite(record.step) ||
          record.step <= 0
        ) {
          return {
            ok: false,
            error: `Invalid arguments: params[${i}].step must be a positive number.`,
          };
        }
        spec.step = record.step;
      }
      const value = spec.default as number;
      if (spec.min !== undefined && value < spec.min) {
        return {
          ok: false,
          error: `Invalid arguments: params[${i}].default is below params[${i}].min.`,
        };
      }
      if (spec.max !== undefined && value > spec.max) {
        return {
          ok: false,
          error: `Invalid arguments: params[${i}].default is above params[${i}].max.`,
        };
      }
    }

    if (typeof record.placeholder === "string" && record.placeholder.trim()) {
      spec.placeholder = record.placeholder;
    }
    if (record.optional === true) spec.optional = true;

    params.push(spec);
  }
  return { ok: true, params };
}
