export const WEB_SEARCH_ESCALATION_POLICY = {
  precedence: ["search_knowledge", "search_docs", "fetch_connector_docs"] as const,

  summary:
    "Public web search is escalation-only: try tenant Knowledge Sources, connector docs, and connector-scoped doc search first. Reach for `web_search` only when the answer is about the public internet and the local context turned up nothing.",

  opt_in_setting: "llm.web_search" as const,
} as const;

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
