
export const SKILL_REFLECT_MIN_MODEL_ITERATIONS = 8;

export const SKILL_REFLECT_MIN_RECOVERIES = 1;

export const SKILL_REFLECT_LONG_RUN_ITERATIONS = 20;

export const SKILL_REFLECT_MIN_SKILLS_READ = 1;

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

export const SKILL_REFLECT_FLAG_AUTO = "reflect.auto";
export const SKILL_REFLECT_FLAG_FULL_PERMS = "reflect.fullPerms";
export const SKILL_REFLECT_FLAG_ENOUGH_ITERS = "reflect.enoughIters";
export const SKILL_REFLECT_FLAG_RECOVERED = "reflect.recovered";
export const SKILL_REFLECT_FLAG_LONG_RUN = "reflect.longRun";
export const SKILL_REFLECT_FLAG_USED_SKILL = "reflect.usedSkill";

export const SKILL_REFLECT_GATE_EXPR = [
  `${SKILL_REFLECT_FLAG_AUTO} && ${SKILL_REFLECT_FLAG_FULL_PERMS} && (`,
  `(${SKILL_REFLECT_FLAG_ENOUGH_ITERS} && ${SKILL_REFLECT_FLAG_RECOVERED})`,
  ` || ${SKILL_REFLECT_FLAG_LONG_RUN} || ${SKILL_REFLECT_FLAG_USED_SKILL})`,
].join("");

