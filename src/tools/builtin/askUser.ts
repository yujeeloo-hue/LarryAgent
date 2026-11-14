import { ToolReturnCode } from "../../session/returnCodes.js";
import { HEADLESS_ASK_CANCELLED_TEXT } from "../../session/headlessAsk.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import { formatAskAnswerText, normalizeAskOptions } from "../../shared/askUser.js";

/** Default level: 0 — interaction is the ask UI itself. */
export const askUserDefinition: ToolDefinition = {
  name: "ask_user",
  description:
    'Ask one clear question and wait for the user to confirm an answer. Only question is required. Omit options for a free response; otherwise supply short option objects. Single choice is the default; use multiple:true only when choices can be combined. The UI always offers a multiline custom answer and optional details for selected options, so do not add an Other or Custom answer option. Never put ASCII double quotes (") inside question, label or description text; use 「」 or single quotes instead. Returns JSON with selected_options (an array of labels), custom_answer (free text or null), and comment (details accompanying selections or null). Treat the comment as part of the user\'s instructions.',
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        minLength: 1,
        description: "One self-contained question in the user's language. Include enough context to decide; ask one decision per call. To ask several independent questions, emit all the ask_user calls in the same response so the user answers them back to back; keep each call small.",
      },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", minLength: 1, description: "Short, distinct answer label (≤ 40 characters). Keep rationale in description; do not include a letter prefix or a Custom answer option." },
            description: { type: "string", description: "Optional one-sentence explanation of the outcome or tradeoff (≤ 80 characters)." },
            recommended: { type: "boolean", description: "Optional recommendation badge, default false. Mark at most one option; this never preselects or submits it." },
          },
          required: ["label"],
          additionalProperties: false,
        },
        description:
          'Optional answer choices, normally 2–4 distinct objects, e.g. [{"label":"Preview first","description":"Review before implementation","recommended":true},{"label":"Implement now"}]. Every item must be an object with a non-empty label; plain strings are rejected. Omit or pass [] for a free response. Do not add Other: the UI supplies custom input.',
      },
      multiple: {
        type: "boolean",
        description:
          "Optional, default false (single choice). Set true only when the user may combine multiple options. Ignored when options is empty or omitted.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

/** Closing JSON punctuation leaked into a text field, e.g. `…?"]` or `…"}';`. */
const LEAKED_JSON_TAIL = /"\s*[\]}][\]}'";,\s]*$/;
/** Option text that is a field fragment instead of content, e.g. `label: `. */
const FIELD_FRAGMENT = /^\s*"?(label|description|recommended)"?\s*:/i;

/**
 * Reject malformed calls with an actionable message instead of silently
 * dropping entries, so the model rewrites the call.
 */
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

  // No options → open-ended ask: the user answers in free text.
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
