import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import {
  connectors,
  sessions,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let app: ReturnType<typeof createApp>;
let browserHeaders: Record<string, string>;
let counter = 0;
let remote: MockServer;
let queueFails = false;
const queuedExecutions: string[] = [];
beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_authorities");
  const boss = {
    send: async (_queue: string, job: { execution_id: string }) => {
      queuedExecutions.push(job.execution_id);
      if (queueFails) throw new Error("fixture queue unavailable");
      return "fixture-job";
    },
  } as unknown as PgBoss;
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
  await ctx.cleanup();
});

async function fixture(baseUrl = "https://example.test/api") {
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
    suggested_bounds: { valid_from: string; valid_until: string; max_runs: number };
  };
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
  const before = queuedExecutions.length;
  queueFails = true;
  try {
    expect((await request(true)).status).toBe(500);
  } finally {
    queueFails = false;
  }
  const retried = await request(true);
  expect(retried.status).toBe(202);
  const reservedExecution = queuedExecutions[before];
  if (!reservedExecution) throw new Error("queue fixture did not receive the reserved execution");
  expect(await retried.json()).toMatchObject({
    execution_id: reservedExecution,
    status: "queued",
    idempotent_replay: true,
  });
  expect(queuedExecutions.slice(before)).toEqual([reservedExecution, reservedExecution]);
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
