import { logger } from "../../../logging/index.ts";
import type { Skill } from "../../../skills/index.ts";
import { countTokens } from "../../accounting/index.ts";

export const GENERATION_GUIDANCE_SHARE = 0.35;

const CORE_SCORE = 2_000;

export interface GenerationConnectorScope {
  connector_keys: ReadonlySet<string>;
  drivers: ReadonlySet<string>;
}

export interface GenerationConnectorFacts {
  slug: string;
  template_slug: string | null;
  driver: string;
}

export const generationConnectorScope = (
  connectors: readonly GenerationConnectorFacts[],
): GenerationConnectorScope => ({
  connector_keys: new Set(
    connectors.flatMap((connector) =>
      [connector.slug, connector.template_slug]
        .filter((key): key is string => typeof key === "string" && key.length > 0)
        .map((key) => key.toLowerCase()),
    ),
  ),
  drivers: new Set(connectors.map((connector) => connector.driver.toLowerCase())),
});

export interface GenerationGuidanceSignals {
  goal: string;
  scope: GenerationConnectorScope;
  requested_slugs: readonly string[];
}

export interface RankedGuidance {
  skill: Skill;
  score: number;
}

const STEP_KIND_CUES: ReadonlyArray<readonly [string, RegExp]> = [
  ["request", /\b(get|fetch|read|list|call|api|endpoint|send|post|query|download|upload)\b/u],
  [
    "transform",
    /\b(transform|map|filter|format|shape|extract|summari[sz]e|convert|parse|sort|group|count|table|csv|markdown)\b/u,
  ],
  ["loop", /\b(for each|each|every|per item|all items|iterate)\b/u],
  ["branch", /\b(if|when|otherwise|unless|else)\b/u],
  ["parallel", /\b(parallel|concurrently|at the same time)\b/u],
];

export const goalStepKinds = (goal: string, hasConnector: boolean): ReadonlySet<string> => {
  const text = goal.toLowerCase();
  return new Set([
    ...(hasConnector ? ["request"] : []),
    ...STEP_KIND_CUES.filter(([, cue]) => cue.test(text)).map(([kind]) => kind),
  ]);
};

const goalWords = (goal: string): ReadonlySet<string> =>
  new Set(
    goal
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((word) => word.length >= 4),
  );

const audienceValues = (skill: Skill, kind: "connector" | "driver"): string[] =>
  skill.audience
    .filter((entry) => entry.startsWith(`${kind}:`))
    .map((entry) => entry.slice(kind.length + 1).toLowerCase());

const connectorMatch = (skill: Skill, scope: GenerationConnectorScope): boolean =>
  audienceValues(skill, "connector").some((key) => scope.connector_keys.has(key)) ||
  skill.activates_when.some(
    (rule) =>
      rule.kind === "connector_template" && scope.connector_keys.has(rule.slug.toLowerCase()),
  );

const driverMatch = (skill: Skill, scope: GenerationConnectorScope): boolean =>
  audienceValues(skill, "driver").some((driver) => scope.drivers.has(driver)) ||
  skill.activates_when.some(
    (rule) => rule.kind === "connector_driver" && scope.drivers.has(rule.driver.toLowerCase()),
  );

const boundElsewhere = (skill: Skill): boolean =>
  skill.audience.length > 0 &&
  skill.audience.every((entry) => entry.startsWith("connector:") || entry.startsWith("driver:"));

const stepKindMatch = (skill: Skill, kinds: ReadonlySet<string>): boolean =>
  skill.activates_when.some(
    (rule) =>
      (rule.kind === "step_kind" && rule.step_kinds.some((kind) => kinds.has(kind))) ||
      (rule.kind === "tool_arg" && typeof rule.equals === "string" && kinds.has(rule.equals)),
  );

const textRelevance = (skill: Skill, goal: string, words: ReadonlySet<string>): number => {
  const text = goal.toLowerCase();
  const keywordHits = skill.activates_when.filter(
    (rule) => rule.kind === "intent_keyword" && text.includes(rule.word.toLowerCase()),
  ).length;
  const vocabulary = goalWords(
    [skill.slug ?? "", skill.title, skill.description ?? "", ...skill.tags].join(" "),
  );
  const overlap = [...words].filter((word) => vocabulary.has(word)).length;
  return Math.min(1_000, keywordHits * 200 + overlap * 50);
};

export const scoreGenerationGuidance = (
  skill: Skill,
  signals: GenerationGuidanceSignals,
  kinds: ReadonlySet<string>,
  words: ReadonlySet<string>,
): number => {
  const requested = skill.slug !== null && signals.requested_slugs.includes(skill.slug);
  const runtimeOnly = skill.audience.length > 0 && skill.audience.every((a) => a === "runtime");
  const core = skill.audience.length === 0 || skill.audience.includes("authoring");
  const connector = connectorMatch(skill, signals.scope);
  const driver = driverMatch(skill, signals.scope);
  return (
    (requested ? 100_000 : 0) +
    (connector ? 5_000 : 0) +
    (driver ? 3_000 : 0) +
    (core ? CORE_SCORE : 0) +
    (stepKindMatch(skill, kinds) ? 1_000 : 0) +
    textRelevance(skill, signals.goal, words) -
    (runtimeOnly ? 10_000 : 0) -
    (boundElsewhere(skill) && !connector && !driver ? 10_000 : 0)
  );
};

