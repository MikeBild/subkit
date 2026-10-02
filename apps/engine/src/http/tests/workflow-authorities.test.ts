import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import {
  apiKeys,
  auditLog,
  connectors,
  patchCandidates,
  sessions,
  tenants,
  users,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createBoss, disposeBoss, EXECUTION_RUN_QUEUE } from "../../queue/index.ts";
import { createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let app: ReturnType<typeof createApp>;
let browserHeaders: Record<string, string>;
let counter = 0;
let remote: MockServer;
let boss: PgBoss;
beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_authorities");
  boss = await createBoss({ connectionString: ctx.testDb.url });
  app = createApp({ db: ctx.db, registry: buildDefaultRegistry(ctx.db), boss });
  remote = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
      absolute_expires_at: new Date(Date.now() + 60 * 60_000), // allow-wall-clock: live browser fixture
    })
    .returning();
  if (!session) throw new Error("missing browser session fixture");
  const payload = { tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: session.id };
  browserHeaders = {
    cookie: browserSessionCookie(await signBrowserSession(payload)),
    "x-subkit-csrf": await signBrowserCsrf(payload),
    "content-type": "application/json",
  };
});
afterAll(async () => {
  await remote.close();
  await disposeBoss(boss);
  await ctx.cleanup();
});

async function fixture(baseUrl = "https://example.test/api", repairable = false) {
  const slug = `authority-http-${++counter}`;
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: baseUrl,
    })
    .returning();
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenantId, slug, name: slug, lifecycle: "draft" })
    .returning();
  if (!workflow || !connector) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        steps: [
          {
            id: "send",
            ...(repairable ? { data_selector: "data.id" } : {}),
            kind: "request",
            connector_id: connector.id,
            method: "POST",
            path: "/messages",
            body: { recipient: "reviewed@example.test" },
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("missing version fixture");
  const base = `/v1/workflows/${workflow.id}`;
  const previewPath = `${base}/versions/${version.id}/authority-preview`;
  const preview = await app.request(previewPath, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as {
    digest: string;
    execution_shape: unknown;
    suggested_bounds: { valid_from: string; valid_until: string; max_runs: number };
  };
  expect(body.execution_shape).toMatchObject({
    requests: [{ step_id: "send", retry_policy_max_attempts: 5 }],
    iterations: [],
    run_limit_is_request_limit: false,
  });
  expect(JSON.stringify(body.execution_shape)).toContain("reviewed@example.test");
  return {
    workflow,
    version,
    base,
    previewPath,
    connector,
    body: {
      workflow_version_id: version.id,
      execution_environment: "dev",
      expected_manifest_digest: body.digest,
      ...body.suggested_bounds,
    },
  };
}

test("preview is readable to an agent but granting requires the human browser", async () => {
  const f = await fixture();
  expect(f.body.max_runs).toBe(1);
  expect(new Date(f.body.valid_until).getTime() - new Date(f.body.valid_from).getTime()).toBe(
    24 * 60 * 60_000,
  );
  const unauthenticated = await app.request(f.previewPath);
  expect(unauthenticated.status).toBe(401);
  const machine = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(f.body),
  });
  expect(machine.status).toBe(403);
  expect(await machine.json()).toMatchObject({ code: "human_session_required" });
});

test("browser grant, reload and revoke preserve the exact boundary", async () => {
  const f = await fixture();
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  const path = `${f.base}/execution-authorities/${authority.id}`;
  const reloaded = await app.request(path, { headers: browserHeaders });
  expect(reloaded.status).toBe(200);
  expect(await reloaded.json()).toMatchObject({
    id: authority.id,
    state: "approved",
    remaining_runs: 1,
    reserved_runs: 0,
    effect_manifest_digest: f.body.expected_manifest_digest,
    target_constraints: { targets: ["https://example.test/api/messages"] },
  });
  const revoked = await app.request(`${path}/revoke`, { method: "POST", headers: browserHeaders });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toMatchObject({ state: "revoked" });
  expect(await (await app.request(path, { headers: browserHeaders })).json()).toMatchObject({
    state: "revoked",
  });
});

