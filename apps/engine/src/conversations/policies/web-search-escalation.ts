// Web-search escalation policy.
//
// Single source of truth for "when should the authoring loop reach for
// `web_search`". Both the tool's own description and the
// `subkit-ai-context-pipeline` skill cite this module so the policy
// doesn't drift between what the model reads and what the operator
// expects.
//
// Enforcement is advisory — the runtime cannot block the LLM from
// choosing `web_search` before `search_knowledge` — but the RBAC gate
// on `tenant_llm_settings.allow_web_search` keeps the tool physically
// unavailable unless an operator opts in.

export const WEB_SEARCH_ESCALATION_POLICY = {
  /**
   * Ordered list of context-gathering tools the authoring loop should
   * consult before escalating to `web_search`. Both humans and the
   * LLM can read this as a checklist — "did we try these first?".
   */
  precedence: ["search_knowledge", "search_docs", "fetch_connector_docs"] as const,

  /**
   * One-line summary surfaced as the `web_search` tool description and
   * in the ai-context-pipeline skill. Short enough to fit inside a
   * stable cache block without bloating the token budget.
   */
  summary:
    "Public web search is escalation-only: try tenant Knowledge Sources, connector docs, and connector-scoped doc search first. Reach for `web_search` only when the answer is about the public internet and the local context turned up nothing.",

  /**
   * Tenant-settings column that acts as the hard gate. When false the
   * tool returns `web_search_not_allowed_for_tenant` regardless of what
   * the model asked for.
   */
  opt_in_setting: "allow_web_search" as const,
} as const;

/**
 * Render the policy as a short Markdown block that docs and skills can
 * embed verbatim.
 */
export function renderWebSearchEscalationBlock(): string {
  return [
    "**Web-search escalation (advisory)**",
    "",
    WEB_SEARCH_ESCALATION_POLICY.summary,
    "",
    `Precedence: ${WEB_SEARCH_ESCALATION_POLICY.precedence.map((t) => `\`${t}\``).join(" → ")} → \`web_search\`.`,
    "",
    `Operator gate: tenant setting \`${WEB_SEARCH_ESCALATION_POLICY.opt_in_setting}\` must be true.`,
  ].join("\n");
}
