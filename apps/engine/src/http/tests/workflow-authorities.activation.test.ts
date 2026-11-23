import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  apiKeys,
  auditLog,
  conversations,
  executions,
  patchCandidates,
  users,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import {
  app,
  browserHeaders,
  ctx,
  fixture,
  nextCounter,
  pendingLiveTest,
  setupWorkflowAuthorities,
} from "./workflow-authorities-fixtures.ts";

setupWorkflowAuthorities();

test("repair review and finite authority apply atomically and remain settled after reload", async () => {
  const f = await fixture(undefined, true);
  await ctx.db
    .update(workflows)
    .set({ current_version_id: f.version.id, lifecycle: "active" })
    .where(eq(workflows.id, f.workflow.id));
  const [candidate] = await ctx.db
    .insert(patchCandidates)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: f.workflow.id,
      classification: "safe",
      status: "proposed",
      diff: {
        workflow_step_id: "send",
        proposal: {
          kind: "update_field_path",
          classification: "safe",
          description: "Read moved identifier",
          reasoning: "Response field moved",
          patch: { path: "data.id", value: "data.result.id" },
        },
      },
    })
    .returning();
  if (!candidate) throw new Error("missing candidate");
  const beforeOverview = await app.request("/v1/operational-overview", { headers: browserHeaders });
  expect(beforeOverview.status).toBe(200);
  expect((await beforeOverview.json()).core.other_decisions.value).toBe(1);
  const base = `/v1/patch-candidates/${candidate.id}`;
  const getPreview = await app.request(`${base}/preview`, { headers: browserHeaders });
  expect(getPreview.status).toBe(200);
  const preview = await getPreview.json();
  expect(preview.reviewable).toBe(true);
  const invalid = await app.request(`${base}/approve`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({}),
  });
  expect(invalid.status).toBe(400);
  const preparedResponse = await app.request(`${base}/prepare`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ expected_review_digest: preview.review_digest }),
  });
  expect(preparedResponse.status).toBe(200);
  const prepared = await preparedResponse.json();
  const authorityResponse = await app.request(
    `${f.base}/versions/${prepared.workflow_version_id}/authority-preview`,
    { headers: browserHeaders },
  );
  expect(authorityResponse.status).toBe(200);
  const authority = await authorityResponse.json();
  const body = {
    expected_review_digest: preview.review_digest,
    execution_authority: {
      workflow_version_id: prepared.workflow_version_id,
      execution_environment: "dev",
      expected_manifest_digest: authority.digest,
      ...authority.suggested_bounds,
    },
  };
  const denied = await app.request(`${base}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(denied.status).toBe(403);
  const [stillOriginal] = await ctx.db
    .select()
    .from(workflows)
    .where(eq(workflows.id, f.workflow.id));
  expect(stillOriginal?.current_version_id).toBe(f.version.id);
  const approved = await app.request(`${base}/approve`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(body),
  });
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({
    applied: true,
    workflow_version_id: prepared.workflow_version_id,
  });
  const reload = await app.request(
    `/v1/patch-candidates?status=proposed&workflow_id=${f.workflow.id}`,
    { headers: browserHeaders },
  );
  expect(await reload.json()).toMatchObject({ total: 0, reviewable_total: 0, items: [] });
  const afterOverview = await app.request("/v1/operational-overview", { headers: browserHeaders });
  expect((await afterOverview.json()).core.other_decisions.value).toBe(0);
  const grants = await app.request(`${f.base}/execution-authorities`, { headers: browserHeaders });
  const loaded = await grants.json();
  expect(loaded.items).toHaveLength(1);
  expect(loaded.items[0]).toMatchObject({
    workflow_version_id: prepared.workflow_version_id,
    state: "approved",
    active_version: true,
  });
  const retry = await app.request(`${base}/approve`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(body),
  });
  expect(retry.status).toBe(409);
});

test("chat activation is browser-bound, rejects stale review, and never dispatches or grants", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  const body = {
    workflow_version_id: f.version.id,
    expected_current_version_id: null,
    expected_manifest_digest: f.body.expected_manifest_digest,
    execution_environment: "dev",
  };
  const send = (headers: Record<string, string>, payload = body) =>
    app.request(`${f.base}/activate-draft`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  expect(
    (await send({ authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" }))
      .status,
  ).toBe(403);
  const noCsrf = { ...browserHeaders };
  delete noCsrf["x-subkit-csrf"];
  expect((await send(noCsrf)).status).toBe(403);
  expect(
    (await send(browserHeaders, { ...body, expected_manifest_digest: "0".repeat(64) })).status,
  ).toBe(409);
  const response = await send(browserHeaders);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ activated: true, execution_authorized: false });
  expect((await send(browserHeaders)).status).toBe(200);
  const [row] = await ctx.db.select().from(workflows).where(eq(workflows.id, f.workflow.id));
  expect(row).toMatchObject({ current_version_id: f.version.id, draft_version_id: null });
  expect(
    await ctx.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.workflow_id, f.workflow.id)),
  ).toHaveLength(0);
});

test("prod activation never continues a pending conversation live test", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ draft_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  const input = {};
  const [conversation] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenantId,
      owner_id: ctx.userId,
      status: "active",
      draft: {
        workflow: { name: "Pending test", steps: [] },
        session: {
          live_test: {
            workflow_id: f.workflow.id,
            workflow_version_id: f.version.id,
            environment: "dev",
            input,
            input_digest: workflowJsonDigest(input),
            idempotency_key: `pending:${f.workflow.id}`,
            state: "pending",
          },
        },
      },
    })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  const preview = await app.request(`${f.previewPath}?environment=prod`, {
    headers: browserHeaders,
  });
  expect(preview.status).toBe(200);
  const reviewed = await preview.json();
  const response = await app.request(`${f.base}/activate-draft`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      workflow_version_id: f.version.id,
      expected_current_version_id: null,
      expected_manifest_digest: reviewed.digest,
      execution_environment: "prod",
      conversation_id: conversation.id,
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    activated: true,
    live_test: { state: "not_requested" },
  });
  expect(
    await ctx.db.select().from(executions).where(eq(executions.workflow_id, f.workflow.id)),
  ).toHaveLength(0);
});

test("approving in a dev chat starts no run unless a run is requested", async () => {
  for (const start_run of [undefined, false]) {
    const activated = await fixture();
    const activation = await pendingLiveTest(activated);
    const response = await app.request(`${activated.base}/activate-draft`, {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        workflow_version_id: activated.version.id,
        expected_current_version_id: null,
        expected_manifest_digest: activated.body.expected_manifest_digest,
        execution_environment: "dev",
        conversation_id: activation.conversation_id,
        ...(start_run === undefined ? {} : { start_run }),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ live_test: { state: "not_requested" } });
    expect(await activation.runs()).toBe(0);
    const granted = await fixture();
    const grant = await pendingLiveTest(granted);
    const authority = await app.request(`${granted.base}/execution-authorities`, {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        ...granted.body,
        activation: { expected_current_version_id: null },
        conversation_id: grant.conversation_id,
        ...(start_run === undefined ? {} : { start_run }),
      }),
    });
    expect(authority.status).toBe(201);
    expect(await authority.json()).toMatchObject({ live_test: { state: "not_requested" } });
    expect(await grant.runs()).toBe(0);
  }
});

test("an explicit run request after approval queues exactly one run", async () => {
  const granted = await fixture();
  const grant = await pendingLiveTest(granted);
  const authority = await app.request(`${granted.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      ...granted.body,
      activation: { expected_current_version_id: null },
      conversation_id: grant.conversation_id,
      start_run: true,
    }),
  });
  expect(authority.status).toBe(201);
  expect(await authority.json()).toMatchObject({ live_test: { state: "queued" } });
  expect(await grant.runs()).toBe(1);
  const activated = await fixture();
  const activation = await pendingLiveTest(activated);
  const response = await app.request(`${activated.base}/activate-draft`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      workflow_version_id: activated.version.id,
      expected_current_version_id: null,
      expected_manifest_digest: activated.body.expected_manifest_digest,
      execution_environment: "dev",
      conversation_id: activation.conversation_id,
      start_run: true,
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ live_test: { state: "blocked" } });
  expect(await activation.runs()).toBe(0);
});

