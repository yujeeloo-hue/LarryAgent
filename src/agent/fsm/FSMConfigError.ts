export type FSMConfigErrorCode =
  | "INVALID_VERSION"
  | "MISSING_ENTRY"
  | "MISSING_TERMINAL"
  | "EMPTY_NODES"
  | "DUPLICATE_NODE"
  | "DUPLICATE_EDGE_ID"
  | "UNKNOWN_ACTION"
  | "UNKNOWN_EDGE"
  | "DANGLING_EDGE"
  | "NON_TERMINAL_NO_OUTGOING"
  | "EDGE_ALWAYS_NOT_ALONE"
  | "INVALID_EDGE_PARAMS"
  | "INVALID_ACTION_PARAMS"
  | "INVALID_NODE_ID"
  | "INVALID_PIN"
  | "PIN_EDGE_MISMATCH"
  | "DUPLICATE_PIN_EDGE"
  | "RETIRED_EDGE_KEY"
  | "ROLE_PROMPT_FILE_UNREADABLE";

/**
 * Structured config / hydrate failure (not a runtime Eval miss).
 */
export class FSMConfigError extends Error {
  readonly code: FSMConfigErrorCode;

  constructor(code: FSMConfigErrorCode, message: string) {
    super(message);
    this.name = "FSMConfigError";
    this.code = code;
  }
}
