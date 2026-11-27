import { ToolReturnCode } from "../../session/returnCodes.js";
import { HEADLESS_ASK_CANCELLED_TEXT } from "../../session/headlessAsk.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import { formatAskAnswerText, normalizeAskOptions } from "../../shared/askUser.js";

export const askUserDefinition: ToolDefinition = {
  name: "ask_user",
  description:
    'Ask one clear question and wait for the answer. Only question is required; omit options for a free response, otherwise give 2–4 short options and set multiple:true only when choices can be combined (single choice is the default). The UI always adds a multiline custom answer and per-option details, so never add an Other/Custom option. Avoid ASCII double quotes in question/label/description — use 「」 or single quotes. Returns JSON: selected_options (labels), custom_answer (text or null), comment (details or null) — treat comment as part of the user\'s instructions.',
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        minLength: 1,
        description: "One self-contained question in the user's language with enough context to decide; one decision per call; keep each call small. Independent questions: emit several ask_user calls in one response.",
      },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", minLength: 1, description: "Short, distinct label (≤ 40 characters)." },
            description: { type: "string", description: "One sentence on the outcome or tradeoff (≤ 80 characters)." },
            recommended: { type: "boolean", description: "Badge only; mark at most one, never preselects." },
          },
          required: ["label"],
          additionalProperties: false,
        },
        description:
          '2–4 option objects {label, description?, recommended?} (plain strings are rejected). Omit or pass [] for a free response. Labels ≤ 40 chars, no letter prefixes, rationale in description.',
      },
      multiple: {
        type: "boolean",
        description:
          "true only when the user may combine options (default false); ignored when options is empty.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

const LEAKED_JSON_TAIL = /"\s*[\]}][\]}'";,\s]*$/;
const FIELD_FRAGMENT = /^\s*"?(label|description|recommended)"?\s*:/i;

function checkAskArguments(question: string, rawOptions: unknown): string | null {
  if (LEAKED_JSON_TAIL.test(question)) {
    return 'Invalid arguments: "question" ends with leftover JSON punctuation. Resend with the question text only.';
  }
  if (!Array.isArray(rawOptions)) return null;
  const seen = new Set<string>();
  for (let i = 0; i < rawOptions.length; i += 1) {
    const item = rawOptions[i];
    const source = typeof item === "string" ? { label: item } : item;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return `Invalid arguments: "options[${i}]" must be an object with a "label".`;
    }
    const label = typeof source.label === "string" ? source.label.trim() : "";
    const description = typeof source.description === "string" ? source.description : "";
    if (!label) {
      return `Invalid arguments: "options[${i}].label" is empty. Every option needs a non-empty label.`;
    }
    if (FIELD_FRAGMENT.test(label) || FIELD_FRAGMENT.test(description)) {
      return `Invalid arguments: "options[${i}]" contains a field name as text (${JSON.stringify(label.slice(0, 40))}). Pass options as objects like {"label":"…","description":"…"}.`;
    }
    if (LEAKED_JSON_TAIL.test(label) || LEAKED_JSON_TAIL.test(description)) {
      return `Invalid arguments: "options[${i}]" text ends with leftover JSON punctuation. Avoid ASCII double quotes inside option text.`;
    }
    if (seen.has(label)) {
      return `Invalid arguments: duplicate option label ${JSON.stringify(label)}. Labels must be distinct.`;
    }
    seen.add(label);
  }
  return null;
}

export const askUserHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const question =
    typeof args.question === "string" ? args.question.trim() : "";
  if (!question) {
    return failureResult(
      'Invalid arguments: "question" (non-empty string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const invalid = checkAskArguments(question, args.options);
  if (invalid) return failureResult(invalid, ToolReturnCode.InvalidArguments);

  const optionDetails = normalizeAskOptions(args.options);
  const options = optionDetails.map(option => option.label);
  const openEnded = options.length === 0;
  const allowCustom =
    openEnded ||
    (typeof args.allow_custom === "boolean" ? args.allow_custom : true);
  const allowMultiple =
    !openEnded &&
    (typeof args.multiple === "boolean" ? args.multiple : args.allow_multiple === true);

  if (!context.requestUserAsk) {
    return failureResult(
      "ask_user is not available in this runtime.",
      ToolReturnCode.GenericFailure,
    );
  }

  const answer = await context.requestUserAsk({
    question,
    options,
    ...(optionDetails.some(option => option.description || option.recommended) ? { optionDetails } : {}),
    allowCustom,
    allowMultiple,
  });

  const abortedAfter = abortIfSignaled(context.signal);
  if (abortedAfter) return abortedAfter;

  if (!answer) {
    return failureResult(
      context.headlessMode === true
        ? HEADLESS_ASK_CANCELLED_TEXT
        : "User did not answer (cancelled).",
      ToolReturnCode.Cancelled,
    );
  }

  context.resetModelIterations?.();

  return textResult(formatAskAnswerText(answer, openEnded), ToolReturnCode.Success);
};