test("held report preparation works for a saved draft and cannot grant, activate or send", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Report",
        steps: [
          {
            id: "send",
            kind: "request",
            method: "POST",
            url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            body: { raw: "${input.raw}" },
            max_retries: 0,
          },
        ],
      },
    })
    .where(eq(workflowVersions.id, f.version.id));
  const preparePath = `${f.base}/versions/${f.version.id}/prepare-authority`;
  expect(
    (
      await app.request(preparePath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: "dev" }),
      })
    ).status,
  ).toBe(401);
  const prepared = await app.request(preparePath, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ environment: "dev" }),
  });
  expect(prepared.status).toBe(200);
  const preparedBody = (await prepared.json()) as { prepared: boolean; reason?: string };
  expect(typeof preparedBody.prepared).toBe("boolean");
  if (!preparedBody.prepared) expect(typeof preparedBody.reason).toBe("string");
  const preview = await app.request(f.previewPath, { headers: browserHeaders });
  expect(await preview.json()).toMatchObject({ eligible_for_repeated_runs: false });
  const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, f.workflow.id));
  expect(workflow?.lifecycle).toBe("draft");
  const authorities = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.workflow_id, f.workflow.id));
  expect(authorities).toHaveLength(0);
  expect((await app.request(`${f.base}/automation-status`)).status).toBe(401);
  const status = await app.request(`${f.base}/automation-status`, { headers: browserHeaders });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ schedules: [], inbound_hooks: [] });
});