test("missing CSRF and a changed reviewed connector are rejected", async () => {
  const f = await fixture();
  const noCsrf = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: { cookie: browserHeaders.cookie!, "content-type": "application/json" },
    body: JSON.stringify(f.body),
  });
  expect(noCsrf.status).toBe(403);
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://another.example.test/api" })
    .where(eq(connectors.id, f.connector.id));
  const stale = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "authority_manifest_changed" });
});

test("a later target change is visible as invalidated rather than approved", async () => {
  const f = await fixture();
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://another.example.test/api" })
    .where(eq(connectors.id, f.connector.id));
  const read = await app.request(`${f.base}/execution-authorities/${authority.id}`, {
    headers: browserHeaders,
  });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ state: "invalidated" });
});

test("the normal run API consumes a human grant and binds replay to the exact input", async () => {
  const f = await fixture(remote.baseUrl);
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ ...f.body, max_runs: 2 }),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  // Activation is separate from granting and is not performed by the run API.
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  let writes = 0;
  remote.setHandler((_, res) => {
    writes++;
    jsonResponse(res, 200, { ok: true });
  });
  const request = (input: object, key: string) =>
    app.request("/v1/executions", {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: "saved",
        workflow_id: f.workflow.id,
        execution_authority_id: authority.id,
        idempotency_key: key,
        input,
      }),
    });
  const first = await request({ value: 1 }, "authority-api-first");
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { execution_id: string };
  expect(firstBody).toMatchObject({ status: "succeeded" });
  const history = await app.request(`/v1/executions/${firstBody.execution_id}`, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(history.status).toBe(200);
  expect(await history.json()).toMatchObject({ execution_authority_id: authority.id });
  const replay = await request({ value: 1 }, "authority-api-first");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    execution_id: firstBody.execution_id,
    idempotent_replay: true,
  });
  const mismatch = await request({ value: 2 }, "authority-api-first");
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ code: "execution_boundary_mismatch" });
  expect((await request({ value: 2 }, "authority-api-second")).status).toBe(200);
  const exhausted = await request({ value: 3 }, "authority-api-third");
  expect(exhausted.status).toBe(409);
  expect(await exhausted.json()).toMatchObject({ code: "execution_authority_unavailable" });
  expect(writes).toBe(2);
});

test("an omitted authority id discovers the grant; exhaustion falls back to a held preparation", async () => {
  const f = await fixture(remote.baseUrl);
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ ...f.body, max_runs: 2 }),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  let writes = 0;
  remote.setHandler((_, res) => {
    writes++;
    jsonResponse(res, 200, { ok: true });
  });
  for (let index = 0; index < 3; index++) {
    const response = await app.request("/v1/executions", {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ source: "saved", workflow_id: f.workflow.id }),
    });
    expect(response.status).toBe(200);
    const run = (await response.json()) as { execution_id: string };
    const detail = await app.request(`/v1/executions/${run.execution_id}`, {
      headers: browserHeaders,
    });
    expect(await detail.json()).toMatchObject({
      hold_writes: index === 2,
      execution_authority_id: index === 2 ? null : authority.id,
    });
  }
  expect(writes).toBe(2);
});

test("granting later cannot upgrade an idempotent preparation into a live run", async () => {
  const f = await fixture(remote.baseUrl);
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  let writes = 0;
  remote.setHandler((_, res) => {
    writes++;
    jsonResponse(res, 200, { ok: true });
  });
  const run = (hold_writes?: boolean) =>
    app.request("/v1/executions", {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: "saved",
        workflow_id: f.workflow.id,
        idempotency_key: "preview-stays-preview",
        hold_writes,
      }),
    });
  const preview = await run();
  expect(preview.status).toBe(200);
  const prepared = (await preview.json()) as { execution_id: string };
  const grant = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(grant.status).toBe(201);
  const authority = (await grant.json()) as { id: string };
  const replay = await run();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    execution_id: prepared.execution_id,
    hold_writes: true,
    idempotent_replay: true,
  });
  const escalation = await run(false);
  expect(escalation.status).toBe(409);
  const current = await app.request(`${f.base}/execution-authorities/${authority.id}`, {
    headers: browserHeaders,
  });
  expect(await current.json()).toMatchObject({ reserved_runs: 0 });
  expect(writes).toBe(0);
});

