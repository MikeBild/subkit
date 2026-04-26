// Agent skills — in-process behaviour bundles spliced into the system
// prompt. These are NOT tenant-authored DB skills (those live in
// `apps/engine/src/skills/` and are loaded by tenant_id). Behaviour
// skills are universal subkit-engine rules that the LLM must always
// see; preloaded by the agent registry, with a typed name union so
// the registry's `preloadedSkills` field is type-safe.
//
// Pattern mirrors the reference codebase: a `SkillName` union, a
// `SKILL_INDEX` description map (used by tools that surface what's
// available), and a `loadSkills(names)` helper that concatenates the
// selected bodies into the prompt segment. Bodies are imported as
// text via Bun's `with { type: "text" }` import attribute so the
// compiled binary ships them inline — no filesystem reads at runtime.

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
    "$" + "{cred|connector|input|scope.*} placeholder grammar, run-warnings repair routine",
  "attachment-handling": "@attachment:<slug> resolution, never paste raw file content into chat",
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

/**
 * Concatenate the named skill bodies in the order given. Bodies are
 * separated by `---` rules so the model can see where one rule block
 * ends and the next begins.
 */
export function loadAgentSkills(names: ReadonlyArray<AgentSkillName>): string {
  return names
    .map((name) => AGENT_SKILL_BODIES[name])
    .filter((body) => typeof body === "string" && body.length > 0)
    .join("\n\n---\n\n");
}

/** All agent skill names — stable order, used by the MAIN agent's preload list. */
export const ALL_AGENT_SKILLS: ReadonlyArray<AgentSkillName> = AGENT_SKILL_NAMES;
