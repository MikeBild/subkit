import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { executions, workflowExecutionAuthorities } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { requestDigest } from "../../workflows/core/request-protocol.ts";
import { compileWorkflowEffectManifest } from "../../workflows/effect-manifest.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../../workflows/types.ts";
import { assertExecutionAuthorityCurrent } from "../authority-admission.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let sequence = 0;
const actor = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  ctx = await createEngineCtx("authority-call");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
});
afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function fixture() {
  const db = ctx.testDb.db;
  const n = ++sequence;
  const childDefinition = WorkflowDefSchema.parse({
    name: `child-${n}`,
    slug: `child-${n}`,
    steps: [
      {
        id: "publish",
        kind: "request",
        method: "POST",
        url: `${mock.baseUrl}/child`,
        body: { ok: true },
      },
    ],
  });
  const child = await createWorkflowRow(ctx, childDefinition);
  const parentDefinition = WorkflowDefSchema.parse({
    name: `parent-${n}`,
    slug: `parent-${n}`,
    steps: [
      {
        id: "collect",
        kind: "request",
        method: "POST",
        url: `${mock.baseUrl}/collect`,
        body: { ok: true },
      },
      { id: "run_child", kind: "call", workflow_id: child.workflow_id, depends_on: ["collect"] },
    ],
  });
  const parent = await createWorkflowRow(ctx, parentDefinition);
  const bind = (definition: WorkflowDef, step_id: string, target: string) => ({
    tenant_id: ctx.tenantId,
    step_id,
    connector_id: null,
    driver: "http" as const,
    environment: "dev" as const,
    request_digest: requestDigest(definition.steps.find((s) => s.id === step_id)),
    target,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: null,
    rewrites_target: false,
  });
  const compiled = compileWorkflowEffectManifest({
    tenant_id: ctx.tenantId,
    workflow_id: parent.workflow_id,
    workflow_version_id: parent.version_id,
    execution_environment: "dev",
    execution_options_digest: "b".repeat(64),
    definition: parentDefinition,
    bindings: [bind(parentDefinition, "collect", `${mock.baseUrl}/collect`)],
    calls: [
      {
        step_id: "run_child",
        workflow_id: child.workflow_id,
        workflow_slug: `child-${n}`,
        workflow_version_id: child.version_id,
        execution_options_digest: "c".repeat(64),
        definition: childDefinition,
        bindings: [bind(childDefinition, "publish", `${mock.baseUrl}/child`)],
      },
    ],
  });
  expect(compiled.manifest.issues).toEqual([]);
  expect(compiled.manifest.calls?.[0]?.workflow_version_id).toBe(child.version_id);
  const now = await databaseNow(db);
  const [authority] = await db
    .insert(workflowExecutionAuthorities)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: parent.workflow_id,
      workflow_version_id: parent.version_id,
      effect_manifest_digest: compiled.digest,
      effect_manifest: { ...compiled.manifest },
      target_constraints: { targets: [] },
      execution_environment: "dev",
      valid_from: new Date(now.getTime() - 60_000),
      valid_until: new Date(now.getTime() + 60 * 60_000),
      max_runs: 5,
      created_by: actor,
    })
    .returning();
  if (!authority) throw new Error("missing authority fixture");
  const [root] = await db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      execution_authority_id: authority.id,
      workflow_id: parent.workflow_id,
      workflow_version_id: parent.version_id,
      source_kind: "saved",
      source_ref: null,
      status: "queued",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning();
  if (!root) throw new Error("missing root execution fixture");
  return { authority, root, parent, child, manifest: compiled.manifest };
}

async function linkedChild(root_execution_id: string, child_workflow: string, version: string) {
  const [row] = await ctx.testDb.db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: child_workflow,
      workflow_version_id: version,
      source_kind: "saved",
      source_ref: null,
      status: "running",
      request_source: "tool-chain",
      execution_mode: "dev",
      parent_execution_id: root_execution_id,
      authority_root_execution_id: root_execution_id,
      authority_call_path: ["run_child"],
    })
    .returning();
  if (!row) throw new Error("missing linked child fixture");
  return row;
}

function reasonOf(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth += 1) {
    const e = cur as { message?: string; cause?: unknown };
    if (e.message) parts.push(e.message);
    cur = e.cause;
  }
  return parts.join(" | ");
}

async function refused(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return reasonOf(err);
  }
}