test("queue failure retries the same reserved execution rather than spending another run", async () => {
  const f = await fixture(remote.baseUrl);
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  const request = (withKey: boolean) =>
    app.request("/v1/executions", {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: "saved",
        workflow_id: f.workflow.id,
        execution_authority_id: authority.id,
        async: true,
        ...(withKey ? { idempotency_key: "authority-queue-retry" } : {}),
        input: {},
      }),
    });
  expect((await request(false)).status).toBe(400);
  const failedSend = spyOn(boss, "send").mockRejectedValueOnce(
    new Error("fixture queue unavailable"),
  );
  let reservedExecution: string | undefined;
  try {
    expect((await request(true)).status).toBe(500);
    reservedExecution = (failedSend.mock.calls[0]?.[1] as { execution_id: string } | undefined)
      ?.execution_id;
  } finally {
    failedSend.mockRestore();
  }
  const retries = await Promise.all([request(true), request(true), request(true)]);
  const retried = retries[0]!;
  expect(retries.map((response) => response.status)).toEqual([202, 202, 202]);
  expect(retried.status).toBe(202);
  if (!reservedExecution) throw new Error("queue fixture did not receive the reserved execution");
  expect(await retried.json()).toMatchObject({
    execution_id: reservedExecution,
    status: "queued",
    idempotent_replay: true,
  });
  const jobs = await ctx.db.execute(
    sql`SELECT id FROM pgboss.job WHERE name = ${EXECUTION_RUN_QUEUE} AND data->>'execution_id' = ${reservedExecution}`,
  );
  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0]?.id).toBe(reservedExecution);
  const [stored] = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.id, authority.id));
  expect(stored?.reserved_runs).toBe(1);
});

test("revocation after queue failure prevents enqueueing the reserved retry", async () => {
  const f = await fixture();
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  const request = () =>
    app.request("/v1/executions", {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: "saved",
        workflow_id: f.workflow.id,
        execution_authority_id: authority.id,
        async: true,
        idempotency_key: "authority-queue-revoked",
        input: {},
      }),
    });
  const failedSend = spyOn(boss, "send").mockRejectedValueOnce(
    new Error("fixture queue unavailable"),
  );
  let executionId: string | undefined;
  try {
    expect((await request()).status).toBe(500);
    executionId = (failedSend.mock.calls[0]?.[1] as { execution_id: string } | undefined)
      ?.execution_id;
  } finally {
    failedSend.mockRestore();
  }
  expect(
    (
      await app.request(`${f.base}/execution-authorities/${authority.id}/revoke`, {
        method: "POST",
        headers: browserHeaders,
      })
    ).status,
  ).toBe(200);
  const retried = await request();
  expect(retried.status).toBe(409);
  expect(await retried.json()).toMatchObject({ code: "execution_authority_unavailable" });
  if (!executionId) throw new Error("missing reserved execution");
  const jobs = await ctx.db.execute(
    sql`SELECT id FROM pgboss.job WHERE name = ${EXECUTION_RUN_QUEUE} AND data->>'execution_id' = ${executionId}`,
  );
  expect(jobs.rows).toHaveLength(0);
  const [stored] = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.id, authority.id));
  expect(stored?.reserved_runs).toBe(1);
});

