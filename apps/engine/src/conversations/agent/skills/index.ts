// Agent skills — in-process behaviour bundles spliced into the system
// prompt. These are NOT tenant-authored DB skills (those live in
// `apps/engine/src/skills/` and are loaded by tenant_id). Behaviour
// skills are universal subkit-engine rules that the LLM must always
// see; preloaded by the agent registry, with a typed name union so
// the registry's `preloadedSkills` field is type-safe.
//
// Structure: a `SkillName` union, a
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
import tenantCleanupAndProductHelp from "./content/tenant-cleanup-and-product-help.md" with { type: "text" };
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

/**
 * Cross-cutting skills that apply to EVERY conversation regardless of
 * authoring mode. The remainder live in `MODE_SPECIFIC_AGENT_SKILLS`
 * and only ship when the matching mode is active.
 *
 * Three bodies are mode-specific:
 *   - `conversational-authoring` (~7.3KB / ~1.8k tokens) — the ideal-flow
 *      narrative + stage signals, only relevant when actively authoring.
 *   - `workflow-step-kinds` — guardrails against invented dotted step
 *      namespaces for the eight step kinds; only relevant when proposing
 *      / editing steps.
 *   - `placeholder-rules` — `${cred|connector|input|scope.*}` grammar;
 *      only relevant when authoring (drafts) or repairing (diagnosis).
 *
 * Trimming the latter two from execution-mode turns ("run acme-jira-
 * test-plans") saves ~750 tokens. Execution-mode turns reach for
 * `wf_<slug>` / `run_workflow` directly; there is no step proposal to
 * guard. Authoring-mode and connector-mode and diagnosis-mode turns
 * re-add them via `MODE_SPECIFIC_AGENT_SKILLS`.
 */
const MODE_GATED_SKILLS: ReadonlyArray<AgentSkillName> = [
  "conversational-authoring",
  "workflow-step-kinds",
  "placeholder-rules",
];

export const ALWAYS_LOADED_AGENT_SKILLS: ReadonlyArray<AgentSkillName> = AGENT_SKILL_NAMES.filter(
  (n) => !MODE_GATED_SKILLS.includes(n),
);

/**
 * Skills loaded only when the conversation is in a specific authoring
 * mode (workflow / connector / execution / diagnosis). Adding a skill
 * here drops it from the always-loaded core to keep the static prompt
 * small for non-authoring chats. The lookup keys match
 * `AuthoringSurfaceMode` from `conversations/types.ts`.
 *
 *   workflow / connector → conversational-authoring + step-kinds + placeholders
 *   diagnosis            → conversational-authoring + step-kinds + placeholders
 *   execution            → none (always-loaded core only)
 *   undefined / null     → none (always-loaded core only)
 */
export const MODE_SPECIFIC_AGENT_SKILLS: Record<string, ReadonlyArray<AgentSkillName>> = {
  workflow: ["conversational-authoring", "workflow-step-kinds", "placeholder-rules"],
  connector: ["conversational-authoring", "workflow-step-kinds", "placeholder-rules"],
  execution: [],
  diagnosis: ["workflow-step-kinds", "placeholder-rules"],
};

/**
 * Resolve the actual skill list for a given authoring mode. Returns
 * the always-loaded core plus any mode-specific extras, deduped and
 * preserving the canonical AGENT_SKILL_NAMES order so the prompt is
 * deterministic. When `mode` is null/undefined, returns the
 * always-loaded core only.
 */
export function resolveAgentSkillsForMode(
  mode: string | null | undefined,
): ReadonlyArray<AgentSkillName> {
  const set = new Set<AgentSkillName>(ALWAYS_LOADED_AGENT_SKILLS);
  const extras = mode ? MODE_SPECIFIC_AGENT_SKILLS[mode] : undefined;
  if (extras) for (const name of extras) set.add(name);
  // Preserve declaration order from AGENT_SKILL_NAMES.
  return AGENT_SKILL_NAMES.filter((n) => set.has(n));
}
