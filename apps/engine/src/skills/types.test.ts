import { describe, expect, test } from "bun:test";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import {
  CreateSkillSchema,
  MAX_SKILL_RULES,
  SkillActivationSchema,
  SkillDomainsSchema,
  SkillIdempotencySchema,
  SkillMaturitySchema,
  SkillRuleSchema,
  SkillRulesSchema,
  SkillSchema,
  SkillSideEffectsSchema,
} from "./types.ts";

const TEST_NOW_MS = getTestNow();

describe("SkillActivationSchema — discriminated union", () => {
  test("accepts every kind", () => {
    expect(SkillActivationSchema.safeParse({ kind: "baseline" }).success).toBe(true);
    expect(SkillActivationSchema.safeParse({ kind: "tool", tool: "probe_connector" }).success).toBe(
      true,
    );
    expect(
      SkillActivationSchema.safeParse({
        kind: "tool_arg",
        tool: "edit_workflow_patch",
        path: "patches[*].value.kind",
        equals: "request",
      }).success,
    ).toBe(true);
    expect(
      SkillActivationSchema.safeParse({ kind: "connector_driver", driver: "postgres" }).success,
    ).toBe(true);
    expect(
      SkillActivationSchema.safeParse({ kind: "connector_template", slug: "stripe" }).success,
    ).toBe(true);
    expect(
      SkillActivationSchema.safeParse({ kind: "connector_recipe_match", template: "stripe" })
        .success,
    ).toBe(true);
    expect(
      SkillActivationSchema.safeParse({ kind: "intent_keyword", word: "stripe customers" }).success,
    ).toBe(true);
  });

  test("rejects unknown kind", () => {
    expect(SkillActivationSchema.safeParse({ kind: "made_up" }).success).toBe(false);
  });

  test("rejects empty tool / driver / slug strings", () => {
    expect(SkillActivationSchema.safeParse({ kind: "tool", tool: "" }).success).toBe(false);
    expect(SkillActivationSchema.safeParse({ kind: "connector_driver", driver: "" }).success).toBe(
      false,
    );
    expect(SkillActivationSchema.safeParse({ kind: "connector_template", slug: "" }).success).toBe(
      false,
    );
  });

  test("tool_arg accepts string, number, boolean for `equals`", () => {
    for (const equals of ["x", 1, true]) {
      expect(
        SkillActivationSchema.safeParse({
          kind: "tool_arg",
          tool: "t",
          path: "a.b",
          equals,
        }).success,
      ).toBe(true);
    }
    expect(
      SkillActivationSchema.safeParse({
        kind: "tool_arg",
        tool: "t",
        path: "a.b",
        equals: { not: "scalar" },
      }).success,
    ).toBe(false);
  });
});

describe("SkillSchema — capability/safety enums", () => {
  test("side_effects enum", () => {
    expect(SkillSideEffectsSchema.parse("read")).toBe("read");
    expect(SkillSideEffectsSchema.parse("destructive")).toBe("destructive");
    expect(SkillSideEffectsSchema.safeParse("nuke").success).toBe(false);
  });

  test("idempotency enum", () => {
    expect(SkillIdempotencySchema.parse("naturally")).toBe("naturally");
    expect(SkillIdempotencySchema.safeParse("yes").success).toBe(false);
  });

  test("maturity enum", () => {
    expect(SkillMaturitySchema.parse("experimental")).toBe("experimental");
    expect(SkillMaturitySchema.safeParse("beta").success).toBe(false);
  });
});

describe("CreateSkillSchema", () => {
  test("accepts minimal payload (defaults to read/none/stable/[])", () => {
    const parsed = CreateSkillSchema.parse({
      scope: "global",
      title: "T",
      body: "B",
    });
    expect(parsed.scope).toBe("global");
  });

  test("legacy front-matter keys are not part of the schema", () => {
    const input = {
      scope: "global" as const,
      title: "T",
      body: "B",
      auto_load: true,
      trigger_keywords: ["x"],
    };
    const withLegacy = CreateSkillSchema.parse(
      input as Parameters<typeof CreateSkillSchema.parse>[0],
    );
    expect((withLegacy as Record<string, unknown>).auto_load).toBeUndefined();
    expect((withLegacy as Record<string, unknown>).trigger_keywords).toBeUndefined();
  });
});

describe("SkillSchema — full row defaults", () => {
  test("required fields plus capability/safety defaults", () => {
    const parsed = SkillSchema.parse({
      id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "tenant-a",
      scope: "global",
      connector_id: null,
      workflow_id: null,
      title: "T",
      body: "B",
      status: "active",
      source: "manual",
      version: 1,
      created_at: new Date(TEST_NOW_MS).toISOString(),
      updated_at: new Date(TEST_NOW_MS).toISOString(),
    });
    expect(parsed.activates_when).toEqual([]);
    expect(parsed.gates_tools).toEqual([]);
    expect(parsed.input_schema).toBeNull();
    expect(parsed.output_schema).toBeNull();
    expect(parsed.side_effects).toBe("read");
    expect(parsed.idempotency).toBe("none");
    expect(parsed.maturity).toBe("stable");
    expect(parsed.tags).toEqual([]);
  });
});