test("a grant does not let the run API activate a draft implicitly", async () => {
  const f = await fixture();
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  const run = await app.request("/v1/executions", {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      source: "saved",
      workflow_id: f.workflow.id,
      execution_authority_id: authority.id,
    }),
  });
  expect(run.status).toBe(409);
  expect(await run.json()).toMatchObject({ code: "workflow_version_not_active" });
  const [stored] = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.id, authority.id));
  expect(stored?.reserved_runs).toBe(0);
  const [workflow] = await ctx.db.select().from(workflows).where(eq(workflows.id, f.workflow.id));
  expect(workflow?.lifecycle).toBe("draft");
});

async function readOnlyKey(tenant_id = ctx.tenantId, user_id = ctx.userId) {
  const token = `wf_live_${String(++counter).padStart(4, "0")}_authority_history_reader`;
  await ctx.db.insert(apiKeys).values({
    tenant_id,
    user_id,
    prefix: token.slice(0, 12),
    token_sha256: createHash("sha256").update(token).digest("hex"),
    scopes: ["workflow:read"],
  });
  return { authorization: `Bearer ${token}` };
}

test("read-only authority history survives reload, paginates, and distinguishes approval from an active version", async () => {
  const f = await fixture();
  const ids: string[] = [];
  for (const max_runs of [1, 2, 3]) {
    const response = await app.request(`${f.base}/execution-authorities`, {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({ ...f.body, max_runs }),
    });
    expect(response.status).toBe(201);
    ids.push(((await response.json()) as { id: string }).id);
  }
  const headers = await readOnlyKey();
  const path = `${f.base}/execution-authorities`;
  expect((await app.request(path)).status).toBe(401);
  const first = await app.request(`${path}?limit=2`, { headers });
  expect(first.status).toBe(200);
  const page = (await first.json()) as { items: { id: string }[]; next_cursor: string };
  expect(page.items.map((item) => item.id)).toEqual([ids[2]!, ids[1]!]);
  expect(page.items[0]).toMatchObject({
    state: "approved",
    active_version: false,
    ready_for_new_run: false,
    reserved_runs: 0,
  });
  expect(page.next_cursor).toBe(ids[1]!);
  const next = await app.request(`${path}?limit=2&cursor=${page.next_cursor}`, { headers });
  expect(next.status).toBe(200);
  const nextPage = (await next.json()) as { items: { id: string }[]; next_cursor: string | null };
  expect(nextPage.items.map((item) => item.id)).toEqual([ids[0]!]);
  expect(nextPage.next_cursor).toBeNull();
  expect(await (await app.request(`${path}?environment=prod`, { headers })).json()).toMatchObject({
    items: [],
    next_cursor: null,
  });
  expect((await app.request(`${path}?limit=51`, { headers })).status).toBe(400);
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: f.version.id })
    .where(eq(workflows.id, f.workflow.id));
  const reloaded = await app.request(`${path}?limit=1`, { headers });
  expect(((await reloaded.json()) as { items: unknown[] }).items[0]).toMatchObject({
    id: ids[2],
    state: "approved",
    active_version: true,
    ready_for_new_run: true,
    reserved_runs: 0,
  });
  await ctx.db
    .update(connectors)
    .set({ base_url: "https://changed.example.test" })
    .where(eq(connectors.id, f.connector.id));
  const changed = await app.request(`${path}?limit=1`, { headers });
  expect(((await changed.json()) as { items: unknown[] }).items[0]).toMatchObject({
    state: "invalidated",
    ready_for_new_run: false,
    reserved_runs: 0,
  });
});

