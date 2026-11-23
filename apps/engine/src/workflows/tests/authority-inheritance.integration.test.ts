import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import {
  auditLog,
  connectors,
  tenants,
  users,
  workflowAuthorityPairRequests,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  admitAuthorizedWorkflowExecution,
  assertExecutionAuthorityCurrent,
} from "../../execution/authority-admission.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
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

async function activate(
  f: Awaited<ReturnType<typeof fixture>>,
  steps: Step[],
  actor_type?: "user" | "system_account",
) {
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
      ...(actor_type ? { actor_type } : {}),
    });
  });
  return { id, outcome };
}

test("approval inheritance preserves a system account actor", async () => {
  const f = await fixture(({ main }) => [post(main)]);
  const next = await activate(f, [post(f.ids.main)], "system_account");
  expect(next.outcome.inherited).toHaveLength(1);
  const entries = await ctx.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.tenant_id),
        eq(auditLog.action, AuditAction.WORKFLOW_AUTHORITY_INHERITED),
      ),
    );
  expect(entries).toContainEqual({ actor_type: "system_account", actor_id: actor });
});

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
      inheritance_basis: "exact",
      relaxed_keys: {},
    });
    const params = {
      tenant_id: f.tenant_id,
      workflow_id: f.workflow_id,
      execution_environment: "dev" as const,
      request_source: "api" as const,
    };
    const run = await admitAuthorizedWorkflowExecution(params, ctx.db);
    expect(run.execution_authority_id).toBe(child?.id ?? "missing");
    await assertExecutionAuthorityCurrent(ctx.db, f.tenant_id, run.execution_id);
    for (let i = 1; i < 6; i++) await admitAuthorizedWorkflowExecution(params, ctx.db);
    await expect(admitAuthorizedWorkflowExecution(params, ctx.db)).rejects.toMatchObject({
      code: "execution_authority_exhausted",
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
    const again = await activate(f, [post(f.ids.main)]);
    expect(again.outcome.inherited).toHaveLength(1);
  });

  test("a draft that is saved but not activated carries nothing", async () => {
    const f = await fixture(({ main }) => [post(main)]);
    await version(f.tenant_id, f.workflow_id, f.next++, [post(f.ids.main)]);
    expect(await grantsOf(f.workflow_id)).toHaveLength(1);
  });
});

async function inheritedAudit(tenant_id: string) {
  const [audit] = await ctx.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "workflow.authority_inherited")),
    );
  return audit?.metadata;
}

const search = (connector_id: string, query: Record<string, string>): Step => ({
  id: "search",
  kind: "request",
  connector_id,
  method: "GET",
  path: "/issues",
  query,
});

const ITEMS_QUERY = "query Items($owner: String!) { user(login: $owner) { id } }";
const items = (
  connector_id: string,
  variables: Record<string, unknown>,
  query = ITEMS_QUERY,
): Step => ({
  id: "items",
  kind: "request",
  protocol: "graphql",
  connector_id,
  method: "POST",
  path: "/graphql",
  graphql: { query, variables },
});

describe("a workspace that asks for two people", () => {
  async function pairWorkspace(f: Awaited<ReturnType<typeof fixture>>) {
    await ctx.db
      .update(tenants)
      .set({ workflow_approval_policy: "pair" })
      .where(eq(tenants.id, f.tenant_id));
  }

  async function approvedByTwo(f: Awaited<ReturnType<typeof fixture>>) {
    const role_id = await builtinRoleId(ctx.db, "admin");
    const people = await ctx.db
      .insert(users)
      .values(
        ["first", "second"].map((name) => ({
          tenant_id: f.tenant_id,
          email: `${name}-${f.workflow_id}@example.test`,
          role_id,
        })),
      )
      .returning();
    const now = await databaseNow(ctx.db);
    await ctx.db.insert(workflowAuthorityPairRequests).values({
      tenant_id: f.tenant_id,
      workflow_id: f.workflow_id,
      workflow_version_id: f.v1,
      execution_environment: "dev",
      expected_manifest_digest: f.authority.effect_manifest_digest,
      grant: {},
      first_approver_id: people[0]?.id ?? "",
      second_approver_id: people[1]?.id ?? "",
      state: "approved",
      expires_at: new Date(now.getTime() + 60_000),
      decided_at: now,
      authority_id: f.authority.id,
    });
  }

  test("does not carry what one person approved, and the new version waits", async () => {
    const f = await fixture(({ main }) => [post(main)]);
    await pairWorkspace(f);
    const next = await activate(f, [
      { ...post(f.ids.main, "/messages", { to: "b" }), id: "deliver" },
    ]);
    expect(next.outcome.inherited).toHaveLength(0);
    const rows = await grantsOf(f.workflow_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).toBeNull();
    await expect(
      admitAuthorizedWorkflowExecution(
        {
          tenant_id: f.tenant_id,
          workflow_id: f.workflow_id,
          execution_environment: "dev",
          request_source: "api",
        },
        ctx.db,
      ),
    ).rejects.toMatchObject({ code: "execution_authority_required" });
  });

  test("carries what two people approved, again on the version after", async () => {
    const f = await fixture(({ main }) => [post(main)]);
    await pairWorkspace(f);
    await approvedByTwo(f);
    const next = await activate(f, [
      { ...post(f.ids.main, "/messages", { to: "b" }), id: "deliver" },
    ]);
    expect(next.outcome.inherited).toHaveLength(1);
    const again = await activate(f, [
      { ...post(f.ids.main, "/messages", { to: "c" }), id: "deliver" },
    ]);
    expect(again.outcome.inherited).toHaveLength(1);
  });
});

