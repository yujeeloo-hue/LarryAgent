/**
 * Skill-reflect phase constants (pre-end auto skill summarization).
 */

/** Recovery path: whole-turn model iterations must exceed this. */
export const SKILL_REFLECT_MIN_MODEL_ITERATIONS = 8;

/** Recovery path: at least this many tool errors were later recovered. */
export const SKILL_REFLECT_MIN_RECOVERIES = 1;

/** Long-run path: whole-turn model iterations at or above this. */
export const SKILL_REFLECT_LONG_RUN_ITERATIONS = 20;

/** Used-skill path: at least this many distinct skills were read. */
export const SKILL_REFLECT_MIN_SKILLS_READ = 1;

/** Tools offered during skill_reflect (strict allowlist). */
export const SKILL_REFLECT_TOOL_ALLOWLIST: readonly string[] = [
  "search_skills",
  "read_skill",
  "create_skill",
  "update_skill",
  "patch_skill",
  "merge_skills",
  "deprecate_skill",
  "write_skill_file",
  "list_dir",
  "read_file",
];

/** Turn blackboard keys for skill_reflect_gate Compare + RouteTo stack. */
export const SKILL_REFLECT_FLAG_AUTO = "reflect.auto";
export const SKILL_REFLECT_FLAG_FULL_PERMS = "reflect.fullPerms";
export const SKILL_REFLECT_FLAG_ENOUGH_ITERS = "reflect.enoughIters";
export const SKILL_REFLECT_FLAG_RECOVERED = "reflect.recovered";
export const SKILL_REFLECT_FLAG_LONG_RUN = "reflect.longRun";
export const SKILL_REFLECT_FLAG_USED_SKILL = "reflect.usedSkill";

/** Gate eligibility expression over the flags above. */
export const SKILL_REFLECT_GATE_EXPR = [
  `${SKILL_REFLECT_FLAG_AUTO} && ${SKILL_REFLECT_FLAG_FULL_PERMS} && (`,
  `(${SKILL_REFLECT_FLAG_ENOUGH_ITERS} && ${SKILL_REFLECT_FLAG_RECOVERED})`,
  ` || ${SKILL_REFLECT_FLAG_LONG_RUN} || ${SKILL_REFLECT_FLAG_USED_SKILL})`,
].join("");