const CONNECTOR = "00000000-0000-4000-8000-0000000000aa";

const VALID_RULES = [
  {
    rule_id: "flow-naming",
    type: "naming",
    statement: "Workflow slugs start with the team.",
    payload: { applies_to: "workflow_slug", pattern: "^ops-", example: "ops-daily" },
  },
  {
    rule_id: "tz",
    type: "timezone",
    statement: "Schedules run in Berlin time.",
    payload: { value: "Europe/Berlin" },
  },
  { rule_id: "lang", type: "locale", statement: "German.", payload: { tag: "de-DE" } },
  { rule_id: "money", type: "currency", statement: "Euro.", payload: { code: "EUR" } },
  {
    rule_id: "deliver",
    type: "delivery_default",
    statement: "Reports go to Slack.",
    payload: { connector_id: CONNECTOR, channel: "#ops" },
  },
  {
    rule_id: "prefer",
    type: "connector_preference",
    statement: "Prefer this CRM in prod.",
    payload: { connector_id: CONNECTOR, environment: "prod" },
  },
  {
    rule_id: "mrr",
    type: "glossary_term",
    statement: "MRR is monthly recurring revenue.",
    payload: { term: "MRR", meaning: "Monthly recurring revenue" },
  },
  {
    rule_id: "amount",
    type: "field_semantics",
    statement: "amount is in cents.",
    payload: { field: "amount", meaning: "Charge amount", unit: "cent" },
  },
  {
    rule_id: "no-delete",
    type: "pitfall",
    statement: "Never delete invoices.",
    payload: { text: "Invoices are archived, never deleted." },
  },
] as const;

describe("SkillRuleSchema — typed conventions", () => {
  test("accepts each of the nine rule types", () => {
    for (const rule of VALID_RULES) expect(SkillRuleSchema.safeParse(rule).success).toBe(true);
    expect(new Set(VALID_RULES.map((rule) => rule.type)).size).toBe(9);
  });

  test("checks each payload by machine", () => {
    const invalid = [
      { ...VALID_RULES[1], payload: { value: "Mars/Olympus" } },
      { ...VALID_RULES[2], payload: { tag: "not a tag!" } },
      { ...VALID_RULES[3], payload: { code: "EURO" } },
      { ...VALID_RULES[3], payload: { code: "XYZ" } },
      { ...VALID_RULES[4], payload: { connector_id: "slack", channel: "#ops" } },
      { ...VALID_RULES[5], payload: { connector_id: CONNECTOR, environment: "staging" } },
      { ...VALID_RULES[8], payload: { text: "" } },
      { ...VALID_RULES[1], payload: { value: "Europe/Berlin", extra: true } },
      { ...VALID_RULES[1], type: "schedule" },
    ];
    for (const rule of invalid) expect(SkillRuleSchema.safeParse(rule).success).toBe(false);
  });

  test("caps the statement at 300 characters and needs a stable rule_id", () => {
    expect(
      SkillRuleSchema.safeParse({ ...VALID_RULES[1], statement: "x".repeat(301) }).success,
    ).toBe(false);
    expect(SkillRuleSchema.safeParse({ ...VALID_RULES[1], rule_id: "Tenant TZ" }).success).toBe(
      false,
    );
  });

  test("allows at most fifty rules with unique rule_ids", () => {
    const many = Array.from({ length: MAX_SKILL_RULES + 1 }, (_, i) => ({
      ...VALID_RULES[8],
      rule_id: `pitfall-${i}`,
    }));
    expect(SkillRulesSchema.safeParse(many.slice(0, MAX_SKILL_RULES)).success).toBe(true);
    expect(SkillRulesSchema.safeParse(many).success).toBe(false);
    expect(SkillRulesSchema.safeParse([VALID_RULES[1], VALID_RULES[1]]).success).toBe(false);
  });

  test("domains are unique catalog categories", () => {
    expect(SkillDomainsSchema.safeParse(["billing", "ops-reports"]).success).toBe(true);
    expect(SkillDomainsSchema.safeParse(["Billing"]).success).toBe(false);
    expect(SkillDomainsSchema.safeParse(["billing", "billing"]).success).toBe(false);
  });

  test("a skill snapshot without rules or domains still parses", () => {
    const snapshot = {
      id: "s",
      tenant_id: "t",
      scope: "global",
      connector_id: null,
      workflow_id: null,
      title: "Old",
      body: "Old body",
      status: "active",
      source: "manual",
      version: 1,
      created_at: new Date(TEST_NOW_MS).toISOString(),
      updated_at: new Date(TEST_NOW_MS).toISOString(),
    };
    const parsed = SkillSchema.parse(snapshot);
    expect(parsed.rules).toEqual([]);
    expect(parsed.domains).toEqual([]);
  });

  test("create input does not carry rules or domains", () => {
    const parsed = CreateSkillSchema.parse({
      scope: "global",
      title: "t",
      body: "b",
      rules: [VALID_RULES[1]],
      domains: ["billing"],
    });
    expect("rules" in parsed).toBe(false);
    expect("domains" in parsed).toBe(false);
  });
});
