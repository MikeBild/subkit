import { describe, expect, test } from "bun:test";
import {
  type AppliedConvention,
  NO_CONVENTIONS,
  resolveConventions,
} from "../skills/conventions.ts";
import type { SkillRule } from "../skills/types.ts";
import {
  CONSISTENCY_RULE_IDS,
  type ConsistencyContext,
  consistencyLintWarnings,
  DEFAULT_TENANT_TIMEZONE,
} from "./consistency-lint.ts";
import type { PriorWorkflowRef } from "./prior-workflows.ts";
import { WorkflowDefSchema } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";

const CONNECTOR = "00000000-0000-4000-8000-0000000000a1";

function convention(rule: SkillRule, skill_id = "skill-a"): AppliedConvention {
  return { level: "global", skill_id, skill_title: "Conventions", skill_version: 1, rule };
}

function context(
  rules: SkillRule[] = [],
  siblings: PriorWorkflowRef[] = [],
  workflowId: string | null = null,
): ConsistencyContext {
  return {
    conventions:
      rules.length > 0 ? resolveConventions(rules.map((r) => convention(r))) : NO_CONVENTIONS,
    siblings,
    workflowId,
  };
}

function lint(input: Record<string, unknown>, ctx: ConsistencyContext) {
  const parsed = WorkflowDefSchema.parse(input);
  return consistencyLintWarnings(input, parsed, ctx);
}

const baseWorkflow = {
  name: "Ops daily digest",
  slug: "ops-daily-digest",
  steps: [
    { id: "fetch", kind: "request", connector_id: CONNECTOR, method: "GET", path: "/charges" },
    { id: "shape", kind: "transform", expression: "return input.scope.fetch.data;" },
  ],
};

const namingRule: SkillRule = {
  rule_id: "slug-prefix",
  type: "naming",
  statement: "Workflow slugs start with the team prefix.",
  payload: { applies_to: "workflow_slug", pattern: "^fin-", example: "fin-daily" },
};

const timezoneRule: SkillRule = {
  rule_id: "tenant-timezone",
  type: "timezone",
  statement: "Schedules and dates use Europe/Vienna.",
  payload: { value: "Europe/Vienna" },
};

const localeRule: SkillRule = {
  rule_id: "tenant-locale",
  type: "locale",
  statement: "Reports are written for German readers.",
  payload: { tag: "de-DE" },
};

describe("consistency lint · naming", () => {
  test("a slug that breaks a published naming rule is reported with that rule_id", () => {
    const warnings = lint(baseWorkflow, context([namingRule]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ path: "slug", rule_id: "slug-prefix" });
    expect(warnings[0]?.message).toContain('"fin-daily"');
  });

  test("a matching slug, an unknown target or an invalid pattern stays silent", () => {
    expect(lint({ ...baseWorkflow, slug: "fin-digest" }, context([namingRule]))).toEqual([]);
    const unknown: SkillRule = {
      ...namingRule,
      rule_id: "label",
      payload: { ...namingRule.payload, applies_to: "dashboard_label" },
    };
    const broken: SkillRule = {
      ...namingRule,
      rule_id: "broken",
      payload: { ...namingRule.payload, applies_to: "step_id", pattern: "([" },
    };
    expect(lint(baseWorkflow, context([unknown, broken]))).toEqual([]);
  });

  test("step ids are checked when the rule names them", () => {
    const rule: SkillRule = {
      rule_id: "step-snake",
      type: "naming",
      statement: "Step ids are snake_case verbs.",
      payload: { applies_to: "step_id", pattern: "^[a-z]+(_[a-z]+)*$", example: "fetch_charges" },
    };
    const warnings = lint(
      { ...baseWorkflow, steps: [{ ...baseWorkflow.steps[0], id: "fetchCharges" }] },
      context([rule]),
    );
    expect(warnings.map((w) => [w.path, w.rule_id])).toEqual([
      ["steps.fetchCharges", "step-snake"],
    ]);
  });

  test("a naming key in conflict at its level is not enforced", () => {
    const other: SkillRule = {
      ...namingRule,
      rule_id: "slug-prefix-ops",
      payload: { ...namingRule.payload, pattern: "^ops-" },
    };
    const conventions = resolveConventions([
      convention(namingRule, "skill-a"),
      convention(other, "skill-b"),
    ]);
    expect(conventions.conflicts).toHaveLength(1);
    const parsed = WorkflowDefSchema.parse(baseWorkflow);
    expect(consistencyLintWarnings(baseWorkflow, parsed, { conventions, siblings: [] })).toEqual(
      [],
    );
  });
});

