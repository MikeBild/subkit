import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createSkill } from "../../skills/service.ts";
import { createSeededRandom } from "../../test-helpers/determinism/random.ts";
import { CONSISTENCY_RULE_IDS } from "../consistency-lint.ts";
import { createWorkflow } from "../service.ts";
import { validateTenantWorkflowDef } from "../tenant-validator.ts";

let ctx: TestDb;
const rng = createSeededRandom(0xc0_25_15_7e);

beforeAll(async () => {
  ctx = await createTestDb("consistency_lint_tenant");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function newTenant(label: string): Promise<string> {
  const suffix = rng.bytes(4).reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${label}-${suffix}`, display_name: label })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  return t.id;
}

async function publishNamingRule(tenant_id: string): Promise<void> {
  await createSkill(
    {
      tenant_id,
      input: {
        scope: "global",
        title: "Naming conventions",
        body: "Workflow slugs carry the finance prefix.",
      },
      conventions: {
        rules: [
          {
            rule_id: "slug-prefix",
            type: "naming",
            statement: "Workflow slugs start with fin-.",
            payload: { applies_to: "workflow_slug", pattern: "^fin-", example: "fin-daily" },
          },
        ],
      },
    },
    ctx.db,
  );
}

const sibling = {
  name: "Charges digest",
  slug: "charges-digest",
  steps: [
    { id: "fetch", kind: "request", method: "GET", url: "https://api.example.test/charges" },
    { id: "shape", kind: "transform", expression: "return input.scope.fetch.data;" },
  ],
};

const draft = {
  name: "Ops daily digest",
  slug: "ops-daily-digest",
  trigger: { kind: "schedule", cron: "0 7 * * *" },
  steps: sibling.steps,
};

describe("validateTenantWorkflowDef · consistency lint", () => {
  test("applies the tenant's own published rules and active siblings as warnings", async () => {
    const tenant_id = await newTenant("own");
    await publishNamingRule(tenant_id);
    const created = await createWorkflow({ tenant_id, def: sibling, actor_id: null }, ctx.db);
    if ("errors" in created) throw new Error(created.errors.join("; "));

    const result = await validateTenantWorkflowDef(draft, tenant_id, ctx.db, {
      lintJavascript: true,
      consistency: {},
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect((result.warnings ?? []).map((w) => [w.path, w.rule_id])).toEqual([
      ["slug", "slug-prefix"],
      ["trigger.tz", CONSISTENCY_RULE_IDS.scheduleTz],
      ["steps", CONSISTENCY_RULE_IDS.duplicateSteps],
    ]);

    const plain = await validateTenantWorkflowDef(draft, tenant_id, ctx.db, {
      lintJavascript: true,
    });
    expect(plain.warnings).toBeUndefined();
  });

  test("never applies another tenant's rules or workflows", async () => {
    const owner = await newTenant("owner");
    await publishNamingRule(owner);
    const created = await createWorkflow(
      { tenant_id: owner, def: sibling, actor_id: null },
      ctx.db,
    );
    if ("errors" in created) throw new Error(created.errors.join("; "));

    const other = await newTenant("other");
    const result = await validateTenantWorkflowDef(draft, other, ctx.db, { consistency: {} });
    expect(result.ok).toBe(true);
    expect((result.warnings ?? []).map((w) => w.rule_id)).toEqual([
      CONSISTENCY_RULE_IDS.scheduleTz,
    ]);
  });
});
