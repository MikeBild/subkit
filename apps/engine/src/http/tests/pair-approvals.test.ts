import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import {
  auditLog,
  connectors,
  roles,
  sessions,
  users,
  workflowAuthorityPairRequests,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import { buildAttention } from "../../operator/attention.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import {
  app,
  browserHeaders,
  ctx,
  fixture,
  setupWorkflowAuthorities,
} from "./workflow-authorities-fixtures.ts";

setupWorkflowAuthorities();

const HOUR = 60 * 60_000;

async function personWithSession(email: string) {
  const [person] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id: await builtinRoleId(ctx.db, "admin") })
    .returning();
  if (!person) throw new Error("missing person");
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: person.id,
      expires_at: new Date(Date.now() + HOUR), // allow-wall-clock: live browser fixture
      absolute_expires_at: new Date(Date.now() + HOUR), // allow-wall-clock: live browser fixture
    })
    .returning();
  if (!session) throw new Error("missing session");
  const payload = { tenant_id: ctx.tenantId, user_id: person.id, session_id: session.id };
  return {
    person,
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(payload)),
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "content-type": "application/json",
    },
  };
}

async function call(path: string, headers: Record<string, string>, method = "GET", body?: unknown) {
  const response = await app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function authoritiesOf(workflow_id: string) {
  return ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.workflow_id, workflow_id));
}

let bert: Awaited<ReturnType<typeof personWithSession>>;
let preGranted: { base: string; id: string; digest: string };

test("pair approval cannot be switched on while only one person may approve", async () => {
  const [admin] = await ctx.db
    .select({ role: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(eq(users.id, ctx.userId));
  expect(admin?.role).toBe("admin");
  const single = await call("/v1/workspace/approval-policy", browserHeaders);
  expect(single.body).toMatchObject({ workflow_approvals: "single", ready: false });
  const refused = await call("/v1/workspace/approval-policy", browserHeaders, "PUT", {
    workflow_approvals: "pair",
  });
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ code: "pair_needs_two_approvers" });
});

test("with a second approver the workspace switches to pair and audits it", async () => {
  bert = await personWithSession("bert-pair@example.test");
  const f = await fixture();
  const granted = await call(`${f.base}/execution-authorities`, browserHeaders, "POST", f.body);
  expect(granted.status).toBe(201);
  preGranted = {
    base: f.base,
    id: String(granted.body.id),
    digest: f.body.expected_manifest_digest,
  };

  const member = await call("/v1/workspace/approval-policy", bert.headers, "PUT", {
    workflow_approvals: "pair",
  });
  expect(member.status).toBe(200);
  expect(member.body).toMatchObject({
    workflow_approvals: "pair",
    eligible_approvers: 2,
    ready: true,
  });
  const [entry] = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, AuditAction.WORKSPACE_APPROVAL_POLICY_CHANGED),
      ),
    );
  expect(entry).toMatchObject({ actor_id: bert.person.id, after: { workflow_approvals: "pair" } });
});

test("under pair no single person approves alone, by any path", async () => {
  const f = await fixture();
  const direct = await call(`${f.base}/execution-authorities`, browserHeaders, "POST", f.body);
  expect(direct.status).toBe(409);
  expect(direct.body.code).toBe("pair_approval_required");
  const widened = await call(
    `${preGranted.base}/execution-authorities/${preGranted.id}/until-revoked`,
    browserHeaders,
    "POST",
    { expected_manifest_digest: preGranted.digest },
  );
  expect(widened.status).toBe(409);
  expect(widened.body.code).toBe("pair_approval_required");
  expect(await authoritiesOf(f.workflow.id)).toHaveLength(0);
});

test("two different people approve the same boundary, then it takes effect", async () => {
  const f = await fixture();
  const first = await call(`${f.base}/pair-approvals`, browserHeaders, "POST", f.body);
  expect(first.status).toBe(201);
  expect(first.body).toMatchObject({
    state: "pending",
    first_approver: { user_id: ctx.userId },
    second_approver: null,
    authority_id: null,
    viewer_can_approve: false,
    expected_manifest_digest: f.body.expected_manifest_digest,
  });
  expect(await authoritiesOf(f.workflow.id)).toHaveLength(0);
  const requestId = String(first.body.id);
  const withRun = await call(`${f.base}/pair-approvals`, browserHeaders, "POST", {
    ...f.body,
    start_run: true,
  });
  expect(withRun.status).toBe(422);
  expect(withRun.body.code).toBe("pair_start_run_unsupported");

  const forBert = await buildAttention(ctx.db, {
    provider: "test",
    kind: "user",
    id: bert.person.id,
    tenant_id: ctx.tenantId,
    roles: ["admin"],
  });
  expect(forBert.items.find((item) => item.id === `pair:${requestId}`)).toMatchObject({
    reason: "pair_approval_requested",
    subject: { id: f.workflow.id },
  });

  const listed = await call(`${f.base}/pair-approvals?state=pending`, bert.headers);
  expect(listed.body.items).toMatchObject([{ id: requestId, viewer_can_approve: true }]);

  const self = await call(`${f.base}/pair-approvals/${requestId}/approve`, browserHeaders, "POST");
  expect(self.status).toBe(403);
  expect(self.body.code).toBe("pair_same_person");
  expect(await authoritiesOf(f.workflow.id)).toHaveLength(0);

  const second = await call(`${f.base}/pair-approvals/${requestId}/approve`, bert.headers, "POST");
  expect(second.status).toBe(201);
  expect(second.body).toMatchObject({
    pair_approval: {
      state: "approved",
      first_approver: { user_id: ctx.userId },
      second_approver: { user_id: bert.person.id },
    },
    authority: { state: "approved", effect_manifest_digest: f.body.expected_manifest_digest },
  });
  const [authority] = await authoritiesOf(f.workflow.id);
  expect(authority?.created_by).toBe(bert.person.id);

  const again = await call(`${f.base}/pair-approvals/${requestId}/approve`, bert.headers, "POST");
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("pair_request_closed");

  const decisions = await ctx.db
    .select({ action: auditLog.action, actor: auditLog.actor_id })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, f.workflow.id)));
  expect(decisions).toContainEqual({
    action: AuditAction.WORKFLOW_PAIR_APPROVAL_REQUESTED,
    actor: ctx.userId,
  });
  expect(decisions).toContainEqual({
    action: AuditAction.WORKFLOW_PAIR_APPROVAL_APPROVED,
    actor: bert.person.id,
  });
});

