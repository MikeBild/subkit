import { expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  connectors,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/index.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { jsonResponse } from "../../test-helpers/mock-http.ts";
import {
  app,
  boss,
  browserHeaders,
  ctx,
  fixture,
  remote,
  setupWorkflowAuthorities,
} from "./workflow-authorities-fixtures.ts";

setupWorkflowAuthorities();

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

test("a browser makes a time-limited approval apply until revoked; an agent cannot", async () => {
  const f = await fixture();
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(granted.status).toBe(201);
  const authority = (await granted.json()) as { id: string };
  const path = `${f.base}/execution-authorities/${authority.id}`;
  const body = JSON.stringify({ expected_manifest_digest: f.body.expected_manifest_digest });
  const machine = await app.request(`${path}/until-revoked`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body,
  });
  expect(machine.status).toBe(403);
  expect(await machine.json()).toMatchObject({ code: "human_session_required" });
  const replaced = await app.request(`${path}/until-revoked`, {
    method: "POST",
    headers: browserHeaders,
    body,
  });
  expect(replaced.status).toBe(200);
  const successor = (await replaced.json()) as { id: string };
  expect(successor).toMatchObject({
    state: "approved",
    valid_until: null,
    max_runs: null,
    open_ended: true,
    effect_manifest_digest: f.body.expected_manifest_digest,
    target_constraints: { targets: ["https://example.test/api/messages"] },
  });
  expect(successor.id).not.toBe(authority.id);
  expect(await (await app.request(path, { headers: browserHeaders })).json()).toMatchObject({
    state: "superseded",
    superseded_by: successor.id,
  });
});

test("an approval until revoked reads as open-ended; the next preview names no growth", async () => {
  const f = await fixture();
  const { valid_until: _until, max_runs: _runs, ...openEnded } = f.body;
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({ ...openEnded, valid_until: null, max_runs: null }),
  });
  expect(granted.status).toBe(201);
  expect(await granted.json()).toMatchObject({
    state: "approved",
    open_ended: true,
    valid_until: null,
    max_runs: null,
    remaining_runs: null,
    inherited_from: null,
    superseded_by: null,
  });
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: (
        await ctx.db
          .select({ dag: workflowVersions.dag })
          .from(workflowVersions)
          .where(eq(workflowVersions.id, f.version.id))
      )[0]?.dag as Record<string, unknown>,
    })
    .returning();
  if (!next) throw new Error("missing second version");
  const own = await app.request(f.previewPath, { headers: browserHeaders });
  expect(((await own.json()) as { boundary_growth?: unknown }).boundary_growth).toBeUndefined();
  const preview = await app.request(`${f.base}/versions/${next.id}/authority-preview`, {
    headers: browserHeaders,
  });
  expect(await preview.json()).toMatchObject({ boundary_growth: [] });
  await ctx.db
    .update(workflows)
    .set({ current_version_id: f.version.id, lifecycle: "active" })
    .where(eq(workflows.id, f.workflow.id));
  const again = await app.request(`${f.base}/versions/${next.id}/authority-preview`, {
    headers: browserHeaders,
  });
  expect(await again.json()).toMatchObject({ boundary_growth: [], approval_carries_over: true });
});

test("the preview compares each effect with the approved version", async () => {
  const f = await fixture();
  const granted = await app.request(`${f.base}/execution-authorities`, {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify(f.body),
  });
  expect(granted.status).toBe(201);
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: {
        name: f.workflow.slug,
        steps: [
          {
            id: "send",
            kind: "request",
            connector_id: f.connector.id,
            method: "POST",
            path: "/messages/urgent",
            body: { recipient: "reviewed@example.test" },
          },
          {
            id: "fetch",
            kind: "request",
            connector_id: f.connector.id,
            method: "GET",
            path: "/status",
          },
        ],
      },
    })
    .returning();
  if (!next) throw new Error("missing second version");
  const preview = await app.request(`${f.base}/versions/${next.id}/authority-preview`, {
    headers: browserHeaders,
  });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as {
    effect_changes?: Array<{ step_id: string; change: string; effect: string }>;
    effect_changes_base?: { workflow_version_id: string; version: number; approved: boolean };
  };
  expect(
    body.effect_changes?.map(({ step_id, change, effect }) => [step_id, change, effect]),
  ).toEqual([
    ["send", "widened", "write"],
    ["fetch", "added", "read"],
  ]);
  expect(body.effect_changes_base).toEqual({
    workflow_version_id: f.version.id,
    version: 1,
    approved: true,
  });
  const own = (await (await app.request(f.previewPath, { headers: browserHeaders })).json()) as {
    effect_changes?: unknown;
  };
  expect(own.effect_changes).toBeUndefined();
});

test("a running version that was never approved is no approved baseline", async () => {
  const f = await fixture();
  await ctx.db
    .update(workflows)
    .set({ current_version_id: f.version.id, lifecycle: "active" })
    .where(eq(workflows.id, f.workflow.id));
  const [next] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.workflow.tenant_id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: (
        await ctx.db
          .select({ dag: workflowVersions.dag })
          .from(workflowVersions)
          .where(eq(workflowVersions.id, f.version.id))
      )[0]?.dag as Record<string, unknown>,
    })
    .returning();
  if (!next) throw new Error("missing second version");
  const preview = await app.request(`${f.base}/versions/${next.id}/authority-preview`, {
    headers: browserHeaders,
  });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as {
    boundary_growth?: unknown;
    effect_changes?: Array<{ change: string }>;
    effect_changes_base?: { workflow_version_id: string; version: number; approved: boolean };
  };
  expect(body.boundary_growth).toBeUndefined();
  expect(body.effect_changes?.every((entry) => entry.change === "unchanged")).toBe(true);
  expect(body.effect_changes_base).toEqual({
    workflow_version_id: f.version.id,
    version: 1,
    approved: false,
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
  const retryAfterCatalogConflict = async () => {
    let response = await request(true);
    const busy = async () =>
      response.status === 409 &&
      ((await response.clone().json()) as { code?: string }).code === "catalog_vocabulary_changed";
    await waitFor(
      async () => {
        if (!(await busy())) return true;
        response = await request(true);
        return !(await busy());
      },
      { tries: 100, sleepMs: 5, label: "queue retry after catalog conflict" },
    );
    return response;
  };
  const retries = await Promise.all([
    retryAfterCatalogConflict(),
    retryAfterCatalogConflict(),
    retryAfterCatalogConflict(),
  ]);
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
