// Web-search escalation policy.
//
// Single source of truth for "when should the authoring loop reach for
// `web_search`". Both the tool's own description and the
// `subkit-ai-context-pipeline` skill cite this module so the policy
// doesn't drift between what the model reads and what the operator
// expects.
//
// `web_search` is the Anthropic-native, server-side web-search tool
// (provider-side execution, billed per search; Anthropic Claude models
// only). It is enabled by default and gated per tenant by the
// `llm.web_search` config leaf — operators toggle it off via /settings
// (PUT /v1/settings/{path}) when they don't want per-search billing or
// want to keep turns inside the tenant perimeter.

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
   * Config leaf that acts as the per-tenant gate. When `llm.web_search`
   * is false the native tool is omitted from the palette entirely, so
   * the model never sees it. Defaults to true.
   */
  opt_in_setting: "llm.web_search" as const,
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
    `Web search is Anthropic-native (provider-side, billed per search) and on by default; operators toggle it per tenant via the \`${WEB_SEARCH_ESCALATION_POLICY.opt_in_setting}\` config leaf.`,
  ].join("\n");
}
