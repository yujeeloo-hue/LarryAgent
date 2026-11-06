export {
  fuzzyFindAndReplace,
  isAlreadyApplied,
  formatNoMatchHint,
  type FuzzyReplaceResult,
  type MatchSpan,
} from "./fuzzyMatch.js";
export {
  parseV4aPatch,
  extractV4aPaths,
  applyV4aOperations,
  type V4aApplyResult,
  type V4aFileChange,
  type V4aHunk,
  type V4aHunkLine,
  type V4aOpKind,
  type V4aOperation,
} from "./v4a.js";
