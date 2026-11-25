import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { createEmptyDraftDocument } from "./authoring-state/index.ts";
import { startWorkflowFromRecipeTool } from "./tools/start-workflow-from-recipe.ts";
import type { DraftDocument } from "./types.ts";

const skip = testEnv.REQUIRES_PG === "0";
let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;
const boundConnectorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("recipe-flow");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "recipe-flow", display_name: "rf" })
    .returning();
  tenant_id = t!.id;
  const [c] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id,
      status: "active",
      draft: createEmptyDraftDocument(),
      loaded_skills: [],
    })
    .returning();
  conversation_id = c!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

function makeToolCtx(opts: {
  tenant_id: string;
  conversation_id: string;
  draft: { current: DraftDocument };
}): Parameters<typeof startWorkflowFromRecipeTool.execute>[0] {
  return {
    db: ctx.db,
    tenant_id: opts.tenant_id,
    conversation_id: opts.conversation_id,
    actor_id: null,
    getDraft: () => opts.draft.current,
    setDraft: async (next: DraftDocument) => {
      opts.draft.current = next;
    },
  } as unknown as Parameters<typeof startWorkflowFromRecipeTool.execute>[0];
}

describe.skipIf(skip)("start_workflow_from_recipe", () => {
  test("clones a Stripe recipe into a draft with derived_from_skill_id set", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { template_slug: "stripe", recipe_slug: "list-customers", connector_id: boundConnectorId },
    );
    expect(result.ok).toBe(true);
    const wf = draft.current.workflow;
    expect(wf).toBeDefined();
    expect(wf?.derived_from_skill_id).toBe("stripe-basics");
    expect(wf?.steps?.length ?? 0).toBeGreaterThan(0);
    expect(wf?.slug).toBe("stripe-list-customers");
    const steps = (
      (wf?.steps ?? []) as Array<{ kind?: string; connector_id?: string; url?: string }>
    ).filter((step) => step.kind === "request");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.map((step) => [step.connector_id, step.url])).toEqual(
      steps.map(() => [boundConnectorId, undefined]),
    );
  });

  test("single-connector recipe without a binding returns connector_bindings_missing", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { template_slug: "notion", recipe_slug: "create-page" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("connector_bindings_missing");
  });

  test("clone stashes a recipe-derived goal so the post-preview judge is armed (not judge.no_goal)", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { template_slug: "stripe", recipe_slug: "list-customers", connector_id: boundConnectorId },
    );
    expect(result.ok).toBe(true);
    const goal = (draft.current.workflow as { goal?: string }).goal;
    expect(typeof goal).toBe("string");
    expect(goal?.length ?? 0).toBeGreaterThan(0);
  });

  test("user-provided name override is folded into the stashed goal", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      {
        template_slug: "stripe",
        recipe_slug: "list-customers",
        connector_id: boundConnectorId,
        name: "Weekly VIP customer pull",
      },
    );
    expect(result.ok).toBe(true);
    const goal = (draft.current.workflow as { goal?: string }).goal;
    expect(goal).toContain("Weekly VIP customer pull");
  });

  test("unknown template returns connector_template_unknown", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { template_slug: "made-up-template", recipe_slug: "x" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("connector_template_unknown");
  });

  test("unknown recipe lists available recipes for the template", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      { template_slug: "stripe", recipe_slug: "made-up" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("connector_recipe_unknown");
      const data = result.data as { available_recipes?: string[] } | undefined;
      expect(data?.available_recipes).toContain("list-customers");
    }
  });

  test("connector_id substitution rebinds the placeholder UUID in postgres recipes", async () => {
    const realConnectorId = "11111111-1111-4111-8111-111111111111";
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      {
        template_slug: "postgres",
        recipe_slug: "list-tables",
        connector_id: realConnectorId,
      },
    );
    expect(result.ok).toBe(true);
    const step = draft.current.workflow?.steps?.[0] as { connector_id?: string } | undefined;
    expect(step?.connector_id).toBe(realConnectorId);
  });

  test("multi-connector recipe rebinds every declared placeholder via connector_bindings", async () => {
    const stripeConnector = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const hubspotConnector = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const slackConnector = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      {
        template_slug: "stripe",
        recipe_slug: "new-customer-enrich-notify",
        connector_bindings: {
          "11111111-1111-4111-8111-111111111111": stripeConnector,
          "22222222-2222-4222-8222-222222222222": hubspotConnector,
          "33333333-3333-4333-8333-333333333333": slackConnector,
        },
      },
    );
    expect(result.ok).toBe(true);
    const steps = draft.current.workflow?.steps as Array<{
      id?: string;
      connector_id?: string;
    }>;
    expect(steps).toHaveLength(3);
    const byId = Object.fromEntries(steps.map((s) => [s.id, s.connector_id]));
    expect(byId.fetch_stripe_customer).toBe(stripeConnector);
    expect(byId.upsert_hubspot_contact).toBe(hubspotConnector);
    expect(byId.notify_slack).toBe(slackConnector);
    const serialized = JSON.stringify(draft.current.workflow);
    expect(serialized).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(serialized).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(serialized).not.toContain("33333333-3333-4333-8333-333333333333");
  });

  test("multi-connector recipe rejects partial bindings with connector_bindings_missing", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      {
        template_slug: "stripe",
        recipe_slug: "new-customer-enrich-notify",
        connector_bindings: {
          "11111111-1111-4111-8111-111111111111": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("connector_bindings_missing");
    const data = result.data as {
      missing_placeholders?: Array<{ placeholder: string; template: string }>;
    };
    expect(data.missing_placeholders?.map((m) => m.template).sort()).toEqual(["hubspot", "slack"]);
    expect(draft.current.workflow?.steps ?? []).toEqual([]);
  });

  test("multi-connector recipe rejects the single connector_id arg with connector_bindings_required", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      {
        template_slug: "stripe",
        recipe_slug: "new-customer-enrich-notify",
        connector_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("connector_bindings_required");
  });

  test("CallStep recipe — delegated-triage-via-call clones with a `call` step", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      {
        template_slug: "github",
        recipe_slug: "delegated-triage-via-call",
        connector_id: boundConnectorId,
      },
    );
    expect(result.ok).toBe(true);
    const wf = draft.current.workflow;
    expect(wf?.derived_from_skill_id).toBe("github-basics");
    const steps = (wf?.steps ?? []) as Array<{ kind?: string; workflow_slug?: string }>;
    const callStep = steps.find((s) => s.kind === "call");
    expect(callStep).toBeDefined();
    expect(callStep?.workflow_slug).toBe("triage-issue");
  });

  test("WaitForEventStep recipe — merge-pr-after-approval clones with a signal-driven pause + explicit branch on timeout", async () => {
    const draft: { current: DraftDocument } = { current: createEmptyDraftDocument() };
    const result = await startWorkflowFromRecipeTool.execute(
      makeToolCtx({ tenant_id, conversation_id, draft }),
      {
        template_slug: "github",
        recipe_slug: "merge-pr-after-approval",
        connector_id: boundConnectorId,
      },
    );
    expect(result.ok).toBe(true);
    const wf = draft.current.workflow;
    const steps = (wf?.steps ?? []) as Array<{
      kind?: string;
      id?: string;
      event_name?: string;
      timeout_ms?: number;
      when?: string;
      then_steps?: string[];
      else_steps?: string[];
    }>;
    const wait = steps.find((s) => s.kind === "wait_for_event");
    expect(wait).toBeDefined();
    expect(wait?.event_name).toBe("pr_approved");
    expect(wait?.timeout_ms).toBe(86_400_000);

    const branch = steps.find((s) => s.kind === "branch");
    expect(branch).toBeDefined();
    expect(branch?.when).toContain("timed_out");
    expect(branch?.then_steps).toEqual(["abandon_on_timeout"]);
    expect(branch?.else_steps).toEqual(["merge"]);

    expect(steps.find((s) => s.id === "merge")).toBeDefined();
    expect(steps.find((s) => s.id === "abandon_on_timeout")).toBeDefined();
  });
});