export const rankGenerationGuidance = (
  skills: readonly Skill[],
  signals: GenerationGuidanceSignals,
): RankedGuidance[] => {
  const kinds = goalStepKinds(signals.goal, signals.scope.drivers.size > 0);
  const words = goalWords(signals.goal);
  return skills
    .map((skill) => ({ skill, score: scoreGenerationGuidance(skill, signals, kinds, words) }))
    .sort(
      (left, right) =>
        right.score - left.score || (left.skill.slug ?? "").localeCompare(right.skill.slug ?? ""),
    );
};

export const generationGuidanceBudget = (p: {
  cap: number;
  fixed_tokens: number;
  reserve_tokens: number;
}): number =>
  Math.max(
    0,
    Math.min(
      Math.floor(p.cap * GENERATION_GUIDANCE_SHARE),
      p.cap - p.fixed_tokens - p.reserve_tokens,
    ),
  );

export const selectGenerationGuidance = (
  ranked: readonly RankedGuidance[],
  budget: number,
  tokensOf: (skill: Skill) => number,
): Skill[] =>
  ranked
    .filter((entry) => entry.score > 0)
    .reduce<{ used: number; included: Skill[] }>(
      (acc, entry) => {
        const cost = tokensOf(entry.skill);
        return acc.used + cost <= budget
          ? { used: acc.used + cost, included: [...acc.included, entry.skill] }
          : acc;
      },
      { used: 0, included: [] },
    ).included;

const audienceLabel = (skill: Skill): string =>
  skill.audience.length > 0 ? ` [${skill.audience.join(", ")}]` : "";

export const formatGenerationSkillIndex = (
  ranked: readonly RankedGuidance[],
  included: readonly Skill[],
): string | null => {
  if (ranked.length === 0) return null;
  const includedIds = new Set(included.map((skill) => skill.id));
  const lines = ranked.map(({ skill }) => {
    const ref = skill.slug ?? skill.id;
    const stated = (skill.description ?? "").replace(/\s+/g, " ").trim();
    const description = stated.length > 120 ? `${stated.slice(0, 120)}…` : stated;
    const state = includedIds.has(skill.id) ? "included below" : "load on demand";
    return `- \`${ref}\` — ${skill.title}${audienceLabel(skill)} (${state})${description ? `: ${description}` : ""}`;
  });
  return [
    "# Skill index for this generation",
    "Every applicable skill is listed. Skills marked `included below` follow in full. To use a skill marked `load on demand`, call abort with a need of kind `skill_guidance` and its slug in `skill_slug`; the engine regenerates with that skill's complete guidance. Do not guess what an unloaded skill says.",
    ...lines,
  ].join("\n");
};

export interface GenerationGuidancePlan {
  ranked: RankedGuidance[];
  included: Skill[];
  budget: number;
}

export const planGenerationGuidance = (p: {
  tenant_id: string;
  flow: string;
  goal: string;
  connectors: readonly GenerationConnectorFacts[];
  requested_slugs: readonly string[];
  applicable: readonly Skill[];
  cap: number;
  fixed_tokens: number;
  reserve_tokens: number;
  tokens_of: (skill: Skill) => number;
}): GenerationGuidancePlan => {
  const scope = generationConnectorScope(p.connectors);
  const ranked = rankGenerationGuidance(p.applicable, {
    goal: p.goal,
    scope,
    requested_slugs: p.requested_slugs,
  });
  const budget = generationGuidanceBudget({
    cap: p.cap,
    fixed_tokens: p.fixed_tokens + countTokens(formatGenerationSkillIndex(ranked, []) ?? ""),
    reserve_tokens: p.reserve_tokens,
  });
  const included = selectGenerationGuidance(ranked, budget, p.tokens_of);
  const includedIds = new Set(included.map((skill) => skill.id));
  const coreLeftOut = ranked
    .filter((entry) => entry.score >= CORE_SCORE && !includedIds.has(entry.skill.id))
    .map((entry) => entry.skill.slug ?? entry.skill.id);
  const fields = {
    module: "llm",
    tenant_id: p.tenant_id,
    flow: p.flow,
    cap: p.cap,
    budget,
    connector_keys: [...scope.connector_keys],
    drivers: [...scope.drivers],
    included: included.map((skill) => skill.slug ?? skill.id),
    indexed_count: ranked.length,
    requested: p.requested_slugs,
  };
  if (coreLeftOut.length > 0) {
    logger.warn({
      ...fields,
      action: "context.generation_guidance_over_budget",
      msg: "core generation guidance exceeds its budget; the highest-ranked complete skills are included and the rest stay loadable on demand",
      left_out: coreLeftOut,
    });
  } else {
    logger.info({
      ...fields,
      action: "context.generation_guidance_selected",
      msg: "generation guidance selected by relevance within budget",
    });
  }
  return { ranked, included, budget };
};