describe("consistency lint · schedule time zone", () => {
  const scheduled = (trigger: Record<string, unknown>) => ({
    ...baseWorkflow,
    trigger: { kind: "schedule", cron: "0 7 * * 1-5", ...trigger },
  });

  test("a schedule trigger without tz is reported against the tenant default", () => {
    const warnings = lint(scheduled({}), context());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      path: "trigger.tz",
      rule_id: CONSISTENCY_RULE_IDS.scheduleTz,
    });
    expect(warnings[0]?.message).toContain(DEFAULT_TENANT_TIMEZONE);
  });

  test("a defaulted UTC is reported, an explicit other zone without a rule is not", () => {
    expect(lint(scheduled({ tz: "UTC" }), context())).toHaveLength(1);
    expect(lint(scheduled({ tz: "Europe/Berlin" }), context())).toEqual([]);
    expect(lint(scheduled({ tz: "America/New_York" }), context())).toEqual([]);
  });

  test("a published timezone rule sets the expected zone and the rule_id", () => {
    const warnings = lint(scheduled({ tz: "Europe/Berlin" }), context([timezoneRule]));
    expect(warnings.map((w) => [w.path, w.rule_id])).toEqual([["trigger.tz", "tenant-timezone"]]);
    expect(lint(scheduled({ tz: "Europe/Vienna" }), context([timezoneRule]))).toEqual([]);
  });
});

describe("consistency lint · locale and dates outside sk.fmt", () => {
  const withTransform = (expression: string, extra: Record<string, unknown> = {}) => ({
    ...baseWorkflow,
    steps: [baseWorkflow.steps[0], { id: "shape", kind: "transform", expression }],
    ...extra,
  });

  test("a hand-built date is reported", () => {
    const warnings = lint(
      withTransform(
        "const d = new Date(input.scope.fetch.data.at); return d.getDate() + '.' + (d.getMonth() + 1) + '.' + d.getFullYear();",
      ),
      context(),
    );
    expect(warnings.map((w) => [w.path, w.rule_id])).toEqual([
      ["steps.shape.expression", CONSISTENCY_RULE_IDS.localeOutsideFmt],
    ]);
  });

  test("sk.fmt with a locale or zone against the published convention is reported", () => {
    const warnings = lint(
      withTransform(
        'return { total: sk.fmt.number(input.scope.fetch.data.total, { locale: "en" }), at: sk.fmt.date(input.scope.fetch.data.at, { tz: "UTC", pattern: "dd.MM.yyyy" }) };',
      ),
      context([localeRule, timezoneRule]),
    );
    expect(warnings.map((w) => w.rule_id)).toEqual(["tenant-locale", "tenant-timezone"]);
  });

  test("sk.fmt in the convention locale stays silent", () => {
    expect(
      lint(
        withTransform(
          'return sk.fmt.date(input.scope.fetch.data.at, { tz: "Europe/Vienna", locale: "de", pattern: "dd.MM.yyyy" }) + sk.fmt.de(1);',
        ),
        context([localeRule, timezoneRule]),
      ),
    ).toEqual([]);
  });

  test("locale APIs in the output function and JSONata formatting are reported", () => {
    const warnings = lint(
      {
        ...baseWorkflow,
        output_transform_function: "return { at: new Date(input.at).toLocaleDateString('de-DE') };",
        validation_expression: "$fromMillis($.at, '[D01].[M01].[Y0001]') != ''",
      },
      context(),
    );
    expect(warnings.map((w) => [w.path, w.rule_id])).toEqual([
      ["output_transform_function", CONSISTENCY_RULE_IDS.localeOutsideFmt],
      ["validation_expression", CONSISTENCY_RULE_IDS.localeOutsideFmt],
    ]);
  });
});

describe("consistency lint · duplicates against sibling workflows", () => {
  const sibling = (over: Partial<PriorWorkflowRef> = {}): PriorWorkflowRef => ({
    id: "00000000-0000-4000-8000-0000000000b1",
    slug: "charges-digest",
    name: "Charges digest",
    description: null,
    trigger_summary: "manual",
    step_topology: [
      { kind: "request", connector_id: CONNECTOR, action: "GET /charges" },
      { kind: "transform" },
    ],
    output_keys: [],
    ...over,
  });

  test("the same steps as an active sibling are reported", () => {
    const warnings = lint(baseWorkflow, context([], [sibling()]));
    expect(warnings.map((w) => [w.path, w.rule_id])).toEqual([
      ["steps", CONSISTENCY_RULE_IDS.duplicateSteps],
    ]);
    expect(warnings[0]?.message).toContain("charges-digest");
  });

  test("the same name as an active sibling is reported", () => {
    const warnings = lint(
      baseWorkflow,
      context([], [sibling({ name: "ops daily digest", step_topology: [{ kind: "transform" }] })]),
    );
    expect(warnings.map((w) => [w.path, w.rule_id])).toEqual([
      ["name", CONSISTENCY_RULE_IDS.duplicateName],
    ]);
  });

  test("the workflow being edited is never its own duplicate", () => {
    const self = sibling({ name: baseWorkflow.name });
    expect(lint(baseWorkflow, context([], [self], self.id))).toEqual([]);
    expect(lint(baseWorkflow, context([], [{ ...self, slug: baseWorkflow.slug }]))).toEqual([]);
  });
});

describe("consistency lint · warning mode", () => {
  test("warnings never turn a valid definition invalid", () => {
    const input = {
      ...baseWorkflow,
      trigger: { kind: "schedule", cron: "0 7 * * *" },
    };
    const validation = validateWorkflowDef(input, { lintJavascript: true });
    expect(validation.ok).toBe(true);
    expect(validation.warnings).toBeUndefined();
    expect(lint(input, context([namingRule]))).toHaveLength(2);
  });
});
