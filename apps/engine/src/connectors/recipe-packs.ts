export const RECIPE_PACK_VERTICALS = [
  "revops",
  "customer-success",
  "finance",
  "data",
  "devops",
  "security",
  "marketing",
  "hr",
  "solutions",
] as const;
export type RecipePackVertical = (typeof RECIPE_PACK_VERTICALS)[number];
export type PredicateRecipePackVertical = Exclude<RecipePackVertical, "solutions">;

export interface PackPredicate {
  readonly outcome: string;
  readonly match_categories: readonly string[];
  readonly match_tags: readonly string[];
}

export const RECIPE_PACK_PREDICATES: Record<PredicateRecipePackVertical, PackPredicate> = {
  revops: {
    outcome:
      "Stand up the lead → opportunity → close loop with the LLM doing routing, enrichment, and Slack hand-off in real time.",
    match_categories: ["crm", "marketing"],
    match_tags: ["revops", "lead", "deal"],
  },
  "customer-success": {
    outcome:
      "Detect health-score regressions and route them to the right CSM playbook before churn lands on the renewal call.",
    match_categories: ["enterprise", "support"],
    match_tags: ["customer-success", "health", "churn", "playbook"],
  },
  finance: {
    outcome:
      "Catch failed charges, dunning windows, and high-risk payments while they still have a recovery path.",
    match_categories: ["payments"],
    match_tags: ["finance", "dunning", "billing", "risk"],
  },
  data: {
    outcome:
      "Move rows between systems-of-record on a schedule with idempotent upserts and watermark state — reverse-ETL without the bespoke vendor.",
    match_categories: ["database", "analytics"],
    match_tags: ["reverse-etl", "sync", "warehouse", "data"],
  },
  devops: {
    outcome:
      "Page on-call from the right alarm tier, post the AI postmortem, open the ticket — every incident with the same first 60 seconds.",
    match_categories: ["devops", "analytics"],
    match_tags: ["devops", "incident", "deploy", "release"],
  },
  security: {
    outcome:
      "Audit IAM drift, rotate stale keys, and require human approval on the operations a single Slack message would otherwise execute.",
    match_categories: ["enterprise"],
    match_tags: ["security", "audit", "approval"],
  },
  marketing: {
    outcome:
      "Run trial nurture and campaign QA across ESP + CRM + warehouse without the seven-tab manual spreadsheet.",
    match_categories: ["marketing"],
    match_tags: ["marketing", "nurture", "campaign", "utm"],
  },
  hr: {
    outcome:
      "Onboard a new hire across Okta + Workspace + BambooHR + Slack atomically; offboard the same way without leaving an orphaned account.",
    match_categories: ["enterprise"],
    match_tags: ["hr", "onboarding", "offboarding"],
  },
};

export function recipePackPredicate(vertical: string): PackPredicate | null {
  return Object.hasOwn(RECIPE_PACK_PREDICATES, vertical)
    ? RECIPE_PACK_PREDICATES[vertical as PredicateRecipePackVertical]
    : null;
}
