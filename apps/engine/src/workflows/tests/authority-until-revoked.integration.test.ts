import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  auditLog,
  sessions,
  tenants,
  users,
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
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { carryApprovalsForward } from "../authority-inheritance.ts";
import {
  grantWorkflowAuthority,
  makeWorkflowAuthorityUntilRevoked,
  previewWorkflowAuthority,
  revokeWorkflowAuthority,
} from "../execution-authorities.ts";

let ctx: TestDb;
let counter = 0;
beforeAll(async () => {
  ctx = await createTestDb("authority_until_revoked");
});
afterAll(async () => {
  await ctx.cleanup();
});

const steps = [
  {
    id: "send",
    kind: "request",
    method: "POST",
    url: "https://example.test/messages",
    body: { recipient: "reviewed@example.test" },
  },
];

async function fixture(max_runs: number | null = 3) {
  const slug = `authority-until-revoked-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: `${slug}@example.test`,
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!user || !workflow) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      version: 1,
      dag: { name: slug, steps },
    })
    .returning();
  if (!version) throw new Error("missing version fixture");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  const from = await databaseNow(ctx.db);
  const until = new Date(from.getTime() + 60 * 60_000);
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: tenant.id,
      user_id: user.id,
      expires_at: until,
      absolute_expires_at: until,
    })
    .returning();
  if (!session) throw new Error("missing session fixture");
  const payload = { tenant_id: tenant.id, user_id: user.id, session_id: session.id };
  const principal: ResolvedPrincipal = {
    provider: "session",
    kind: "user",
    id: user.id,
    tenant_id: tenant.id,
    roles: ["admin"],
    session_id: session.id,
  };
  const request = new Request("https://example.test/v1/workflows/authority", {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(payload)),
      "x-subkit-csrf": await signBrowserCsrf(payload),
    },
  });
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  const context = { db: ctx.db, request, principal };
  const grant = await grantWorkflowAuthority(
    workflow.id,
    {
      workflow_version_id: version.id,
      expected_manifest_digest: preview.digest,
      execution_environment: "dev",
      valid_from: from.toISOString(),
      valid_until: until.toISOString(),
      max_runs,
    },
    context,
  );
  const run = {
    tenant_id: tenant.id,
    workflow_id: workflow.id,
    execution_environment: "dev" as const,
    request_source: "api" as const,
  };
  return {
    tenant_id: tenant.id,
    workflow_id: workflow.id,
    version_id: version.id,
    digest: preview.digest,
    until,
    grant,
    context,
    run,
  };
}

async function authoritiesOf(workflow_id: string) {
  return ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.workflow_id, workflow_id))
    .orderBy(workflowExecutionAuthorities.created_at);
}

test("a time-limited approval becomes open-ended with the same boundary and no run stops", async () => {
  const f = await fixture(3);
  const before = await admitAuthorizedWorkflowExecution(f.run, ctx.db);
  expect(before.execution_authority_id).toBe(f.grant.id);
  const successor = await makeWorkflowAuthorityUntilRevoked(
    f.workflow_id,
    f.grant.id,
    { expected_manifest_digest: f.digest },
    f.context,
  );
  expect(successor.id).not.toBe(f.grant.id);
  expect(successor).toMatchObject({
    workflow_version_id: f.grant.workflow_version_id,
    execution_environment: f.grant.execution_environment,
    effect_manifest_digest: f.grant.effect_manifest_digest,
    effect_manifest: f.grant.effect_manifest,
    target_constraints: f.grant.target_constraints,
    approved_manifest: f.grant.approved_manifest,
    valid_from: f.grant.valid_from,
    valid_until: null,
    max_runs: 3,
    reserved_runs: 1,
    inherited_from: null,
    revoked_at: null,
  });
  const [previous] = (await authoritiesOf(f.workflow_id)).filter((row) => row.id === f.grant.id);
  expect(previous?.superseded_by).toBe(successor.id);
  expect(previous?.revoked_at).not.toBeNull();
  await assertExecutionAuthorityCurrent(ctx.db, f.tenant_id, before.execution_id);
  const after = await admitAuthorizedWorkflowExecution(f.run, ctx.db);
  expect(after.execution_authority_id).toBe(successor.id);
  const pinned = await admitAuthorizedWorkflowExecution(
    { ...f.run, execution_authority_id: f.grant.id },
    ctx.db,
  );
  expect(pinned.execution_authority_id).toBe(successor.id);
  await expect(admitAuthorizedWorkflowExecution(f.run, ctx.db)).rejects.toMatchObject({
    code: "execution_authority_unavailable",
  });
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.tenant_id),
        eq(auditLog.action, "workflow.authority_expiry_removed"),
      ),
    );
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    actor_id: f.context.principal.id,
    resource_id: successor.id,
    metadata: {
      replaced_authority_id: f.grant.id,
      previous_valid_until: f.until.toISOString(),
      valid_until: null,
      max_runs: 3,
      effect_manifest_digest: f.digest,
    },
  });
});

test("runs admitted while the approval is replaced are never refused", async () => {
  const f = await fixture(null);
  const admitted: string[] = [];
  const admitting = (async () => {
    for (let run = 0; run < 8; run++)
      admitted.push((await admitAuthorizedWorkflowExecution(f.run, ctx.db)).execution_id);
  })();
  const [admissions, replacement] = await Promise.allSettled([
    admitting,
    makeWorkflowAuthorityUntilRevoked(
      f.workflow_id,
      f.grant.id,
      { expected_manifest_digest: f.digest },
      f.context,
    ),
  ]);
  expect(admissions.status).toBe("fulfilled");
  expect(replacement.status).toBe("fulfilled");
  expect(admitted).toHaveLength(8);
  for (const execution_id of admitted)
    await assertExecutionAuthorityCurrent(ctx.db, f.tenant_id, execution_id);
  const rows = await authoritiesOf(f.workflow_id);
  expect(rows).toHaveLength(2);
  const successor = rows.find((row) => row.id !== f.grant.id);
  expect(successor?.valid_until).toBeNull();
  expect(successor?.reserved_runs).toBe(8);
});

test("retries and parallel requests create one open-ended approval", async () => {
  const f = await fixture();
  const body = { expected_manifest_digest: f.digest };
  const [a, b] = await Promise.all([
    makeWorkflowAuthorityUntilRevoked(f.workflow_id, f.grant.id, body, f.context),
    makeWorkflowAuthorityUntilRevoked(f.workflow_id, f.grant.id, body, f.context),
  ]);
  expect(a.id).toBe(b.id);
  const again = await makeWorkflowAuthorityUntilRevoked(f.workflow_id, f.grant.id, body, f.context);
  expect(again.id).toBe(a.id);
  const unchanged = await makeWorkflowAuthorityUntilRevoked(f.workflow_id, a.id, body, f.context);
  expect(unchanged.id).toBe(a.id);
  expect(await authoritiesOf(f.workflow_id)).toHaveLength(2);
  const audit = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.tenant_id),
        eq(auditLog.action, "workflow.authority_expiry_removed"),
      ),
    );
  expect(audit).toHaveLength(1);
});

test("only a person who may grant can remove the expiry", async () => {
  const f = await fixture();
  const body = { expected_manifest_digest: f.digest };
  const noSession = { ...f.context.principal };
  delete noSession.session_id;
  await expect(
    makeWorkflowAuthorityUntilRevoked(f.workflow_id, f.grant.id, body, {
      ...f.context,
      principal: noSession,
    }),
  ).rejects.toMatchObject({ code: "human_session_required" });
  const headers = new Headers(f.context.request.headers);
  headers.delete("x-subkit-csrf");
  await expect(
    makeWorkflowAuthorityUntilRevoked(f.workflow_id, f.grant.id, body, {
      ...f.context,
      request: new Request(f.context.request.url, { method: "POST", headers }),
    }),
  ).rejects.toMatchObject({ code: "csrf_rejected" });
  await ctx.db
    .update(users)
    .set({ role_id: await emptyRoleId(ctx.db, f.tenant_id) })
    .where(eq(users.id, f.context.principal.id));
  await expect(
    makeWorkflowAuthorityUntilRevoked(f.workflow_id, f.grant.id, body, {
      ...f.context,
      principal: { ...f.context.principal, roles: [] },
    }),
  ).rejects.toMatchObject({ code: "authority_permission_denied" });
  expect(await authoritiesOf(f.workflow_id)).toHaveLength(1);
});

test("a stale review, a revoked or an expired approval is not replaced", async () => {
  const stale = await fixture();
  await expect(
    makeWorkflowAuthorityUntilRevoked(
      stale.workflow_id,
      stale.grant.id,
      { expected_manifest_digest: "0".repeat(64) },
      stale.context,
    ),
  ).rejects.toMatchObject({ code: "authority_manifest_changed" });
  await revokeWorkflowAuthority(stale.workflow_id, stale.grant.id, stale.context);
  await expect(
    makeWorkflowAuthorityUntilRevoked(
      stale.workflow_id,
      stale.grant.id,
      { expected_manifest_digest: stale.digest },
      stale.context,
    ),
  ).rejects.toMatchObject({ code: "authority_revoked" });
  const exhausted = await fixture(1);
  await admitAuthorizedWorkflowExecution(exhausted.run, ctx.db);
  await expect(
    makeWorkflowAuthorityUntilRevoked(
      exhausted.workflow_id,
      exhausted.grant.id,
      { expected_manifest_digest: exhausted.digest },
      exhausted.context,
    ),
  ).rejects.toMatchObject({ code: "authority_not_live" });
  expect(await authoritiesOf(stale.workflow_id)).toHaveLength(1);
  expect(await authoritiesOf(exhausted.workflow_id)).toHaveLength(1);
});

test("a run of a version whose approval moved to a newer version still stops", async () => {
  const f = await fixture(null);
  const before = await admitAuthorizedWorkflowExecution(f.run, ctx.db);
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant_id,
      workflow_id: f.workflow_id,
      version: 2,
      dag: { name: "next", steps },
    })
    .returning();
  if (!next) throw new Error("missing next version fixture");
  const carried = await ctx.db.transaction(async (tx) => {
    await tx
      .update(workflows)
      .set({ current_version_id: next.id })
      .where(eq(workflows.id, f.workflow_id));
    return carryApprovalsForward(tx, {
      tenant_id: f.tenant_id,
      workflow_id: f.workflow_id,
      from_version_id: f.version_id,
      to_version_id: next.id,
      actor_id: f.context.principal.id,
    });
  });
  expect(carried.inherited).toHaveLength(1);
  await expect(
    assertExecutionAuthorityCurrent(ctx.db, f.tenant_id, before.execution_id),
  ).rejects.toMatchObject({ code: "execution_authority_unavailable" });
});
