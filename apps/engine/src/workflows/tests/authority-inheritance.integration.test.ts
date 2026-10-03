import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../../execution/authority-admission.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { boundaryGrowth, carryApprovalsForward } from "../authority-inheritance.ts";
import { WorkflowEffectManifestSchema } from "../effect-manifest.ts";
import { previewWorkflowAuthority } from "../execution-authorities.ts";

let ctx: TestDb;
let counter = 0;
const actor = "00000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  ctx = await createTestDb("authority_inheritance");
});
afterAll(async () => {
  await ctx.cleanup();
});

type Step = Record<string, unknown>;

async function connector(tenant_id: string, slug: string, base_url: string) {
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url,
    })
    .returning();
  if (!row) throw new Error("missing connector fixture");
  return row;
}

/** An active workflow whose v1 holds a live approval for `steps`. */
async function fixture(
  steps: (connectors: { main: string; other: string }) => Step[],
  bounds: { max_runs: number | null; valid_until: Date | null; reserved_runs?: number } = {
    max_runs: 10,
    valid_until: null,
  },
) {
  const slug = `authority-inheritance-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const main = await connector(tenant.id, `${slug}-main`, "https://example.test/api");
  const other = await connector(tenant.id, `${slug}-other`, "https://other.example.test/api");
  const ids = { main: main.id, other: other.id };
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("missing workflow fixture");
  const v1 = await version(tenant.id, workflow.id, 1, steps(ids));
  await ctx.db
    .update(workflows)
    .set({ current_version_id: v1 })
    .where(eq(workflows.id, workflow.id));
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: v1,
      execution_environment: "dev",
    },
    ctx.db,
  );
  expect(preview.eligible_for_repeated_runs).toBe(true);
  const now = await databaseNow(ctx.db);
  const [authority] = await ctx.db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: v1,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      target_constraints: { targets: [] },
      execution_environment: "dev",
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: bounds.valid_until,
      max_runs: bounds.max_runs,
      reserved_runs: bounds.reserved_runs ?? 0,
      created_by: actor,
    })
    .returning();
  if (!authority) throw new Error("missing authority fixture");
  return { tenant_id: tenant.id, workflow_id: workflow.id, ids, v1, authority, next: 2 };
}

async function version(tenant_id: string, workflow_id: string, n: number, steps: Step[]) {
  const [row] = await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id, version: n, dag: { name: `wf-${n}`, steps } })
    .returning();
  if (!row) throw new Error("missing version fixture");
  return row.id;
}

/** Make a new version active the way every activation path does. */
async function activate(f: Awaited<ReturnType<typeof fixture>>, steps: Step[]) {
  const id = await version(f.tenant_id, f.workflow_id, f.next++, steps);
  const [current] = await ctx.db
    .select({ id: workflows.current_version_id })
    .from(workflows)
    .where(eq(workflows.id, f.workflow_id));
  const outcome = await ctx.db.transaction(async (tx) => {
    await tx
      .update(workflows)
      .set({ current_version_id: id })
      .where(eq(workflows.id, f.workflow_id));
    return carryApprovalsForward(tx, {
      tenant_id: f.tenant_id,
      workflow_id: f.workflow_id,
      from_version_id: current?.id ?? null,
      to_version_id: id,
      actor_id: actor,
    });
  });
  return { id, outcome };
}

async function grantsOf(workflow_id: string) {
  return ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.workflow_id, workflow_id));
}

const post = (connector_id: string, path = "/messages", body: unknown = { to: "a" }): Step => ({
  id: "send",
  kind: "request",
  connector_id,
  method: "POST",
  path,
  body,
});
const get = (connector_id: string, id = "status", path = "/status"): Step => ({
  id,
  kind: "request",
  connector_id,
  method: "GET",
  path,
});

describe("an approval follows a version whose boundary does not grow", () => {
  test("equal boundary: remaining runs and end date carried, parent ended, runs admitted", async () => {
    const until = new Date((await databaseNow(ctx.db)).getTime() + 5 * 24 * 60 * 60_000);
    const f = await fixture(({ main }) => [post(main)], {
      max_runs: 10,
      valid_until: until,
      reserved_runs: 4,
    });
    // Different payload and step id; same connector, address and effect.
    const next = await activate(f, [
      { ...post(f.ids.main, "/messages", { to: "b" }), id: "deliver" },
    ]);
    expect(next.outcome.inherited).toHaveLength(1);
    const rows = await grantsOf(f.workflow_id);
    const parent = rows.find((row) => row.id === f.authority.id);
    const child = rows.find((row) => row.inherited_from === f.authority.id);
    expect(child).toMatchObject({
      workflow_version_id: next.id,
      execution_environment: "dev",
      max_runs: 6,
      reserved_runs: 0,
      created_by: actor,
    });
    expect(child?.valid_until?.toISOString()).toBe(until.toISOString());
    expect(child?.approved_manifest).toEqual(f.authority.effect_manifest);
    expect(parent?.superseded_by).toBe(child?.id ?? "missing");
    expect(parent?.revoked_at).not.toBeNull();
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, f.tenant_id),
          eq(auditLog.action, "workflow.authority_inherited"),
        ),
      );
    expect(audit?.metadata).toMatchObject({
      inherited_from: f.authority.id,
      previous_version_id: f.v1,
      workflow_version_id: next.id,
      max_runs: 6,
    });
    // The carried approval is what admission and dispatch actually accept.
    const params = {
      tenant_id: f.tenant_id,
      workflow_id: f.workflow_id,
      execution_environment: "dev" as const,
      request_source: "api" as const,
    };
    const run = await admitAuthorizedWorkflowExecution(params, ctx.db);
    expect(run.execution_authority_id).toBe(child?.id ?? "missing");
    await assertExecutionAuthorityCurrent(ctx.db, f.tenant_id, run.execution_id);
    // No doubled allowance: six runs in total, then refused.
    for (let i = 1; i < 6; i++) await admitAuthorizedWorkflowExecution(params, ctx.db);
    await expect(admitAuthorizedWorkflowExecution(params, ctx.db)).rejects.toMatchObject({
      code: "execution_authority_unavailable",
    });
  });

  test("subset: dropping a reached address still inherits; an open-ended grant stays open", async () => {
    const f = await fixture(({ main }) => [post(main), get(main)], {
      max_runs: null,
      valid_until: null,
    });
    const next = await activate(f, [get(f.ids.main)]);
    expect(next.outcome.inherited).toHaveLength(1);
    const child = (await grantsOf(f.workflow_id)).find((row) => row.inherited_from);
    expect(child).toMatchObject({ max_runs: null, valid_until: null });
    // A write to the same address as before is still inside the original
    // approval, measured against what the person approved, not the subset.
    const again = await activate(f, [post(f.ids.main)]);
    expect(again.outcome.inherited).toHaveLength(1);
  });

  test("a draft that is saved but not activated carries nothing", async () => {
    const f = await fixture(({ main }) => [post(main)]);
    await version(f.tenant_id, f.workflow_id, f.next++, [post(f.ids.main)]);
    expect(await grantsOf(f.workflow_id)).toHaveLength(1);
  });
});

describe("an approval does not follow a version that reaches more", () => {
  test("a new connector", async () => {
    const f = await fixture(({ main }) => [post(main)]);
    const next = await activate(f, [post(f.ids.main), get(f.ids.other)]);
    expect(next.outcome.inherited).toEqual([]);
    expect(next.outcome.growth.dev).toEqual([
      {
        kind: "new_connector",
        connector_id: f.ids.other,
        connector_name: expect.stringContaining("-other"),
        target: "https://other.example.test/api/status",
        effect: "read",
      },
    ]);
    const [stored] = await ctx.db
      .select({ growth: workflowVersions.authority_growth })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, next.id));
    expect(stored?.growth).toEqual(next.outcome.growth);
    const [parent] = (await grantsOf(f.workflow_id)).filter((row) => row.id === f.authority.id);
    expect(parent?.revoked_at).toBeNull();
    expect(await grantsOf(f.workflow_id)).toHaveLength(1);
  });

  test("a new address on a known connector", async () => {
    const f = await fixture(({ main }) => [post(main)]);
    const next = await activate(f, [post(f.ids.main, "/other-messages")]);
    expect(next.outcome.inherited).toEqual([]);
    expect(next.outcome.growth.dev?.map((entry) => entry.kind)).toEqual(["new_target"]);
  });

  test("a known address now written to where it was only read", async () => {
    const f = await fixture(({ main }) => [get(main, "status", "/messages")]);
    const next = await activate(f, [post(f.ids.main)]);
    expect(next.outcome.inherited).toEqual([]);
    expect(next.outcome.growth.dev).toEqual([
      expect.objectContaining({ kind: "wider_effect", effect: "write" }),
    ]);
  });
});

test("concurrent activations carry one approval exactly once", async () => {
  const f = await fixture(({ main }) => [post(main)], { max_runs: 5, valid_until: null });
  const a = await version(f.tenant_id, f.workflow_id, f.next++, [post(f.ids.main)]);
  const b = await version(f.tenant_id, f.workflow_id, f.next++, [post(f.ids.main)]);
  const carry = (to: string) =>
    ctx.db.transaction((tx) =>
      carryApprovalsForward(tx, {
        tenant_id: f.tenant_id,
        workflow_id: f.workflow_id,
        from_version_id: f.v1,
        to_version_id: to,
        actor_id: actor,
      }),
    );
  const outcomes = await Promise.all([carry(a), carry(b)]);
  expect(outcomes.flatMap((outcome) => outcome.inherited)).toHaveLength(1);
  const children = (await grantsOf(f.workflow_id)).filter((row) => row.inherited_from);
  expect(children).toHaveLength(1);
  expect(children[0]?.max_runs).toBe(5);
});

test("boundary comparison ignores step ids and payloads, not targets or effects", async () => {
  const f = await fixture(({ main }) => [post(main)]);
  const granted = WorkflowEffectManifestSchema.parse(f.authority.effect_manifest);
  const renamed = {
    ...granted,
    effects: granted.effects.map((effect) => ({
      ...effect,
      step_id: "x",
      request_digest: "f".repeat(64),
    })),
  };
  expect(boundaryGrowth(granted, renamed)).toEqual([]);
  const destructive = {
    ...granted,
    effects: granted.effects.map((effect) => ({ ...effect, effect: "destructive" as const })),
  };
  expect(boundaryGrowth(granted, destructive).map((entry) => entry.kind)).toEqual(["wider_effect"]);
});
