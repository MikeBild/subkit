import { expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  connectors,
  users,
  workflowExecutionAuthorities,
  workflows,
} from "../../db/schema/index.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  app,
  boss,
  browserHeaders,
  ctx,
  fixture,
  nextCounter,
  readOnlyKey,
  setupWorkflowAuthorities,
} from "./workflow-authorities-fixtures.ts";

setupWorkflowAuthorities();

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
  const tenant = await seedTenant(ctx.db, {
    slug: `history-foreign-${nextCounter()}`,
    display_name: "Foreign history fixture",
  });
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: "history@example.test",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
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