describe("a read approval follows changed literal request values", () => {
  test("a changed literal query value carries and is audited as a relaxed read", async () => {
    const f = await fixture(({ main }) => [search(main, { state: "open", sort: "created" })]);
    const next = await activate(f, [search(f.ids.main, { state: "closed", sort: "created" })]);
    expect(next.outcome.growth).toEqual({});
    expect(next.outcome.inherited).toHaveLength(1);
    expect(await inheritedAudit(f.tenant_id)).toMatchObject({
      inheritance_basis: "read_relaxed",
      relaxed_keys: { search: ["query.state"] },
    });
  });

  test("a changed GraphQL variable value on the same query document carries", async () => {
    const f = await fixture(({ main }) => [items(main, { owner: "acme" })]);
    const next = await activate(f, [items(f.ids.main, { owner: "someone-else" })]);
    expect(next.outcome.growth).toEqual({});
    expect(next.outcome.inherited).toHaveLength(1);
    expect(await inheritedAudit(f.tenant_id)).toMatchObject({
      inheritance_basis: "read_relaxed",
      relaxed_keys: { items: ["graphql.variables.owner"] },
    });
  });

  test("an added query key asks a person again", async () => {
    const f = await fixture(({ main }) => [search(main, { state: "open" })]);
    const next = await activate(f, [search(f.ids.main, { state: "open", assignee: "*" })]);
    expect(next.outcome.inherited).toEqual([]);
    expect(next.outcome.growth.dev?.map((entry) => entry.kind)).toEqual(["changed_boundary"]);
  });

  test("a literal query value beside a reviewed query boundary asks a person again", async () => {
    const since = "${input.since}";
    const f = await fixture(({ main }) => [search(main, { state: "open", since })]);
    const next = await activate(f, [search(f.ids.main, { state: "all", since })]);
    expect(next.outcome.inherited).toEqual([]);
    expect(next.outcome.growth.dev?.map((entry) => entry.kind)).toEqual(["changed_boundary"]);
  });

  test("a changed GraphQL document asks a person again", async () => {
    const f = await fixture(({ main }) => [items(main, { owner: "acme" })]);
    const next = await activate(f, [
      items(f.ids.main, { owner: "acme" }, ITEMS_QUERY.replace("{ id }", "{ id email }")),
    ]);
    expect(next.outcome.inherited).toEqual([]);
    expect(next.outcome.growth.dev?.map((entry) => entry.kind)).toEqual(["changed_boundary"]);
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

  test("a new model step that sends step data to the AI model", async () => {
    const f = await fixture(({ main }) => [post(main)]);
    const model = {
      id: "classify",
      kind: "model",
      prompt: "Sort ${input.text}",
      output_schema: { type: "object" },
    };
    const next = await activate(f, [post(f.ids.main), model]);
    expect(next.outcome.inherited).toEqual([]);
    expect(next.outcome.growth.dev).toEqual([
      {
        kind: "new_model_call",
        connector_id: null,
        connector_name: null,
        target: null,
        effect: "read",
        item: "classify",
      },
    ]);
    expect(await grantsOf(f.workflow_id)).toHaveLength(1);
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
