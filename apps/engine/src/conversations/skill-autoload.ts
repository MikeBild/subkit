// Skill auto-loading driven by tool-call intent.
//
// The conversation loop calls `shouldAutoloadSkillsForTool(tool, input)`
// before each tool dispatch; any returned slug that is not already in
// `conversations.loaded_skills` gets appended so the next context
// assembly sees the skill body without the LLM having to remember to
// call `load_skill` manually.
//
// Baseline skills are always loaded on the first turn of every
// conversation (see `BASELINE_SKILLS`). Everything else is lazy — the
// skill only comes into scope when its associated tool is invoked.
// This keeps context tight and avoids polluting early turns with
// self-healing vocabulary that the operator may never need.

export const BASELINE_SKILLS: readonly string[] = ["subkit-concepts", "error-recovery"];

interface AutoloadRule {
  /** Exact tool name or a prefix match (ends with `*`). */
  tool: string;
  /** Optional predicate on the tool's input args; returns true to
   *  activate the rule. */
  match?: (input: unknown) => boolean;
  /** Skills to load. */
  skills: readonly string[];
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isGraphqlStep(step: Record<string, unknown>): boolean {
  return (
    step.graphql !== undefined ||
    step.driver === "graphql" ||
    asObj(step.config).driver === "graphql"
  );
}

const RULES: readonly AutoloadRule[] = [
  // Any probe or request-step authoring activates HTTP connector knowledge.
  { tool: "probe_connector", skills: ["http-connectors"] },
  {
    tool: "propose_step",
    match: (input) => {
      const step = asObj(asObj(input).step ?? input).kind;
      return step === "request";
    },
    skills: ["http-connectors"],
  },
  // A postgres-shaped driver (via step config.driver) pulls in the
  // postgres skill.
  {
    tool: "propose_step",
    match: (input) => {
      const obj = asObj(asObj(input).step ?? input);
      const cfg = asObj(obj.config);
      return cfg.driver === "postgres" || obj.driver === "postgres";
    },
    skills: ["postgres-connectors"],
  },
  {
    tool: "propose_step",
    match: (input) => {
      const obj = asObj(asObj(input).step ?? input);
      return isGraphqlStep(obj);
    },
    skills: ["graphql-connectors"],
  },
  {
    tool: "propose_step",
    match: (input) => {
      const obj = asObj(asObj(input).step ?? input);
      return obj.kind === "transform";
    },
    skills: ["data-handling"],
  },
  // Building a whole workflow benefits from the authoring skill + the
  // driver-specific skills inferred from its steps.
  {
    tool: "build_workflow",
    skills: ["workflow-authoring"],
  },
  {
    tool: "build_workflow",
    match: (input) => {
      const steps = asObj(input).steps as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(steps)) return false;
      return steps.some((s) => asObj(s.config).driver === "postgres");
    },
    skills: ["postgres-connectors"],
  },
  {
    tool: "build_workflow",
    match: (input) => {
      const steps = asObj(input).steps as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(steps)) return false;
      return steps.some((s) => asObj(s.config).driver === "s3" || asObj(s).driver === "s3");
    },
    skills: ["s3-connectors"],
  },
  {
    tool: "build_workflow",
    match: (input) => {
      const steps = asObj(input).steps as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(steps)) return false;
      return steps.some((step) => isGraphqlStep(asObj(step)));
    },
    skills: ["graphql-connectors"],
  },
  // Self-healing + RBAC tool calls pull in their specialised skills.
  { tool: "approve_patch_candidate", skills: ["self-healing"] },
  { tool: "approve_skill_candidate", skills: ["self-healing"] },
  { tool: "test_rbac_expression", skills: ["rbac-and-scopes"] },
  { tool: "approve_discovery_artifact", skills: ["workflow-authoring"] },
  { tool: "preview_attachment", skills: ["workflow-authoring"] },
];

/** Return the set of skill slugs this tool call should auto-load,
 *  excluding any already present in `currently_loaded`. Baseline skills
 *  are NOT returned here — add them explicitly at conversation start. */
export function shouldAutoloadSkillsForTool(
  tool: string,
  input: unknown,
  currently_loaded: readonly string[],
): string[] {
  const have = new Set(currently_loaded);
  const out = new Set<string>();
  for (const rule of RULES) {
    if (!ruleMatches(rule, tool, input)) continue;
    for (const skill of rule.skills) {
      if (!have.has(skill)) out.add(skill);
    }
  }
  return [...out];
}

function ruleMatches(rule: AutoloadRule, tool: string, input: unknown): boolean {
  if (rule.tool.endsWith("*")) {
    const prefix = rule.tool.slice(0, -1);
    if (!tool.startsWith(prefix)) return false;
  } else if (rule.tool !== tool) {
    return false;
  }
  if (rule.match && !rule.match(input)) return false;
  return true;
}

/** Helper for conversation bootstrap — return the baseline slugs that
 *  aren't already loaded so the loop can merge them into the
 *  `loaded_skills` jsonb column on first-turn startup. */
export function baselineSkillsToLoad(currently_loaded: readonly string[]): string[] {
  const have = new Set(currently_loaded);
  return BASELINE_SKILLS.filter((slug) => !have.has(slug));
}