test("automation-status shows hooks and refusal reasons only to readers of each", async () => {
  const slug = `authority-hooks-${nextCounter()}`;
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenantId, slug, name: slug, lifecycle: "draft" })
    .returning();
  if (!workflow) throw new Error("missing workflow fixture");
  const hold = {
    reason_code: "execution_authority_required" as const,
    observed_at: "2026-01-01T00:00:00.000Z",
  };
  const secret = {
    verifier: "standard",
    secret_ciphertext: Buffer.alloc(1),
    secret_iv: Buffer.alloc(1),
    secret_auth_tag: Buffer.alloc(1),
  };
  const [active, inactive] = await ctx.db
    .insert(webhooksInbound)
    .values([
      {
        tenant_id: ctx.tenantId,
        workflow_id: workflow.id,
        slug: `${slug}-a`,
        ...secret,
        admission_hold: hold,
      },
      {
        tenant_id: ctx.tenantId,
        workflow_id: workflow.id,
        slug: `${slug}-b`,
        ...secret,
        active: false,
        admission_hold: hold,
      },
    ])
    .returning();
  if (!active || !inactive) throw new Error("missing hook fixture");
  const refusal = (id: string, resource_id: string, age: string, reason: string) => ({
    id,
    ts: sql`clock_timestamp() - ${age}::interval`,
    tenant_id: ctx.tenantId,
    actor_type: "system",
    action: "webhook.inbound.denied",
    resource_type: "webhook_inbound",
    resource_id,
    result: "denied",
    reason,
  });
  await ctx.db
    .insert(auditLog)
    .values([
      refusal(
        "00000000-0000-4000-8000-00000000a001",
        active.id,
        "1 hour",
        "execution_authority_required",
      ),
      refusal("00000000-0000-4000-8000-00000000a002", inactive.id, "40 days", "signature_mismatch"),
    ]);

  const reader = async (name: string, permissions: string[]) => {
    const role = await createRole(ctx.db, ctx.tenantId, `${slug}-${name}`);
    for (const permission of permissions)
      await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, permission);
    const [user] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: `${slug}-${name}@test.local`,
        role_id: await builtinRoleId(ctx.db, "member"),
      })
      .returning();
    if (!user) throw new Error("missing user fixture");
    await ctx.db.update(users).set({ role_id: role.id }).where(eq(users.id, user.id));
    const key = `wf_live_${name}_${slug.replaceAll("-", "_")}`;
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      prefix: key.slice(0, 12),
      token_sha256: createHash("sha256").update(key).digest("hex"),
      scopes: ["*"],
    });
    return key;
  };
  const status = async (key: string) => {
    const res = await app.request(`/v1/workflows/${workflow.id}/automation-status`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        inbound_hooks: Array<{
          slug: string;
          admission_hold: unknown;
          last_refused_at: string | null;
          last_refused_reason: string | null;
        }>;
      }
    ).inbound_hooks;
  };
  const base = ["workflow:read", "schedule:read"];

  expect(await status(await reader("schedules", base))).toEqual([]);

  const hooksOnly = await status(await reader("hooks", [...base, "inbound_hook:read"]));
  expect(hooksOnly.map((hook) => hook.slug)).toEqual([`${slug}-a`, `${slug}-b`]);
  expect(hooksOnly[0]?.last_refused_at).not.toBeNull();
  expect(hooksOnly.map((hook) => hook.last_refused_reason)).toEqual([null, null]);

  const full = await status(await reader("audit", [...base, "inbound_hook:read", "audit:read"]));
  expect(full.map((hook) => hook.last_refused_reason)).toEqual([
    "execution_authority_required",
    null,
  ]);
  expect(full[1]?.last_refused_at).toBeNull();
  expect(full.map((hook) => hook.admission_hold)).toEqual([hold, null]);
});

