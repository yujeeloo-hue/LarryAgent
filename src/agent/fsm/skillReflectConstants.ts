/**
 * Skill-reflect phase constants (pre-end auto skill summarization).
 */

/** Enter reflect only when main-loop modelIterations > this. */
export const SKILL_REFLECT_MIN_MODEL_ITERATIONS = 8;

/** Enter reflect only when this many tools returned non-zero returnCode. */
export const SKILL_REFLECT_MIN_TOOL_FAILURES = 1;

/** Tools offered during skill_reflect (strict allowlist). */
export const SKILL_REFLECT_TOOL_ALLOWLIST: readonly string[] = [
  "search_skills",
  "read_skill",
  "create_skill",
  "update_skill",
  "write_skill_file",
  "list_dir",
  "read_file",
];

/** Turn blackboard keys for skill_reflect_gate Compare + RouteTo stack. */
export const SKILL_REFLECT_FLAG_AUTO = "reflect.auto";
export const SKILL_REFLECT_FLAG_FULL_PERMS = "reflect.fullPerms";
export const SKILL_REFLECT_FLAG_ENOUGH_ITERS = "reflect.enoughIters";
export const SKILL_REFLECT_FLAG_ENOUGH_FAILS = "reflect.enoughFails";