test("a request nobody approved in time expires and grants nothing", async () => {
  const f = await fixture();
  const first = await call(`${f.base}/pair-approvals`, browserHeaders, "POST", f.body);
  const requestId = String(first.body.id);
  expect(new Date(String(first.body.expires_at)).getTime()).toBeLessThanOrEqual(
    new Date(f.body.valid_until).getTime(),
  );
  await ctx.db
    .update(workflowAuthorityPairRequests)
    .set({ expires_at: new Date(Date.now() - 1_000) }) // allow-wall-clock: expiry against the database clock
    .where(eq(workflowAuthorityPairRequests.id, requestId));
  const listed = await call(`${f.base}/pair-approvals?state=expired`, bert.headers);
  expect(listed.body.items).toMatchObject([
    { id: requestId, state: "expired", viewer_can_approve: false },
  ]);
  const late = await call(`${f.base}/pair-approvals/${requestId}/approve`, bert.headers, "POST");
  expect(late.status).toBe(409);
  expect(late.body.code).toBe("pair_request_expired");
  const [row] = await ctx.db
    .select()
    .from(workflowAuthorityPairRequests)
    .where(eq(workflowAuthorityPairRequests.id, requestId));
  expect(row?.state).toBe("expired");
  expect(await authoritiesOf(f.workflow.id)).toHaveLength(0);
});

test("a workflow that changed after the first approval turns the request stale", async () => {
  const f = await fixture();
  const first = await call(`${f.base}/pair-approvals`, browserHeaders, "POST", f.body);
  const requestId = String(first.body.id);
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://changed.example.test/api" })
    .where(eq(connectors.id, f.connector.id));
  const late = await call(`${f.base}/pair-approvals/${requestId}/approve`, bert.headers, "POST");
  expect(late.status).toBe(409);
  expect(late.body.code).toBe("authority_manifest_changed");
  const [row] = await ctx.db
    .select()
    .from(workflowAuthorityPairRequests)
    .where(eq(workflowAuthorityPairRequests.id, requestId));
  expect(row).toMatchObject({ state: "stale", stale_reason: "manifest_changed" });
  expect(await authoritiesOf(f.workflow.id)).toHaveLength(0);
});

test("the requester withdraws, the second person declines", async () => {
  const f = await fixture();
  const one = await call(`${f.base}/pair-approvals`, browserHeaders, "POST", f.body);
  const notMine = await call(
    `${f.base}/pair-approvals/${one.body.id}/decline`,
    browserHeaders,
    "POST",
  );
  expect(notMine.body.code).toBe("pair_same_person");
  const withdrawn = await call(
    `${f.base}/pair-approvals/${one.body.id}/withdraw`,
    browserHeaders,
    "POST",
  );
  expect(withdrawn.body).toMatchObject({ state: "withdrawn" });

  const two = await call(`${f.base}/pair-approvals`, browserHeaders, "POST", f.body);
  const declined = await call(
    `${f.base}/pair-approvals/${two.body.id}/decline`,
    bert.headers,
    "POST",
  );
  expect(declined.body).toMatchObject({ state: "declined" });
  expect(await authoritiesOf(f.workflow.id)).toHaveLength(0);
});

test("back to single, one person approves again and a pair request is refused", async () => {
  const back = await call("/v1/workspace/approval-policy", browserHeaders, "PUT", {
    workflow_approvals: "single",
  });
  expect(back.body).toMatchObject({ workflow_approvals: "single" });
  const f = await fixture();
  const pair = await call(`${f.base}/pair-approvals`, browserHeaders, "POST", f.body);
  expect(pair.status).toBe(409);
  expect(pair.body.code).toBe("pair_not_required");
  const direct = await call(`${f.base}/execution-authorities`, browserHeaders, "POST", f.body);
  expect(direct.status).toBe(201);
});
