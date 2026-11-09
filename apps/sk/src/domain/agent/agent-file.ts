export const MIN_BRIEFING_BUDGET_TOKENS = 500;
export const MAX_BRIEFING_BUDGET_TOKENS = 16_000;

export interface AgentFile {
  domains: string[];
  budget_tokens?: number;
  inferred?: boolean;
  inferred_folder_domain?: string | null;
}

export function parseAgentFile(raw: unknown): AgentFile {
  if (raw === null || typeof raw !== "object") {
    throw new Error(".sk/agent.json: domains must contain at least one domain slug");
  }
  const value = raw as Partial<AgentFile>;
  const domains = Array.isArray(value.domains)
    ? value.domains
        .filter(
          (domain): domain is string => typeof domain === "string" && domain.trim().length > 0,
        )
        .map((domain) => domain.trim())
    : [];
  if (!domains.length)
    throw new Error(".sk/agent.json: domains must contain at least one domain slug");
  const budget = value.budget_tokens;
  if (
    budget !== undefined &&
    (!Number.isInteger(budget) ||
      budget < MIN_BRIEFING_BUDGET_TOKENS ||
      budget > MAX_BRIEFING_BUDGET_TOKENS)
  ) {
    throw new Error(
      `.sk/agent.json: budget_tokens must be an integer from ${MIN_BRIEFING_BUDGET_TOKENS} to ${MAX_BRIEFING_BUDGET_TOKENS}`,
    );
  }
  const inferred = value.inferred === true;
  const folderDomain = value.inferred_folder_domain;
  if (
    inferred &&
    folderDomain !== undefined &&
    folderDomain !== null &&
    (typeof folderDomain !== "string" || !folderDomain.trim())
  ) {
    throw new Error(".sk/agent.json: inferred_folder_domain must be a domain slug or null");
  }
  return {
    domains,
    ...(inferred
      ? {
          inferred: true,
          inferred_folder_domain:
            typeof folderDomain === "string"
              ? folderDomain.trim()
              : (domains.find((domain) => domain !== "subkit") ?? null),
        }
      : {}),
    ...(typeof budget === "number" ? { budget_tokens: budget } : {}),
  };
}
