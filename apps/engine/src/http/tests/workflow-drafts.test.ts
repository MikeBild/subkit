import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, workflowsSchedules } from "../../db/schema/index.ts";
import { WorkflowDraftSchema } from "../../workflows/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
const readKey = "wf_live_draft_read_only_test_key_00001";
beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_drafts");
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    prefix: readKey.slice(0, 12),
    token_sha256: createHash("sha256").update(readKey).digest("hex"),
    scopes: ["workflow:read"],
  });
});
afterAll(async () => {
  await ctx.cleanup();
});

function headers(key = ctx.apiKey) {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}
function definition(name: string, expression = "return 1;") {
  return {
    name,
    slug: name,
    trigger: { kind: "schedule", cron: "0 8 * * *" },
    steps: [{ kind: "transform", id: "result", expression }],
  };
}

test("draft create, reload and optimistic update never arm a schedule", async () => {
  const created = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ definition: definition("api-draft") }),
  });
  expect(created.status).toBe(201);
  const first = WorkflowDraftSchema.parse(await created.json());
  expect(first.current_version_id).toBeNull();
  const url = `${ctx.baseUrl}/v1/workflows/${first.workflow_id}/draft`;
  const read = await fetch(url, { headers: headers(readKey) });
  expect(read.status).toBe(200);
  expect(WorkflowDraftSchema.parse(await read.json())).toEqual(first);
  const body = {
    definition: definition("api-draft", "return 2;"),
    expected_draft_version_id: first.version_id,
  };
  const updated = await fetch(url, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  expect(updated.status).toBe(200);
  const second = WorkflowDraftSchema.parse(await updated.json());
  expect(second.version).toBe(2);
  expect(second.digest).not.toBe(first.digest);
  const stale = await fetch(url, { method: "PUT", headers: headers(), body: JSON.stringify(body) });
  expect(stale.status).toBe(409);
  expect(
    await ctx.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.tenant_id, ctx.tenantId)),
  ).toHaveLength(0);
  const events = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, first.workflow_id)));
  const writes = events.filter(
    (event) => (event.metadata as Record<string, unknown>).kind === "draft",
  );
  expect(writes).toHaveLength(2);
  expect(writes[0]?.actor_id).toBe(ctx.userId);
  expect(writes[0]?.metadata).toMatchObject({ request_source: "api" });
});

test("draft routes require authentication, write permission and valid definitions", async () => {
  const url = `${ctx.baseUrl}/v1/workflows/drafts`;
  const body = JSON.stringify({ definition: definition("denied-draft") });
  expect(
    (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }))
      .status,
  ).toBe(401);
  expect((await fetch(url, { method: "POST", headers: headers(readKey), body })).status).toBe(403);
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ definition: { name: "invalid", steps: [{ kind: "unknown" }] } }),
      })
    ).status,
  ).toBe(400);
  const created = await fetch(url, { method: "POST", headers: headers(), body });
  expect(created.status).toBe(201);
  const draft = WorkflowDraftSchema.parse(await created.json());
  const updateUrl = `${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/draft`;
  const updateBody = JSON.stringify({
    definition: definition("denied-draft"),
    expected_draft_version_id: draft.version_id,
  });
  expect(
    (await fetch(updateUrl, { method: "PUT", headers: headers(readKey), body: updateBody })).status,
  ).toBe(403);
  expect((await fetch(updateUrl, { method: "PUT", headers: headers(), body })).status).toBe(400);
});

test("the derived limits reach every surface through one endpoint, and change nothing on their own", async () => {
  const created = await fetch(`${ctx.baseUrl}/v1/workflows/drafts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      definition: {
        name: "derive-limits",
        slug: "derive-limits",
        steps: [
          {
            kind: "request",
            id: "read_page",
            url: "https://api.example.test/v1/pages/${input.page_id}",
            method: "GET",
          },
        ],
      },
    }),
  });
  expect(created.status).toBe(201);
  const draft = (await created.json()) as { workflow_id: string; version_id: string };

  const empty = await fetch(`${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/boundary-proposals`, {
    headers: headers(),
  });
  expect(empty.status).toBe(200);
  const nothing = (await empty.json()) as {
    proposals: unknown[];
    unproposable: Array<{ step_id: string; reason: string }>;
  };
  expect(nothing.proposals).toEqual([]);
  expect(nothing.unproposable).toEqual([{ step_id: "read_page", reason: "no_history" }]);

  const refused = await fetch(
    `${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/boundary-proposals/apply`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ expected_draft_version_id: draft.version_id }),
    },
  );
  expect(refused.status).toBe(400);

  const readOnly = await fetch(
    `${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/boundary-proposals`,
    { headers: headers(readKey) },
  );
  expect(readOnly.status).toBe(200);
  const denied = await fetch(
    `${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/boundary-proposals/apply`,
    {
      method: "POST",
      headers: headers(readKey),
      body: JSON.stringify({ expected_draft_version_id: draft.version_id }),
    },
  );
  expect(denied.status).toBe(403);

  const after = await fetch(`${ctx.baseUrl}/v1/workflows/${draft.workflow_id}/draft`, {
    headers: headers(),
  });
  expect(((await after.json()) as { version_id: string }).version_id).toBe(draft.version_id);
});
