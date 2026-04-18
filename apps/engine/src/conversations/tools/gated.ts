// Skill-gated tool map. When a tool requires a specific skill to have
// been loaded via `load_skill`, the loop filters it out of the palette
// until the requirement is met.
//
// Kept in code (not DB) because the set is an engineering invariant,
// not operator-configurable — a tool either needs its skill's knowledge
// or it doesn't.

/** tool name → required skill slug. Missing entries imply no gate. */
export const SKILL_GATED_TOOLS: Readonly<Record<string, string>> = {
  // Example: approving a patch candidate requires the self-healing skill
  // so the model knows the classification semantics before it approves.
  approve_patch_candidate: "self-healing",
  // Running a workflow in `prod` mode requires the deployment skill.
  // (The `run_workflow` tool takes an `environment` arg; we gate the
  // whole tool via the skill — prod confirmation happens in CP9 via
  // the confirmation state machine.)
};

export function requiredSkillFor(toolName: string): string | undefined {
  return SKILL_GATED_TOOLS[toolName];
}

/**
 * Filter a list of tools by the loaded_skills set. Tools without a
 * `requires_skill` gate always pass; gated tools only pass if their
 * required skill is in `loadedSkills`.
 */
export function filterBySkillGate<T extends { name: string }>(
  tools: T[],
  loadedSkills: ReadonlyArray<string>,
): T[] {
  return tools.filter((t) => {
    const req = requiredSkillFor(t.name);
    return !req || loadedSkills.includes(req);
  });
}
