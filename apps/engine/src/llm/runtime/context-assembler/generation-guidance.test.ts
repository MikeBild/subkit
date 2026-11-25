import { expect, test } from "bun:test";
import { UNDESCRIBED_METADATA } from "../../../api/catalog-metadata.ts";
import type { Skill } from "../../../skills/types.ts";
import {
  formatGenerationSkillIndex,
  generationConnectorScope,
  generationGuidanceBudget,
  goalStepKinds,
  rankGenerationGuidance,
  selectGenerationGuidance,
} from "./generation-guidance.ts";

const skill = (slug: string, overrides: Partial<Skill> = {}): Skill => ({
  id: `id-${slug}`,
  tenant_id: "t",
  scope: "global",
  connector_id: null,
  workflow_id: null,
  slug,
  title: slug,
  ...UNDESCRIBED_METADATA,
  body: `body of ${slug}`,
  examples: [],
  best_practices: [],
  pitfalls: [],
  doc_refs: [],
  gates_tools: [],
  activates_when: [],
  input_schema: null,
  output_schema: null,
  side_effects: "read",
  idempotency: "none",
  maturity: "stable",
  tags: [],
  applies_to: "both",
  audience: [],
  rules: [],
  domains: [],
  status: "active",
  source: "template",
  version: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const gmailScope = generationConnectorScope([
  { slug: "gmail-prod", template_slug: "google-gmail", driver: "http" },
]);
const skills = [
  skill("operator-runbook", { audience: ["runtime"] }),
  skill("core-rules", { audience: ["authoring"] }),
  skill("http-driver", { audience: ["driver:http"] }),
  skill("postgres-driver", { audience: ["driver:postgres"] }),
  skill("gmail-shape", { audience: ["connector:google-gmail"] }),
  skill("legacy-tenant-rule"),
];
const order = (goal: string, requested: string[] = []) =>
  rankGenerationGuidance(skills, { goal, scope: gmailScope, requested_slugs: requested }).map(
    (entry) => entry.skill.slug,
  );

test("connector skills rank first, then driver, then core rules, runtime and foreign connectors last", () => {
  expect(order("Read one Gmail message")).toEqual([
    "gmail-shape",
    "http-driver",
    "core-rules",
    "legacy-tenant-rule",
    "operator-runbook",
    "postgres-driver",
  ]);
});

test("a requested skill outranks every other signal", () => {
  expect(order("Read one Gmail message", ["operator-runbook"])[0]).toBe("operator-runbook");
});

test("step kinds follow the goal and a connector in scope implies a request", () => {
  expect([...goalStepKinds("Summarise each ticket", false)].sort()).toEqual(["loop", "transform"]);
  expect([...goalStepKinds("Hello", true)]).toEqual(["request"]);
});

test("selection keeps whole skills in rank order within the budget and skips non-positive ranks", () => {
  const ranked = rankGenerationGuidance(skills, {
    goal: "Read one Gmail message",
    scope: gmailScope,
    requested_slugs: [],
  });
  const tokensOf = (s: Skill) => (s.slug === "http-driver" ? 50 : 10);
  expect(selectGenerationGuidance(ranked, 25, tokensOf).map((s) => s.slug)).toEqual([
    "gmail-shape",
    "core-rules",
  ]);
  expect(selectGenerationGuidance(ranked, 1_000, tokensOf).map((s) => s.slug)).toEqual([
    "gmail-shape",
    "http-driver",
    "core-rules",
    "legacy-tenant-rule",
  ]);
});

test("the guidance budget is a share of the cap bounded by what the goal leaves", () => {
  expect(
    generationGuidanceBudget({ cap: 100_000, fixed_tokens: 5_000, reserve_tokens: 2_000 }),
  ).toBe(35_000);
  expect(
    generationGuidanceBudget({ cap: 10_000, fixed_tokens: 8_000, reserve_tokens: 1_000 }),
  ).toBe(1_000);
  expect(generationGuidanceBudget({ cap: 10_000, fixed_tokens: 12_000, reserve_tokens: 0 })).toBe(
    0,
  );
});

test("the index lists every applicable skill with its audience and load state", () => {
  const ranked = rankGenerationGuidance(skills, {
    goal: "Read one Gmail message",
    scope: gmailScope,
    requested_slugs: [],
  });
  const index = formatGenerationSkillIndex(ranked, [skills[4] as Skill]) ?? "";
  expect(index).toContain(
    "- `gmail-shape` — gmail-shape [connector:google-gmail] (included below)",
  );
  expect(index).toContain("- `operator-runbook` — operator-runbook [runtime] (load on demand)");
  expect(index.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(skills.length);
  expect(formatGenerationSkillIndex([], [])).toBeNull();
});
