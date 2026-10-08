export const SKILL_GATED_TOOLS: Readonly<Record<string, string>> = {
  approve_patch_candidate: "self-healing",
  edit_workflow_patch: "workflow-authoring",
  inspect_workflow: "workflow-authoring",
  start_connector_from_description: "connector-creation-guidance",
  start_connector_from_template: "connector-creation-guidance",
  update_connector_draft: "connector-creation-guidance",
};

export function requiredSkillFor(toolName: string): string | undefined {
  return SKILL_GATED_TOOLS[toolName];
}

export function filterBySkillGate<T extends { name: string }>(
  tools: T[],
  loadedSkills: ReadonlyArray<string>,
): T[] {
  return tools.filter((t) => {
    const req = requiredSkillFor(t.name);
    return !req || loadedSkills.includes(req);
  });
}
