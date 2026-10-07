import attachmentHandling from "./content/attachment-handling.md" with { type: "text" };
import chatFirstContract from "./content/chat-first-contract.md" with { type: "text" };
import confirmationDiscipline from "./content/confirmation-discipline.md" with { type: "text" };
import conversationalAuthoring from "./content/conversational-authoring.md" with { type: "text" };
import errorRecoveryAndRbac from "./content/error-recovery-and-rbac.md" with { type: "text" };
import placeholderRules from "./content/placeholder-rules.md" with { type: "text" };
import tenantCleanupAndProductHelp from "./content/tenant-cleanup-and-product-help.md" with {
  type: "text",
};
import turnOneDiscipline from "./content/turn-one-discipline.md" with { type: "text" };
import turnRhythmAndLanguage from "./content/turn-rhythm-and-language.md" with { type: "text" };
import workflowStepKinds from "./content/workflow-step-kinds.md" with { type: "text" };

export const AGENT_SKILL_NAMES = [
  "turn-one-discipline",
  "turn-rhythm-and-language",
  "chat-first-contract",
  "confirmation-discipline",
  "conversational-authoring",
  "workflow-step-kinds",
  "placeholder-rules",
  "attachment-handling",
  "error-recovery-and-rbac",
  "tenant-cleanup-and-product-help",
] as const;

export type AgentSkillName = (typeof AGENT_SKILL_NAMES)[number];

export const AGENT_SKILL_INDEX: Record<AgentSkillName, string> = {
  "turn-one-discipline":
    "Answer-before-action, no-fabrication, snapshot-before-list, one tenant_write per turn",
  "turn-rhythm-and-language":
    "One plan-or-result per turn, single trailing question, mirror user's language",
  "chat-first-contract":
    "The chat IS the operator surface — never delegate to a CLI or external terminal",
  "confirmation-discipline":
    "Single confirmation gate, no prose double-asks, auto mode skips ask_user_confirm",
  "conversational-authoring":
    "Ideal user flow, conversational stage signals, silent skill use, audit_log surfacing",
  "workflow-step-kinds":
    "Eight step kinds, required fields per kind, banned namespaces (no `type`, no trigger.*)",
  "placeholder-rules":
    "$" +
    "{cred|connector|input|scope|caller.*} placeholder grammar, trusted caller identity, run-warnings repair routine",
  "attachment-handling":
    "$file refs resolve before tool dispatch, never paste raw file content into chat",
  "error-recovery-and-rbac":
    "Typed tool error codes, recovery routine, RBAC denial handling, interactionLog reading",
  "tenant-cleanup-and-product-help":
    "Cleanup tools (delete_*/revoke_*), no-fabrication of UIs, OpenAPI/MCP/Chat product facts",
};

const AGENT_SKILL_BODIES: Record<AgentSkillName, string> = {
  "turn-one-discipline": turnOneDiscipline,
  "turn-rhythm-and-language": turnRhythmAndLanguage,
  "chat-first-contract": chatFirstContract,
  "confirmation-discipline": confirmationDiscipline,
  "conversational-authoring": conversationalAuthoring,
  "workflow-step-kinds": workflowStepKinds,
  "placeholder-rules": placeholderRules,
  "attachment-handling": attachmentHandling,
  "error-recovery-and-rbac": errorRecoveryAndRbac,
  "tenant-cleanup-and-product-help": tenantCleanupAndProductHelp,
};

export function loadAgentSkills(names: ReadonlyArray<AgentSkillName>): string {
  return names
    .map((name) => AGENT_SKILL_BODIES[name])
    .filter((body) => typeof body === "string" && body.length > 0)
    .join("\n\n---\n\n");
}

export const ALL_AGENT_SKILLS: ReadonlyArray<AgentSkillName> = AGENT_SKILL_NAMES;

const MODE_GATED_SKILLS: ReadonlyArray<AgentSkillName> = [
  "conversational-authoring",
  "workflow-step-kinds",
  "placeholder-rules",
];

export const ALWAYS_LOADED_AGENT_SKILLS: ReadonlyArray<AgentSkillName> = AGENT_SKILL_NAMES.filter(
  (n) => !MODE_GATED_SKILLS.includes(n),
);

export const MODE_SPECIFIC_AGENT_SKILLS: Record<string, ReadonlyArray<AgentSkillName>> = {
  workflow: ["conversational-authoring", "workflow-step-kinds", "placeholder-rules"],
  connector: ["conversational-authoring", "workflow-step-kinds", "placeholder-rules"],
  execution: [],
  diagnosis: ["workflow-step-kinds", "placeholder-rules"],
};

export function resolveAgentSkillsForMode(
  mode: string | null | undefined,
): ReadonlyArray<AgentSkillName> {
  const set = new Set<AgentSkillName>(ALWAYS_LOADED_AGENT_SKILLS);
  const extras = mode ? MODE_SPECIFIC_AGENT_SKILLS[mode] : undefined;
  if (extras) for (const name of extras) set.add(name);
  return AGENT_SKILL_NAMES.filter((n) => set.has(n));
}