test("authority history rejects cross-workflow cursors and cross-tenant reads", async () => {
  const f = await fixture();
  const other = await fixture();
  const granted = await app.request(`${other.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(other.body),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  const headers = await readOnlyKey();
  expect(
    (await app.request(`${f.base}/execution-authorities?cursor=${authority.id}`, { headers }))
      .status,
  ).toBe(404);
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: `history-foreign-${++counter}`, display_name: "Foreign history fixture" })
    .returning();
  if (!tenant) throw new Error("missing foreign tenant fixture");
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id: tenant.id, email: "history@example.test", role: "admin" })
    .returning();
  if (!user) throw new Error("missing foreign user fixture");
  const foreignHeaders = await readOnlyKey(tenant.id, user.id);
  expect(
    (await app.request(`${f.base}/execution-authorities`, { headers: foreignHeaders })).status,
  ).toBe(404);
  expect(
    (
      await app.request(`${other.base}/execution-authorities/${authority.id}`, {
        headers: foreignHeaders,
      })
    ).status,
  ).toBe(404);
});

test("history cursors preserve PostgreSQL microseconds and same-timestamp id ordering", async () => {
  const f = await fixture();
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  const [original] = await ctx.db
    .select()
    .from(workflowExecutionAuthorities)
    .where(eq(workflowExecutionAuthorities.id, authority.id));
  if (!original) throw new Error("missing history fixture authority");
  const ids = [
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000001",
  ];
  // History-only fixtures share a timestamp with precision beyond a JS Date.
  // Grant/session proof is exercised above; no fixture execution is admitted.
  for (const id of ids)
    await ctx.db.insert(workflowExecutionAuthorities).values({
      ...original,
      id,
      created_at: sql`TIMESTAMPTZ '2026-01-01 00:00:00.123456+00'`,
    });
  const headers = await readOnlyKey();
  let cursor = authority.id;
  for (const [index, id] of ids.entries()) {
    const response = await app.request(`${f.base}/execution-authorities?limit=1&cursor=${cursor}`, {
      headers,
    });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(page.items.map((item) => item.id)).toEqual([id]);
    expect(page.next_cursor).toBe(index === ids.length - 1 ? null : id);
    cursor = id;
  }
});

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
            // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow expression
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
  // No supplied input means the MIME recipient cannot be prepared; this must
  // never turn a held or failed preparation into an execution grant.
  const prepared = await app.request(preparePath, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ environment: "dev" }),
  });
  expect(prepared.status).toBe(200);
  // The answer says which of the two happened. It used to be a flat
  // `prepared: true` either way: five production workflows were "prepared",
  // not one of them produced a run, and the derivation that depends on those
  // runs then reported their steps as never executed.
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

// A caller who reads schedules does not thereby read the workflow's hooks, and
// a refusal's reason is audit-log content. Each narrower reader sees exactly
// what its permissions already cover elsewhere.
test("automation-status shows hooks and refusal reasons only to readers of each", async () => {
  const slug = `authority-hooks-${++counter}`;
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
  await ctx.db.insert(auditLog).values([
    refusal(
      "00000000-0000-4000-8000-00000000a001",
      active.id,
      "1 hour",
      "execution_authority_required",
    ),
    // Outside the lookback: the newest refusal the view reports is bounded.
    refusal("00000000-0000-4000-8000-00000000a002", inactive.id, "40 days", "signature_mismatch"),
  ]);

  const reader = async (name: string, permissions: string[]) => {
    const role = await createRole(ctx.db, ctx.tenantId, `${slug}-${name}`);
    for (const permission of permissions)
      await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, permission);
    const [user] = await ctx.db
      .insert(users)
      .values({ tenant_id: ctx.tenantId, email: `${slug}-${name}@test.local`, role: "member" })
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
  // A deactivated hook receives nothing, so it holds nothing.
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
  await ctx.db.insert(auditLog).values([
    refusal("00000000-0000-4000-8000-00000000b001", "1 hour", "execution_authority_required"),
    refusal("00000000-0000-4000-8000-00000000b002", "2 days", "execution_authority_unavailable"),
    // Not a call an approval would cover: never authentic, or too long ago.
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
  // The bounds stay exactly what a grant accepts; the explanation sits beside them.
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
  // Hooks deliver to production only: a development review keeps one run.
  const dev = await bounds("dev");
  expect(dev.suggested_bounds.max_runs).toBe(1);
  expect(dev.suggested_bounds_basis).toEqual({ kind: "manual" });
});