test("a linked child is measured against the root's approval, not waved through", async () => {
  const f = await fixture();
  const child = await linkedChild(f.root.id, f.child.workflow_id, f.child.version_id);
  const effect = f.manifest.effects.find((e) => e.call_path?.[0] === "run_child");
  if (!effect) throw new Error("missing folded child effect");
  await expect(
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, child.id, {
      step_id: effect.step_id,
      configuration_digest: effect.configuration_digest,
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      request: { method: "POST", url: `${mock.baseUrl}/child`, headers: {}, body: null as never },
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
  await expect(
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, child.id, {
      step_id: "somewhere_else",
      configuration_digest: effect.configuration_digest,
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      request: { method: "POST", url: `${mock.baseUrl}/other`, headers: {}, body: null as never },
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
});

test("the parent's own step is not reachable from inside the child", async () => {
  const f = await fixture();
  const child = await linkedChild(f.root.id, f.child.workflow_id, f.child.version_id);
  const own = f.manifest.effects.find((e) => e.call_path === undefined);
  if (!own) throw new Error("missing root effect");
  await expect(
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, child.id, {
      step_id: own.step_id,
      configuration_digest: own.configuration_digest,
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      request: { method: "POST", url: `${mock.baseUrl}/collect`, headers: {}, body: null as never },
    }),
  ).rejects.toMatchObject({ code: "execution_authority_changed" });
});

test("revoking the root's approval stops its child", async () => {
  const f = await fixture();
  const child = await linkedChild(f.root.id, f.child.workflow_id, f.child.version_id);
  await ctx.testDb.db
    .update(workflowExecutionAuthorities)
    .set({ revoked_at: await databaseNow(ctx.testDb.db), revoked_by: actor })
    .where(eq(workflowExecutionAuthorities.id, f.authority.id));
  const effect = f.manifest.effects.find((e) => e.call_path?.[0] === "run_child");
  await expect(
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, child.id, {
      step_id: effect?.step_id ?? "publish",
      configuration_digest: effect?.configuration_digest ?? "a".repeat(64),
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
      request: { method: "POST", url: `${mock.baseUrl}/child`, headers: {}, body: null as never },
    }),
  ).rejects.toMatchObject({ code: "execution_authority_unavailable" });
});

test("cancelling the root stops its child", async () => {
  const f = await fixture();
  const child = await linkedChild(f.root.id, f.child.workflow_id, f.child.version_id);
  await ctx.testDb.db
    .update(executions)
    .set({ abort_requested_at: await databaseNow(ctx.testDb.db) })
    .where(eq(executions.id, f.root.id));
  await expect(
    assertExecutionAuthorityCurrent(ctx.testDb.db, ctx.tenantId, child.id),
  ).rejects.toMatchObject({ code: "execution_boundary_mismatch" });
});

test("the database refuses a link that does not hang together", async () => {
  const f = await fixture();
  const db = ctx.testDb.db;
  const base = {
    tenant_id: ctx.tenantId,
    workflow_id: f.child.workflow_id,
    workflow_version_id: f.child.version_id,
    source_kind: "saved" as const,
    source_ref: null,
    status: "running" as const,
    request_source: "tool-chain" as const,
    execution_mode: "dev" as const,
  };
  const insert = (extra: Record<string, unknown>) => async () => {
    await db.insert(executions).values({ ...base, ...extra });
  };
  const linked = { authority_root_execution_id: f.root.id, authority_call_path: ["run_child"] };
  const named = async (cases: Record<string, Record<string, unknown>>) => {
    const out: Record<string, boolean> = {};
    for (const [name, extra] of Object.entries(cases)) {
      out[name] = (await refused(insert(extra))) !== null;
    }
    return out;
  };
  expect(
    await named({
      root_without_path: { authority_root_execution_id: f.root.id },
      path_without_root: { authority_call_path: ["run_child"] },
      parent_is_someone_else: { ...linked, parent_execution_id: null },
      holds_its_own_approval: {
        ...linked,
        parent_execution_id: f.root.id,
        execution_authority_id: f.authority.id,
      },
      is_a_preview: { ...linked, parent_execution_id: f.root.id, hold_writes: true },
    }),
  ).toEqual({
    root_without_path: true,
    path_without_root: true,
    parent_is_someone_else: true,
    holds_its_own_approval: true,
    is_a_preview: true,
  });
  expect(await refused(insert({ ...linked, parent_execution_id: f.root.id }))).toBeNull();
});

test("a link cannot be attached, moved or removed after the run exists", async () => {
  const f = await fixture();
  const db = ctx.testDb.db;
  const child = await linkedChild(f.root.id, f.child.workflow_id, f.child.version_id);
  const update = (id: string, values: Record<string, unknown>) => async () => {
    await db.update(executions).set(values).where(eq(executions.id, id));
  };
  expect(await refused(update(child.id, { authority_call_path: ["something_else"] }))).toMatch(
    /authority link cannot be/,
  );
  expect(
    await refused(
      update(child.id, { authority_root_execution_id: null, authority_call_path: null }),
    ),
  ).toMatch(/authority link cannot be/);
  const [plain] = await db
    .insert(executions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: f.child.workflow_id,
      workflow_version_id: f.child.version_id,
      source_kind: "saved",
      source_ref: null,
      status: "running",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning();
  expect(
    await refused(
      update(plain?.id ?? "", {
        authority_root_execution_id: f.root.id,
        authority_call_path: ["run_child"],
      }),
    ),
  ).toMatch(/authority link cannot be/);
  expect(await refused(update(child.id, { workflow_version_id: f.parent.version_id }))).toMatch(
    /immutable/,
  );
  expect(await refused(update(child.id, { status: "succeeded" }))).toBeNull();
});

test("the link columns exist only where the shape check allows them", async () => {
  const rows = await ctx.testDb.db.execute(
    sql`SELECT conname FROM pg_constraint WHERE conname = 'executions_authority_link_shape_check'`,
  );
  expect(rows.rows.length).toBe(1);
});