test("a hook-started workflow is offered thirty days sized from its recent deliveries", async () => {
  const f = await fixture();
  const [hook] = await ctx.db
    .insert(webhooksInbound)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: f.workflow.id,
      slug: `${f.workflow.slug}-hook`,
      verifier: "standard",
      secret_ciphertext: Buffer.alloc(1),
      secret_iv: Buffer.alloc(1),
      secret_auth_tag: Buffer.alloc(1),
    })
    .returning();
  if (!hook) throw new Error("missing hook fixture");
  const refusal = (id: string, age: string, reason: string) => ({
    id,
    ts: sql`clock_timestamp() - ${age}::interval`,
    tenant_id: ctx.tenantId,
    actor_type: "system",
    action: "webhook.inbound.denied",
    resource_type: "webhook_inbound",
    resource_id: hook.id,
    result: "denied",
    reason,
  });
  await ctx.db
    .insert(auditLog)
    .values([
      refusal("00000000-0000-4000-8000-00000000b001", "1 hour", "execution_authority_required"),
      refusal("00000000-0000-4000-8000-00000000b002", "2 days", "execution_authority_expired"),
      refusal("00000000-0000-4000-8000-00000000b003", "3 hours", "signature_mismatch"),
      refusal("00000000-0000-4000-8000-00000000b004", "40 days", "execution_authority_required"),
    ]);
  const bounds = async (environment: "dev" | "prod") => {
    const res = await app.request(`${f.previewPath}?environment=${environment}`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      suggested_bounds: { valid_from: string; valid_until: string; max_runs: number };
      suggested_bounds_basis: Record<string, unknown>;
    };
  };
  const prod = await bounds("prod");
  expect(
    Date.parse(prod.suggested_bounds.valid_until) - Date.parse(prod.suggested_bounds.valid_from),
  ).toBe(30 * 24 * 60 * 60_000);
  expect(prod.suggested_bounds.max_runs).toBe(100);
  expect(Object.keys(prod.suggested_bounds).sort()).toEqual([
    "max_runs",
    "valid_from",
    "valid_until",
  ]);
  expect(prod.suggested_bounds_basis).toEqual({
    kind: "hook",
    scheduled_runs: 0,
    observed_deliveries: 2,
    observed_days: 14,
    minimum_applied: true,
  });
  const dev = await bounds("dev");
  expect(dev.suggested_bounds.max_runs).toBe(1);
  expect(dev.suggested_bounds_basis).toEqual({ kind: "manual" });
});
